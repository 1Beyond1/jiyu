import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createApp } from './app.ts'
import type { Config } from './config.ts'

test('Store SQL 聚合、按 ID 精确查询与工作台单次加载避免全表扫描，且保持 schema 5 兼容', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'store-perf-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 10 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    assert.equal(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      5,
    )
    const indexes = (
      store.db.prepare("PRAGMA index_list('files')").all() as { name: string }[]
    ).map((r) => r.name)
    assert.ok(indexes.includes('files_collection'))

    const colA = {
      id: randomUUID(),
      title: '任务A',
      description: '',
      category: 'document' as const,
      received: 0,
      target: 10,
      deadline: '2099-12-31',
      storage: 'local' as const,
      status: 'active' as const,
      formats: 'PDF',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 10,
    }
    const colB = { ...colA, id: randomUUID(), title: '任务B' }
    store.saveCollection(colA)
    store.saveCollection(colB)

    const id1 = randomUUID(),
      id2 = randomUUID(),
      id3 = randomUUID()
    store.addFile(
      {
        id: id1,
        name: 'a.pdf',
        size: 1234,
        collectionId: colA.id,
        owner: '甲',
        createdAt: new Date().toISOString(),
        storage: 'local',
        status: 'pending',
      },
      randomUUID(),
    )
    store.addFile(
      {
        id: id2,
        name: 'b.pdf',
        size: 5678,
        collectionId: colA.id,
        owner: '乙',
        createdAt: new Date().toISOString(),
        storage: 'local',
        status: 'pending',
        deletedAt: new Date().toISOString(),
      },
      randomUUID(),
    )
    store.addFile(
      {
        id: id3,
        name: 'c.pdf',
        size: 9012,
        collectionId: colB.id,
        owner: '丙',
        createdAt: new Date().toISOString(),
        storage: 'local',
        status: 'ready',
      },
      randomUUID(),
    )

    let filesScans = 0
    const origFiles = store.files.bind(store)
    store.files = () => {
      filesScans++
      return origFiles()
    }

    assert.equal(store.usedBytes(), 1234 + 5678 + 9012)
    assert.equal(store.usedBytes(colA.id), 1234 + 5678)
    assert.equal(store.usedBytes(colB.id), 9012)
    assert.equal(store.fileCount(), 3)
    assert.equal(store.file(id1)?.name, 'a.pdf')
    assert.equal(store.file('non-existent'), undefined)
    assert.equal(store.collection(colA.id)?.title, '任务A')
    assert.equal(
      filesScans,
      0,
      'usedBytes / fileCount / file / collection 不应触发 store.files() 全表扫描',
    )

    const ws = store.workspace(config.quotaBytes, config.requestBytes)
    assert.equal(ws.storage?.usedBytes, 1234 + 5678 + 9012)
    assert.equal(ws.files.length, 2)
    assert.equal(ws.trash?.length, 1)
    assert.equal(filesScans, 1, 'workspace() 只应调用一次 store.files()')
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})

test('multipart 上传流在大量小分块下不按 chunk 查询 SQLite，且并发配额预留依然精确', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'upload-hotpath-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 1024 * 1024,
    requestBytes: 2 * 1024 * 1024,
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
        displayName: '性能',
        password: 'perf-test-password',
      },
    })
    const headers = {
      origin: config.origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers,
      payload: {
        title: '热路径',
        description: '',
        category: 'document',
        target: 10,
        deadline: '2099-12-31',
        formats: 'PDF',
        maxFileSizeMB: 1,
        maxFilesPerSubmission: 2,
        maxTotalSizeMB: 10,
      },
    })
    const c = created.json().collections[0]

    let usedBytesCalls = 0,
      filesCalls = 0
    const origUsed = store.usedBytes.bind(store),
      origFiles = store.files.bind(store)
    store.usedBytes = (cid?: string) => {
      usedBytesCalls++
      return origUsed(cid)
    }
    store.files = () => {
      filesCalls++
      return origFiles()
    }

    // Stream 64 small 8 KiB chunks (512 KiB total) to ensure chunk callbacks stay O(1) in memory.
    const boundary = 'hotpath-boundary'
    const chunks: Buffer[] = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="owner"\r\n\r\n流式用户\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="stream.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      ...Array.from({ length: 64 }, () => Buffer.alloc(8 * 1024, 65)),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]
    const res = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/upload`,
      headers: {
        origin: config.origin,
        'idempotency-key': randomUUID(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Readable.from(chunks),
    })
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(filesCalls, 0, '上传路径不应调用 store.files()')
    assert.ok(
      usedBytesCalls <= 8,
      `usedBytes 调用次数应为常数级而非按 chunk 增长，实际为 ${usedBytesCalls}`,
    )

    // Remaining quota is 512 KiB; two concurrent 400 KiB uploads must allow exactly one and reject the other.
    const upload400k = (name: string) =>
      app.inject({
        method: 'POST',
        url: `/api/public/${c.uploadToken}/upload`,
        headers: {
          origin: config.origin,
          'idempotency-key': randomUUID(),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="owner"\r\n\r\n并发用户\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}.pdf"\r\n\r\n`,
          ),
          Buffer.alloc(400 * 1024, 66),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      })
    const results = await Promise.all([upload400k('a'), upload400k('b')])
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 413])
    assert.equal(origUsed(), 512 * 1024 + 400 * 1024)
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})
