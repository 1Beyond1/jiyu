import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { token } from './security.ts'
import { fileExtension } from '../src/lib/collections.ts'
import { materialProgress } from '../src/lib/materials.ts'
import type {
  Workspace,
  Collection,
  CollectedFile,
  FileSortOption,
  PaginatedFiles,
} from '../src/types.ts'
import { cloudStorageIds } from '../src/types.ts'

export const SCHEMA_VERSION = 6

export interface FileQueryOptions {
  collectionId?: string
  status?: 'all' | 'ready' | 'pending'
  trashed?: 'false' | 'true' | 'all'
  kind?: 'all' | 'image'
  q?: string
  page: number
  pageSize: number
  sort: FileSortOption
}

export interface WorkspaceOptions {
  mode?: 'full' | 'summary'
  recentLimit?: number
}

const IMAGE_EXTENSIONS_SQL = "'jpg','jpeg','png','heic','svg','webp','gif'"

// Removed providers fall back to the immutable local copy; keep stored history intact.
function normalizeStorage<T extends { storage: string }>(record: T): T {
  return record.storage === 'local' || cloudStorageIds.some((id) => id === record.storage)
    ? record
    : { ...record, storage: 'local' }
}

function normalizeIso(value: string | undefined): string {
  if (!value) return ''
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}

function fileColumns(file: CollectedFile) {
  return {
    deleted_at: file.deletedAt ? normalizeIso(file.deletedAt) : null,
    status: file.status === 'ready' ? 'ready' : 'pending',
    created_at: normalizeIso(file.createdAt),
    size: Number.isFinite(file.size) ? Math.trunc(file.size) : 0,
    name: file.name || '',
    ext: fileExtension(file.name || ''),
    owner: file.owner || '',
    participant: file.participant || '',
    submission_id: file.submissionId || null,
  }
}

export class Store {
  db: DatabaseSync
  lock: DatabaseSync
  dataDir: string
  readonly instanceId = randomUUID()
  constructor(dataDir: string) {
    this.dataDir = dataDir
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.lock = new DatabaseSync(join(dataDir, 'service-lock.sqlite'))
    try {
      this.lock.exec('BEGIN EXCLUSIVE')
    } catch {
      this.lock.close()
      throw new Error('数据目录正被使用，请先停止集屿服务')
    }
    this.db = new DatabaseSync(join(dataDir, 'jiyu.sqlite'))
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (schema.user_version > SCHEMA_VERSION) {
      this.db.close()
      this.lock.exec('ROLLBACK')
      this.lock.close()
      throw new Error('数据库版本高于当前应用，请使用匹配版本，禁止降级覆盖')
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL REFERENCES collections(id),
        storage_key TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL,
        deleted_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        ext TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        participant TEXT NOT NULL DEFAULT '',
        submission_id TEXT
      );
      CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, time TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS renames (id TEXT PRIMARY KEY, data TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ai_runs (id TEXT PRIMARY KEY, model TEXT NOT NULL, fileCount INTEGER NOT NULL, status TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, proposalHash TEXT);
      CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, token_hash TEXT NOT NULL, key_hash TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS upload_parts (batch_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE, file_index INTEGER NOT NULL, part_index INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(batch_id,file_index,part_index));
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS documents (file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, status TEXT NOT NULL, kind TEXT, chars INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, updated_at TEXT, error TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS content_search USING fts5(file_id UNINDEXED, body, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS ai_plans (run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_transfers (file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, provider TEXT NOT NULL, state TEXT NOT NULL, revision TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL, remote_path TEXT);
      CREATE TABLE IF NOT EXISTS storage_oauth (id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_templates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_records (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), key_hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        event TEXT NOT NULL,
        collection_id TEXT,
        status TEXT NOT NULL,
        http_status INTEGER,
        attempts INTEGER NOT NULL DEFAULT 1,
        merged_count INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL,
        error TEXT,
        target_hint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS submission_collection ON submission_records(collection_id);
      CREATE INDEX IF NOT EXISTS files_collection ON files(collection_id);
      CREATE INDEX IF NOT EXISTS webhook_logs_created ON webhook_logs(created_at DESC);`)
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as {
      name: string
    }[]
    if (!sessionColumns.some((c) => c.name === 'user_id'))
      this.db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'primary'")

    // Idempotent v5 -> v6 (and earlier) materialized columns migration + backfill
    const existingFileCols = new Set(
      (this.db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name),
    )
    const materializedCols: [string, string][] = [
      ['deleted_at', 'TEXT'],
      ['status', "TEXT NOT NULL DEFAULT 'pending'"],
      ['created_at', "TEXT NOT NULL DEFAULT ''"],
      ['size', 'INTEGER NOT NULL DEFAULT 0'],
      ['name', "TEXT NOT NULL DEFAULT ''"],
      ['ext', "TEXT NOT NULL DEFAULT ''"],
      ['owner', "TEXT NOT NULL DEFAULT ''"],
      ['participant', "TEXT NOT NULL DEFAULT ''"],
      ['submission_id', 'TEXT'],
    ]
    let addedMaterializedCols = false
    for (const [col, def] of materializedCols) {
      if (!existingFileCols.has(col)) {
        this.db.exec(`ALTER TABLE files ADD COLUMN ${col} ${def}`)
        addedMaterializedCols = true
      }
    }
    if (schema.user_version < SCHEMA_VERSION || addedMaterializedCols) {
      this.transaction(() => {
        const rows = this.db.prepare('SELECT id, data FROM files').all() as {
          id: string
          data: string
        }[]
        if (rows.length) {
          const update = this.db.prepare(
            'UPDATE files SET deleted_at=?,status=?,created_at=?,size=?,name=?,ext=?,owner=?,participant=?,submission_id=? WHERE id=?',
          )
          for (const row of rows) {
            const parsed = JSON.parse(row.data) as CollectedFile
            const c = fileColumns(parsed)
            update.run(
              c.deleted_at,
              c.status,
              c.created_at,
              c.size,
              c.name,
              c.ext,
              c.owner,
              c.participant,
              c.submission_id,
              row.id,
            )
          }
        }
      })
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS files_deleted_created ON files(deleted_at, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS files_collection_deleted_created ON files(collection_id, deleted_at, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS files_deleted_status_created ON files(deleted_at, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS files_deleted_ext_created ON files(deleted_at, ext, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS files_collection_submission_participant ON files(collection_id, submission_id, participant, deleted_at);
      PRAGMA user_version=${SCHEMA_VERSION};`)

    if (this.get('password'))
      this.db
        .prepare("INSERT OR IGNORE INTO users VALUES ('primary','admin',?,?,'admin',0)")
        .run(this.get('displayName') || '管理员', this.get('password')!)
    for (const dir of ['objects', 'tmp', 'chunks'])
      mkdirSync(join(dataDir, dir), { recursive: true, mode: 0o700 })
    // 在获得目录互斥锁后恢复中断批次，已提交文件永不清理。
    for (const name of readdirSync(join(dataDir, 'tmp')))
      if (/^(?:[a-f0-9-]{36}|ocr-[a-zA-Z0-9_-]+)$/.test(name))
        rmSync(join(dataDir, 'tmp', name), { force: true, recursive: true })
    const keys = new Set(
      (this.db.prepare('SELECT storage_key FROM files').all() as { storage_key: string }[]).map(
        (r) => r.storage_key,
      ),
    )
    for (const name of readdirSync(join(dataDir, 'objects')))
      if (/^[a-f0-9-]{36}$/.test(name) && !keys.has(name))
        rmSync(join(dataDir, 'objects', name), { force: true })
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now())
    this.db.prepare("UPDATE ai_runs SET status='interrupted' WHERE status='pending'").run()
    this.db.prepare("UPDATE documents SET status='queued' WHERE status='processing'").run()
    this.db.prepare("UPDATE remote_transfers SET state='queued' WHERE state='transferring'").run()
    if (!this.get('password') && !existsSync(join(dataDir, 'setup-token')))
      writeFileSync(join(dataDir, 'setup-token'), token(), { mode: 0o600 })
  }
  get(key: string) {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
        | { value: string }
        | undefined
    )?.value
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value)
  }
  publicAccessSecret(): string {
    const existing = this.get('public.accessSecret')
    if (existing) return existing
    const secret = token()
    this.set('public.accessSecret', secret)
    return secret
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      // SQLITE_FULL may already roll back the transaction. Keep the original failure.
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* No active transaction after SQLite's automatic rollback. */
      }
      throw error
    }
  }
  activity(text: string) {
    this.db
      .prepare('INSERT INTO activities(text,time) VALUES (?,?)')
      .run(text, new Date().toISOString())
    this.db.exec(
      'DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY id DESC LIMIT 1000)',
    )
  }
  private hydrateFile(r: {
    data: string
    state: string | null
    remote_path: string | null
  }): CollectedFile {
    return normalizeStorage({
      ...JSON.parse(r.data),
      ...(r.state
        ? { remoteStatus: r.state, ...(r.remote_path ? { remotePath: r.remote_path } : {}) }
        : {}),
    })
  }
  collection(id: string): Collection | undefined {
    const row = this.db.prepare('SELECT data,token FROM collections WHERE id=?').get(id) as
      | { data: string; token: string }
      | undefined
    return row
      ? (normalizeStorage({ ...JSON.parse(row.data), uploadToken: row.token }) as Collection)
      : undefined
  }
  byToken(value: string) {
    const row = this.db.prepare('SELECT data,token FROM collections WHERE token=?').get(value) as
      | { data: string; token: string }
      | undefined
    return row
      ? (normalizeStorage({ ...JSON.parse(row.data), uploadToken: row.token }) as Collection)
      : undefined
  }
  collections(): Collection[] {
    return (
      this.db.prepare('SELECT data,token FROM collections ORDER BY rowid DESC').all() as {
        data: string
        token: string
      }[]
    ).map((r) => normalizeStorage({ ...JSON.parse(r.data), uploadToken: r.token }))
  }
  saveCollection(collection: Collection) {
    const {
      uploadToken,
      activeFiles: _activeFiles,
      pendingFiles: _pendingFiles,
      materialSummary: _materialSummary,
      requestLimitMB: _requestLimitMB,
      hasAccessCode: _hasAccessCode,
      ...data
    } = collection
    this.db
      .prepare(
        'INSERT INTO collections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,data=excluded.data',
      )
      .run(collection.id, uploadToken || token(), JSON.stringify(data))
  }
  file(id: string): CollectedFile | undefined {
    const row = this.db
      .prepare(
        'SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id WHERE f.id=?',
      )
      .get(id) as { data: string; state: string | null; remote_path: string | null } | undefined
    return row ? this.hydrateFile(row) : undefined
  }
  files(): CollectedFile[] {
    return (
      this.db
        .prepare(
          'SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id ORDER BY f.rowid DESC',
        )
        .all() as { data: string; state: string | null; remote_path: string | null }[]
    ).map((r) => this.hydrateFile(r))
  }
  collectionFiles(collectionId: string, includeDeleted = true): CollectedFile[] {
    const sql = includeDeleted
      ? 'SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id WHERE f.collection_id=? ORDER BY f.rowid DESC'
      : 'SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id WHERE f.collection_id=? AND f.deleted_at IS NULL ORDER BY f.created_at DESC, f.id DESC'
    return (
      this.db.prepare(sql).all(collectionId) as {
        data: string
        state: string | null
        remote_path: string | null
      }[]
    ).map((r) => this.hydrateFile(r))
  }
  submissionFiles(collectionId: string, submissionId: string): CollectedFile[] {
    return (
      this.db
        .prepare(
          'SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id WHERE f.collection_id=? AND f.submission_id=? AND f.deleted_at IS NULL ORDER BY f.rowid DESC',
        )
        .all(collectionId, submissionId) as {
        data: string
        state: string | null
        remote_path: string | null
      }[]
    ).map((r) => this.hydrateFile(r))
  }
  recentActiveFiles(limit: number): CollectedFile[] {
    return (
      this.db
        .prepare(
          'SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC, f.id DESC LIMIT ?',
        )
        .all(limit) as { data: string; state: string | null; remote_path: string | null }[]
    ).map((r) => this.hydrateFile(r))
  }
  fileCount() {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS total FROM files').get() as { total: number }).total,
    )
  }
  activeFileCount(collectionId: string) {
    return Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS total FROM files WHERE collection_id=? AND deleted_at IS NULL',
          )
          .get(collectionId) as { total: number }
      ).total,
    )
  }
  changeStamp() {
    const row = this.db.prepare('SELECT total_changes() AS changes').get() as { changes: number }
    return `${this.instanceId}:${row.changes}`
  }
  queryFiles(options: FileQueryOptions): PaginatedFiles {
    const where: string[] = []
    const params: (string | number)[] = []
    let cte = ''
    const cteParams: (string | number)[] = []

    if (options.collectionId) {
      where.push('f.collection_id=?')
      params.push(options.collectionId)
    }
    const trashed = options.trashed || 'false'
    if (trashed === 'false') where.push('f.deleted_at IS NULL')
    else if (trashed === 'true') where.push('f.deleted_at IS NOT NULL')
    if (options.status && options.status !== 'all') {
      where.push('f.status=?')
      params.push(options.status)
    }
    if (options.kind === 'image') {
      where.push(`f.ext IN (${IMAGE_EXTENSIONS_SQL})`)
    }
    const term = (options.q || '').trim()
    if (term) {
      const lower = term.toLowerCase()
      const searchClauses = [
        'instr(lower(f.name), ?) > 0',
        'instr(lower(f.owner), ?) > 0',
        "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(f.data, '$.tags') = 'array' THEN json_extract(f.data, '$.tags') ELSE '[]' END) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)",
      ]
      params.push(lower, lower, lower)
      if (term.length >= 3) {
        cte =
          'WITH fts_hits AS MATERIALIZED (SELECT file_id FROM content_search WHERE content_search MATCH ?) '
        cteParams.push(`"${term.replaceAll('"', '""')}"`)
        searchClauses.push('EXISTS (SELECT 1 FROM fts_hits h WHERE h.file_id = f.id)')
      } else if (term.length === 2) {
        cte =
          'WITH fts_hits AS MATERIALIZED (SELECT file_id FROM content_search WHERE instr(lower(body), ?) > 0) '
        cteParams.push(lower)
        searchClauses.push('EXISTS (SELECT 1 FROM fts_hits h WHERE h.file_id = f.id)')
      }
      where.push(`(${searchClauses.join(' OR ')})`)
    }

    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    let orderSql = 'ORDER BY f.created_at DESC, f.id DESC'
    switch (options.sort) {
      case 'created_asc':
        orderSql = 'ORDER BY f.created_at ASC, f.id ASC'
        break
      case 'name_asc':
        orderSql = 'ORDER BY f.name COLLATE NOCASE ASC, f.id ASC'
        break
      case 'name_desc':
        orderSql = 'ORDER BY f.name COLLATE NOCASE DESC, f.id DESC'
        break
      case 'size_asc':
        orderSql = 'ORDER BY f.size ASC, f.id ASC'
        break
      case 'size_desc':
        orderSql = 'ORDER BY f.size DESC, f.id DESC'
        break
      default:
        orderSql = 'ORDER BY f.created_at DESC, f.id DESC'
        break
    }

    const allWhereParams = [...cteParams, ...params]
    const total = Number(
      (
        this.db
          .prepare(`${cte}SELECT COUNT(*) AS total FROM files f${whereSql}`)
          .get(...allWhereParams) as { total: number }
      ).total,
    )
    const offset = (options.page - 1) * options.pageSize
    const rows = this.db
      .prepare(
        `${cte}SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
      )
      .all(...allWhereParams, options.pageSize, offset) as {
      data: string
      state: string | null
      remote_path: string | null
    }[]
    const items = rows.map((r) => this.hydrateFile(r))
    return {
      items,
      total,
      page: options.page,
      pageSize: options.pageSize,
      hasMore: offset + items.length < total,
    }
  }
  saveFile(file: CollectedFile) {
    const c = fileColumns(file)
    this.db
      .prepare(
        'UPDATE files SET data=?,deleted_at=?,status=?,created_at=?,size=?,name=?,ext=?,owner=?,participant=?,submission_id=? WHERE id=?',
      )
      .run(
        JSON.stringify(file),
        c.deleted_at,
        c.status,
        c.created_at,
        c.size,
        c.name,
        c.ext,
        c.owner,
        c.participant,
        c.submission_id,
        file.id,
      )
  }
  addFile(file: CollectedFile, key: string) {
    const c = fileColumns(file)
    this.db
      .prepare(
        'INSERT INTO files(id,collection_id,storage_key,data,deleted_at,status,created_at,size,name,ext,owner,participant,submission_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        file.id,
        file.collectionId,
        key,
        JSON.stringify(file),
        c.deleted_at,
        c.status,
        c.created_at,
        c.size,
        c.name,
        c.ext,
        c.owner,
        c.participant,
        c.submission_id,
      )
    if (file.storage !== 'local') {
      const profile = this.get(`storage.${file.storage}`)
      const revision = profile ? String(JSON.parse(profile).revision || '') : ''
      this.db
        .prepare(
          "INSERT INTO remote_transfers(file_id,provider,state,revision,updated_at) VALUES (?,?,'queued',?,?)",
        )
        .run(file.id, file.storage, revision, new Date().toISOString())
    }
  }
  fileKey(id: string) {
    return (
      this.db.prepare('SELECT storage_key FROM files WHERE id=?').get(id) as
        | { storage_key: string }
        | undefined
    )?.storage_key
  }
  usedBytes(collectionId?: string) {
    const row = (
      collectionId
        ? this.db
            .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE collection_id=?')
            .get(collectionId)
        : this.db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files').get()
    ) as { total: number }
    return Number(row.total)
  }
  pendingBytes(collectionId?: string) {
    return Number(
      (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(bytes),0) AS total FROM uploads WHERE expires>?${collectionId ? ' AND collection_id=?' : ''}`,
          )
          .get(Date.now(), ...(collectionId ? [collectionId] : [])) as { total: number }
      ).total,
    )
  }
  pendingFiles() {
    return Number(
      (
        this.db
          .prepare('SELECT COALESCE(SUM(file_count),0) AS total FROM uploads WHERE expires>?')
          .get(Date.now()) as { total: number }
      ).total,
    )
  }
  workspace(quotaBytes: number, requestBytes?: number, options: WorkspaceOptions = {}): Workspace {
    const mode = options.mode || 'full'
    const recentLimit = Math.max(0, Math.min(200, options.recentLimit ?? 20))
    const rawCollections = this.collections()
    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(size), 0) AS used_bytes,
           COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS active_files,
           COALESCE(SUM(CASE WHEN deleted_at IS NULL AND status='pending' THEN 1 ELSE 0 END), 0) AS pending_files,
           COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS trash_files
         FROM files`,
      )
      .get() as {
      used_bytes: number
      active_files: number
      pending_files: number
      trash_files: number
    }
    const perColCounts = new Map<string, { active: number; pending: number }>()
    for (const row of this.db
      .prepare(
        `SELECT collection_id,
                COUNT(*) AS active_count,
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count
         FROM files WHERE deleted_at IS NULL GROUP BY collection_id`,
      )
      .all() as { collection_id: string; active_count: number; pending_count: number }[]) {
      perColCounts.set(row.collection_id, {
        active: Number(row.active_count),
        pending: Number(row.pending_count),
      })
    }
    let activeFiles: CollectedFile[]
    let trashFiles: CollectedFile[]
    let allActiveByCollection: Map<string, CollectedFile[]> | null = null
    if (mode === 'summary') {
      activeFiles = recentLimit > 0 ? this.recentActiveFiles(recentLimit) : []
      trashFiles = []
    } else {
      const all = this.files()
      activeFiles = all.filter((f) => !f.deletedAt)
      trashFiles = all.filter((f) => f.deletedAt)
      allActiveByCollection = new Map()
      for (const f of activeFiles) {
        const list = allActiveByCollection.get(f.collectionId)
        if (list) list.push(f)
        else allActiveByCollection.set(f.collectionId, [f])
      }
    }
    const collections = rawCollections.map((c) => {
      const { accessCodeHash, accessCodeVersion: _ver, ...pub } = c
      const counts = perColCounts.get(c.id)
      const colActive = c.materials?.length
        ? allActiveByCollection
          ? allActiveByCollection.get(c.id) || []
          : this.collectionFiles(c.id, false)
        : null
      return {
        ...pub,
        activeFiles: counts?.active ?? 0,
        pendingFiles: counts?.pending ?? 0,
        ...(colActive ? { materialSummary: materialProgress(c, colActive) } : {}),
        hasAccessCode: Boolean(accessCodeHash),
        ...(requestBytes !== undefined ? { requestLimitMB: requestBytes / 1024 ** 2 } : {}),
      }
    })
    return {
      version: 1,
      displayName: this.get('displayName') || '管理员',
      ...(requestBytes !== undefined ? { requestLimitMB: requestBytes / 1024 ** 2 } : {}),
      collections,
      files: activeFiles,
      trash: trashFiles,
      ...(mode === 'summary' ? { summaryMode: true } : {}),
      stats: {
        activeFiles: Number(agg.active_files),
        pendingFiles: Number(agg.pending_files),
        trashFiles: Number(agg.trash_files),
        archivedCollections: rawCollections.filter((c) => Boolean(c.archivedAt)).length,
      },
      storage: { usedBytes: Number(agg.used_bytes), quotaBytes },
      lastRenameId: (
        this.db
          .prepare('SELECT id FROM renames WHERE undone=0 ORDER BY rowid DESC LIMIT 1')
          .get() as { id: string } | undefined
      )?.id,
      activities: (
        this.db.prepare('SELECT id,text,time FROM activities ORDER BY id DESC LIMIT 30').all() as {
          id: number
          text: string
          time: string
        }[]
      ).map((a) => ({
        ...a,
        id: String(a.id),
        time: new Date(a.time).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false }),
      })),
    }
  }
  setupToken() {
    return readFileSync(join(this.dataDir, 'setup-token'), 'utf8').trim()
  }
  close() {
    this.db.close()
    this.lock.exec('ROLLBACK')
    this.lock.close()
  }
}
