import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { token } from './security.ts'
import type { Workspace, Collection, CollectedFile } from '../src/types.ts'
import { cloudStorageIds } from '../src/types.ts'

// Removed providers fall back to the immutable local copy; keep stored history intact.
function normalizeStorage<T extends { storage: string }>(record: T): T {
  return record.storage === 'local' || cloudStorageIds.some(id => id === record.storage) ? record : { ...record, storage: 'local' }
}

export class Store {
  db: DatabaseSync
  lock: DatabaseSync
  dataDir: string
  constructor(dataDir: string) {
    this.dataDir = dataDir
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.lock = new DatabaseSync(join(dataDir, 'service-lock.sqlite'))
    try { this.lock.exec('BEGIN EXCLUSIVE') } catch { this.lock.close(); throw new Error('数据目录正被使用，请先停止集屿服务') }
    this.db = new DatabaseSync(join(dataDir, 'jiyu.sqlite'))
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (schema.user_version > 5) { this.db.close(); this.lock.exec('ROLLBACK'); this.lock.close(); throw new Error('数据库版本高于当前应用，请使用匹配版本，禁止降级覆盖') }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), storage_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
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
      CREATE INDEX IF NOT EXISTS submission_collection ON submission_records(collection_id);
      PRAGMA user_version=5;`)
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (!sessionColumns.some(c => c.name === 'user_id')) this.db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'primary'")
    if (this.get('password')) this.db.prepare("INSERT OR IGNORE INTO users VALUES ('primary','admin',?,?,'admin',0)").run(this.get('displayName') || '管理员', this.get('password')!)
    for (const dir of ['objects', 'tmp', 'chunks']) mkdirSync(join(dataDir, dir), { recursive: true, mode: 0o700 })
    // 在获得目录互斥锁后恢复中断批次，已提交文件永不清理。
    for (const name of readdirSync(join(dataDir, 'tmp'))) if (/^(?:[a-f0-9-]{36}|ocr-[a-zA-Z0-9_-]+)$/.test(name)) rmSync(join(dataDir, 'tmp', name), { force: true, recursive: true })
    const keys = new Set((this.db.prepare('SELECT storage_key FROM files').all() as { storage_key: string }[]).map(r => r.storage_key))
    for (const name of readdirSync(join(dataDir, 'objects'))) if (/^[a-f0-9-]{36}$/.test(name) && !keys.has(name)) rmSync(join(dataDir, 'objects', name), { force: true })
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now())
    this.db.prepare("UPDATE ai_runs SET status='interrupted' WHERE status='pending'").run()
    this.db.prepare("UPDATE documents SET status='queued' WHERE status='processing'").run()
    this.db.prepare("UPDATE remote_transfers SET state='queued' WHERE state='transferring'").run()
    if (!this.get('password') && !existsSync(join(dataDir, 'setup-token'))) writeFileSync(join(dataDir, 'setup-token'), token(), { mode: 0o600 })
  }
  get(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value }
  set(key: string, value: string) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result } catch (error) {
      // SQLITE_FULL may already roll back the transaction. Keep the original failure.
      try { this.db.exec('ROLLBACK') } catch { /* No active transaction after SQLite's automatic rollback. */ }
      throw error
    }
  }
  activity(text: string) {
    this.db.prepare('INSERT INTO activities(text,time) VALUES (?,?)').run(text, new Date().toISOString())
    this.db.exec('DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY id DESC LIMIT 1000)')
  }
  collection(id: string) { return this.collections().find(c => c.id === id) }
  byToken(value: string) {
    const row = this.db.prepare('SELECT data,token FROM collections WHERE token=?').get(value) as { data: string; token: string } | undefined
    return row ? normalizeStorage({ ...JSON.parse(row.data), uploadToken: row.token }) as Collection : undefined
  }
  collections(): Collection[] { return (this.db.prepare('SELECT data,token FROM collections ORDER BY rowid DESC').all() as { data: string; token: string }[]).map(r => normalizeStorage({ ...JSON.parse(r.data), uploadToken: r.token })) }
  saveCollection(collection: Collection) {
    const { uploadToken, ...data } = collection
    this.db.prepare('INSERT INTO collections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,data=excluded.data').run(collection.id, uploadToken || token(), JSON.stringify(data))
  }
  files(): CollectedFile[] { return (this.db.prepare('SELECT f.data,t.state,t.remote_path FROM files f LEFT JOIN remote_transfers t ON t.file_id=f.id ORDER BY f.rowid DESC').all() as { data: string; state: string | null; remote_path: string | null }[]).map(r => normalizeStorage({ ...JSON.parse(r.data), ...(r.state ? { remoteStatus: r.state, ...(r.remote_path ? { remotePath: r.remote_path } : {}) } : {}) })) }
  saveFile(file: CollectedFile) { this.db.prepare('UPDATE files SET data=? WHERE id=?').run(JSON.stringify(file), file.id) }
  addFile(file: CollectedFile, key: string) {
    this.db.prepare('INSERT INTO files VALUES (?,?,?,?)').run(file.id, file.collectionId, key, JSON.stringify(file))
    if (file.storage !== 'local') {
      const profile = this.get(`storage.${file.storage}`)
      const revision = profile ? String(JSON.parse(profile).revision || '') : ''
      this.db.prepare("INSERT INTO remote_transfers(file_id,provider,state,revision,updated_at) VALUES (?,?,'queued',?,?)").run(file.id, file.storage, revision, new Date().toISOString())
    }
  }
  fileKey(id: string) { return (this.db.prepare('SELECT storage_key FROM files WHERE id=?').get(id) as { storage_key: string } | undefined)?.storage_key }
  usedBytes(collectionId?: string) { return this.files().filter(f => !collectionId || f.collectionId === collectionId).reduce((sum, f) => sum + f.size, 0) }
  pendingBytes(collectionId?: string) { return Number((this.db.prepare(`SELECT COALESCE(SUM(bytes),0) AS total FROM uploads WHERE expires>?${collectionId ? ' AND collection_id=?' : ''}`).get(Date.now(), ...(collectionId ? [collectionId] : [])) as { total: number }).total) }
  pendingFiles() { return Number((this.db.prepare('SELECT COALESCE(SUM(file_count),0) AS total FROM uploads WHERE expires>?').get(Date.now()) as { total: number }).total) }
  workspace(quotaBytes: number, requestBytes?: number): Workspace {
    const files = this.files()
    return { version: 1, displayName: this.get('displayName') || '管理员', ...(requestBytes !== undefined ? { requestLimitMB: requestBytes / 1024 ** 2 } : {}), collections: this.collections().map(c => requestBytes !== undefined ? { ...c, requestLimitMB: requestBytes / 1024 ** 2 } : c), files: files.filter(f => !f.deletedAt), trash: files.filter(f => f.deletedAt), storage: { usedBytes: this.usedBytes(), quotaBytes }, lastRenameId: (this.db.prepare('SELECT id FROM renames WHERE undone=0 ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined)?.id, activities: (this.db.prepare('SELECT id,text,time FROM activities ORDER BY id DESC LIMIT 30').all() as { id: number; text: string; time: string }[]).map(a => ({ ...a, id: String(a.id), time: new Date(a.time).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false }) })) }
  }
  setupToken() { return readFileSync(join(this.dataDir, 'setup-token'), 'utf8').trim() }
  close() { this.db.close(); this.lock.exec('ROLLBACK'); this.lock.close() }
}
