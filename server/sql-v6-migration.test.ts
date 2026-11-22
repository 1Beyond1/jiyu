import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, Store } from './store.ts'
import { createApp } from './app.ts'
import { createBackup, restoreBackup } from './backup.ts'
import type { Config } from './config.ts'
import type { Collection, CollectedFile, Workspace } from '../src/types.ts'

test('SQLite v5 → v6 幂等迁移：零数据丢失、完整回填 9 个物化列与 5 个复合索引、禁止降级且兼容备份恢复', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'v5-v6-migration-'))
  const dataDir = join(dir, 'data')
  await mkdir(join(dataDir, 'objects'), { recursive: true })
  let store: Store | undefined
  try {
    // 1. 手工构建真实 v5 数据库（files 表仅有 4 个旧列）
    const legacyDb = new DatabaseSync(join(dataDir, 'jiyu.sqlite'))
    const colId = randomUUID()
    const subId = randomUUID()
    const f1Id = randomUUID()
    const f2Id = randomUUID()
    const f3Id = randomUUID()
    const k1 = randomUUID()
    const k2 = randomUUID()
    const k3 = randomUUID()

    const col: Collection = {
      id: colId,
      title: 'v5 历史任务',
      description: '',
      category: 'document',
      received: 3,
      target: 10,
      deadline: '2099-12-31',
      storage: 'local',
      status: 'active',
      formats: 'PDF, PNG',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 5,
    }
    const f1: CollectedFile = {
      id: f1Id,
      name: 'Report.PDF',
      size: 1024,
      collectionId: colId,
      owner: '张三',
      participant: 'S001',
      submissionId: subId,
      createdAt: '2026-10-01T10:00:00.000Z',
      storage: 'local',
      status: 'ready',
      tags: ['验收'],
      sha256: 'a'.repeat(64),
    }
    const f2: CollectedFile = {
      id: f2Id,
      name: 'cover.PNG',
      size: 2048,
      collectionId: colId,
      owner: '李四',
      participant: 'S002',
      createdAt: '2026-10-02T10:00:00.000Z',
      storage: 'local',
      status: 'pending',
      sha256: 'b'.repeat(64),
    }
    const f3: CollectedFile = {
      id: f3Id,
      name: 'deleted.pdf',
      size: 512,
      collectionId: colId,
      owner: '王五',
      createdAt: '2026-10-03T10:00:00.000Z',
      deletedAt: '2026-10-04T08:00:00.000Z',
      storage: 'local',
      status: 'pending',
      sha256: 'c'.repeat(64),
    }
    legacyDb.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE collections (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE files (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), storage_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE INDEX files_collection ON files(collection_id);
      PRAGMA user_version=5;
    `)
    legacyDb
      .prepare('INSERT INTO collections VALUES (?,?,?)')
      .run(colId, 'legacy-token-123456', JSON.stringify(col))
    const ins = legacyDb.prepare('INSERT INTO files VALUES (?,?,?,?)')
    ins.run(f1Id, colId, k1, JSON.stringify(f1))
    ins.run(f2Id, colId, k2, JSON.stringify(f2))
    ins.run(f3Id, colId, k3, JSON.stringify(f3))
    legacyDb.close()

    // 2. 用当前 Store 打开，自动触发 v5 → v6 迁移
    store = new Store(dataDir)
    assert.equal(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      SCHEMA_VERSION,
    )
    const cols = (store.db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map(
      (r) => r.name,
    )
    for (const expected of [
      'deleted_at',
      'status',
      'created_at',
      'size',
      'name',
      'ext',
      'owner',
      'participant',
      'submission_id',
    ]) {
      assert.ok(cols.includes(expected), `files 表应包含物化列 ${expected}`)
    }
    const indexes = (
      store.db.prepare("PRAGMA index_list('files')").all() as { name: string }[]
    ).map((r) => r.name)
    for (const idx of [
      'files_collection',
      'files_deleted_created',
      'files_collection_deleted_created',
      'files_deleted_status_created',
      'files_deleted_ext_created',
      'files_collection_submission_participant',
    ]) {
      assert.ok(indexes.includes(idx), `files 表应包含索引 ${idx}`)
    }

    // 校验每条历史记录的物化列精确回填
    const row1 = store.db
      .prepare(
        'SELECT deleted_at,status,created_at,size,name,ext,owner,participant,submission_id FROM files WHERE id=?',
      )
      .get(f1Id) as Record<string, unknown>
    assert.deepEqual(
      { ...row1 },
      {
        deleted_at: null,
        status: 'ready',
        created_at: '2026-10-01T10:00:00.000Z',
        size: 1024,
        name: 'Report.PDF',
        ext: 'pdf',
        owner: '张三',
        participant: 'S001',
        submission_id: subId,
      },
    )
    const row2 = store.db
      .prepare('SELECT ext,status,deleted_at FROM files WHERE id=?')
      .get(f2Id) as {
      ext: string
      status: string
      deleted_at: string | null
    }
    assert.equal(row2.ext, 'png')
    assert.equal(row2.status, 'pending')
    assert.equal(row2.deleted_at, null)
    const row3 = store.db.prepare('SELECT deleted_at FROM files WHERE id=?').get(f3Id) as {
      deleted_at: string | null
    }
    assert.equal(row3.deleted_at, '2026-10-04T08:00:00.000Z')

    // 3. 幂等性验证：强制回拨 user_version=5 再重启，不报错、不丢数据
    store.db.exec('PRAGMA user_version=5;')
    store.close()
    store = undefined
    store = new Store(dataDir)
    assert.equal(store.fileCount(), 3)
    assert.equal(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      6,
    )
    assert.equal(store.usedBytes(), 1024 + 2048 + 512)
    assert.equal(store.activeFileCount(colId), 2)

    // 4. 禁止降级验证：user_version=7 必须拒绝打开
    store.db.exec('PRAGMA user_version=7;')
    store.close()
    store = undefined
    assert.throws(() => new Store(dataDir), /数据库版本高于当前应用/)

    // 恢复为 6 后测试 v6 备份与恢复（创建空对象用于校验，仅留 0 字节文件测试备份）
    const fixDb = new DatabaseSync(join(dataDir, 'jiyu.sqlite'))
    fixDb.exec('DELETE FROM files; PRAGMA user_version=6;')
    fixDb.close()
    const backupDir = join(dir, 'v6-backup')
    const restoredDir = join(dir, 'v6-restored')
    await createBackup(dataDir, backupDir)
    await restoreBackup(backupDir, restoredDir)
    const restored = new Store(restoredDir)
    try {
      assert.equal(restored.collection(colId)?.title, 'v5 历史任务')
      assert.equal(
        (restored.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        6,
      )
    } finally {
      restored.close()
    }
  } finally {
    store?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('真 SQL 分页 queryFiles（含 FTS5 EXISTS、标签、排序、增改删同步）与轻量化 GET /api/workspace?mode=summary 零全表扫描', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'sql-paging-summary-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 50 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: config.origin },
      payload: {
        setupToken: store.setupToken(),
        displayName: '架构师',
        password: 'StrongPassword123!',
      },
    })
    assert.equal(setup.statusCode, 200)
    const cookie = String(setup.headers['set-cookie']).split(';')[0]
    const csrf = setup.json().csrf as string
    const adminHeaders = { origin: config.origin, cookie, 'x-csrf-token': csrf }

    const colA: Collection = {
      id: randomUUID(),
      title: '大规模任务A',
      description: '',
      category: 'document',
      received: 0,
      target: 500,
      deadline: '2099-12-31',
      storage: 'local',
      status: 'active',
      formats: 'PDF, PNG',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 10,
      uploadToken: 'tok-large-a-123456',
    }
    const colB: Collection = {
      ...colA,
      id: randomUUID(),
      title: '归档任务B',
      archivedAt: '2026-11-01T00:00:00.000Z',
      status: 'paused',
      uploadToken: 'tok-large-b-123456',
    }
    store.saveCollection(colA)
    store.saveCollection(colB)

    // 批量写入 250 条文件（含图片、已整理、回收站、标签与 FTS5 正文）
    const baseMs = Date.parse('2026-11-01T00:00:00.000Z')
    let ftsTargetId = ''
    let tagTargetId = ''
    store.transaction(() => {
      for (let i = 0; i < 250; i++) {
        const id = randomUUID()
        const isTrash = i >= 240
        const isImg = i % 5 === 0
        const isReady = i % 3 === 0
        const file: CollectedFile = {
          id,
          name: `doc_${String(i).padStart(3, '0')}.${isImg ? 'png' : 'pdf'}`,
          size: (i + 1) * 100,
          collectionId: i % 4 === 0 ? colB.id : colA.id,
          owner: i === 42 ? '特殊提交人' : `成员${i % 10}`,
          participant: `P${i}`,
          createdAt: new Date(baseMs + i * 1000).toISOString(),
          storage: 'local',
          status: isReady ? 'ready' : 'pending',
          ...(isTrash ? { deletedAt: new Date(baseMs + 500000 + i * 1000).toISOString() } : {}),
          ...(i === 17 ? { tags: ['终稿标签', '财务'] } : {}),
        }
        store.addFile(file, randomUUID())
        if (i === 55) {
          ftsTargetId = id
          store.db
            .prepare('INSERT INTO content_search(file_id, body) VALUES (?, ?)')
            .run(id, '这是用于验证 SQLite FTS5 三元组正文检索的专属关键词：星辰大海计划')
        }
        if (i === 17) tagTargetId = id
      }
    })

    // 监视 store.files()：以下所有 queryFiles 与 summary workspace 调用必须 0 次触发全表扫描
    let fullScans = 0
    const origFiles = store.files.bind(store)
    store.files = () => {
      fullScans++
      return origFiles()
    }

    // 1. 分页 + 排序 + 总数
    const p1 = store.queryFiles({ page: 1, pageSize: 20, sort: 'created_desc' })
    assert.equal(p1.total, 240)
    assert.equal(p1.items.length, 20)
    assert.equal(p1.hasMore, true)
    assert.equal(p1.items[0].name, 'doc_239.pdf')

    const sizeDesc = store.queryFiles({ page: 1, pageSize: 5, sort: 'size_desc' })
    assert.equal(sizeDesc.items[0].size, 240 * 100)
    assert.equal(sizeDesc.items[1].size, 239 * 100)

    const nameAsc = store.queryFiles({ page: 1, pageSize: 3, sort: 'name_asc' })
    assert.deepEqual(
      nameAsc.items.map((f) => f.name),
      ['doc_000.png', 'doc_001.pdf', 'doc_002.pdf'],
    )

    // 2. 图片扩展名筛选 + 回收站筛选
    const imgs = store.queryFiles({ page: 1, pageSize: 100, sort: 'created_desc', kind: 'image' })
    assert.equal(imgs.total, 48) // 0,5,...,235
    assert.ok(imgs.items.every((f) => f.name.endsWith('.png')))

    const trashRes = store.queryFiles({
      page: 1,
      pageSize: 50,
      sort: 'created_desc',
      trashed: 'true',
    })
    assert.equal(trashRes.total, 10)

    // 3. FTS5 3+ 字符正文搜索 & 2 字符正文搜索 & 标签搜索
    const ftsHit = store.queryFiles({
      page: 1,
      pageSize: 10,
      sort: 'created_desc',
      q: '星辰大海',
    })
    assert.equal(ftsHit.total, 1)
    assert.equal(ftsHit.items[0].id, ftsTargetId)

    const twoCharHit = store.queryFiles({
      page: 1,
      pageSize: 10,
      sort: 'created_desc',
      q: '星辰',
    })
    assert.equal(twoCharHit.total, 1)
    assert.equal(twoCharHit.items[0].id, ftsTargetId)

    const tagHit = store.queryFiles({
      page: 1,
      pageSize: 10,
      sort: 'created_desc',
      q: '终稿标签',
    })
    assert.equal(tagHit.total, 1)
    assert.equal(tagHit.items[0].id, tagTargetId)

    // 4. 轻量化 GET /api/workspace?mode=summary 零全表扫描 + 完整摘要统计 + 独立 ETag 304
    const summaryRes = await app.inject({
      method: 'GET',
      url: '/api/workspace?mode=summary',
      headers: { cookie },
    })
    assert.equal(summaryRes.statusCode, 200)
    const ws = summaryRes.json() as Workspace
    assert.equal(ws.summaryMode, true)
    assert.equal(ws.files.length, 20, 'summary 模式最多返回最近 20 份有效文件')
    assert.equal(ws.trash?.length, 0, 'summary 模式不返回全量回收站列表')
    assert.equal(ws.stats?.activeFiles, 240)
    assert.equal(ws.stats?.trashFiles, 10)
    assert.equal(ws.stats?.pendingFiles, 160)
    assert.equal(ws.stats?.archivedCollections, 1)

    const summary304 = await app.inject({
      method: 'GET',
      url: '/api/workspace?mode=summary',
      headers: { cookie, 'if-none-match': String(summaryRes.headers.etag) },
    })
    assert.equal(summary304.statusCode, 304)

    assert.equal(
      fullScans,
      0,
      '真 SQL queryFiles 与 summary workspace 不得触发 store.files() 全表扫描',
    )

    // 5. 状态变更 / 重命名 / 软删 / 恢复 原子维护物化列
    const target = p1.items[0]
    await app.inject({
      method: 'POST',
      url: '/api/files/review',
      headers: { ...adminHeaders, 'x-workspace-mode': 'summary' },
      payload: { ids: [target.id] },
    })
    const afterReview = store.db.prepare('SELECT status FROM files WHERE id=?').get(target.id) as {
      status: string
    }
    assert.equal(afterReview.status, 'ready')

    await app.inject({
      method: 'POST',
      url: '/api/files/trash',
      headers: { ...adminHeaders, 'x-workspace-mode': 'summary' },
      payload: { ids: [target.id] },
    })
    const afterTrash = store.db
      .prepare('SELECT deleted_at FROM files WHERE id=?')
      .get(target.id) as { deleted_at: string | null }
    assert.ok(afterTrash.deleted_at)
    assert.equal(store.queryFiles({ page: 1, pageSize: 10, sort: 'created_desc' }).total, 239)

    await app.inject({
      method: 'POST',
      url: '/api/files/restore',
      headers: { ...adminHeaders, 'x-workspace-mode': 'summary' },
      payload: { ids: [target.id] },
    })
    const afterRestore = store.db
      .prepare('SELECT deleted_at FROM files WHERE id=?')
      .get(target.id) as { deleted_at: string | null }
    assert.equal(afterRestore.deleted_at, null)
    assert.equal(store.queryFiles({ page: 1, pageSize: 10, sort: 'created_desc' }).total, 240)

    // 6. 【P1-1 回归】NUL 字节拦截防 FTS5 500 崩溃 + 双生僻字/双 Emoji 按码点走 instr 命中
    const astralId = randomUUID()
    store.addFile(
      {
        id: astralId,
        name: 'astral_test.pdf',
        size: 128,
        collectionId: colA.id,
        owner: '测试员',
        participant: 'ASTRAL',
        createdAt: new Date(baseMs + 999_000).toISOString(),
        storage: 'local',
        status: 'pending',
      },
      randomUUID(),
    )
    store.db
      .prepare('INSERT INTO content_search(file_id, body) VALUES (?, ?)')
      .run(astralId, '包含两个生僻字 𠀀𠀁 以及两个 Emoji 🚀🎯 的索引正文')

    const nulFilesRes = await app.inject({
      method: 'GET',
      url: `/api/files?q=${encodeURIComponent('abc\0def')}`,
      headers: { cookie },
    })
    assert.equal(nulFilesRes.statusCode, 400, '含 NUL 字节搜索词必须返回 400 而非 500')

    const nulContentRes = await app.inject({
      method: 'GET',
      url: `/api/content/search?q=${encodeURIComponent('abc\0def')}`,
      headers: { cookie },
    })
    assert.equal(nulContentRes.statusCode, 400, '/api/content/search 含 NUL 字节必须返回 400')

    assert.doesNotThrow(() =>
      store.queryFiles({ page: 1, pageSize: 10, sort: 'created_desc', q: 'abc\0def' }),
    )

    // 两个 Emoji（UTF-16 length=4，Unicode 码点数=2）与两个扩展汉字（length=4，码点数=2）必须命中
    for (const term of ['🚀🎯', '𠀀𠀁']) {
      const filesHit = await app.inject({
        method: 'GET',
        url: `/api/files?q=${encodeURIComponent(term)}`,
        headers: { cookie },
      })
      assert.equal(filesHit.statusCode, 200, filesHit.body)
      assert.equal(filesHit.json().total, 1, `/api/files 应按码点检索命中 ${term}`)
      assert.equal(filesHit.json().items[0].id, astralId)

      const contentHit = await app.inject({
        method: 'GET',
        url: `/api/content/search?q=${encodeURIComponent(term)}`,
        headers: { cookie },
      })
      assert.equal(contentHit.statusCode, 200, contentHit.body)
      assert.equal(contentHit.json().matches.length, 1, `/api/content/search 应命中 ${term}`)
      assert.equal(contentHit.json().matches[0].id, astralId)
    }

    // 单个 Emoji（length=2 但仅 1 个码点）在 /api/content/search 应返回 400
    const singleEmojiRes = await app.inject({
      method: 'GET',
      url: `/api/content/search?q=${encodeURIComponent('🚀')}`,
      headers: { cookie },
    })
    assert.equal(singleEmojiRes.statusCode, 400)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
