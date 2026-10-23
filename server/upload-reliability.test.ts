import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import { CHUNK_BYTES } from './uploads.ts'
import type { Config } from './config.ts'

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')

test('真实 HTTP：12 人争用配额、并发完成、服务重启与逐字节核对', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'upload-load-'))
  const size = CHUNK_BYTES + 17, config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 0, quotaBytes: size * 8, requestBytes: size, secureCookie: false }
  let service = await createApp(config, { serveFrontend: false })
  const headers = { origin: config.origin }
  let base = await service.app.listen({ host: config.host, port: 0 })
  const call = async (url: string, method: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + url, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}), ...extra }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    return { status: response.status, data: await response.json() }
  }
  try {
    const setup = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { setupToken: service.store.setupToken(), password: 'load-test-password', displayName: '并发验收' } })
    const admin = { ...headers, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const task = await service.app.inject({ method: 'POST', url: '/api/collections', headers: admin, payload: { title: '并发收集', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 12, maxFileSizeMB: 8, maxFilesPerSubmission: 2, maxTotalSizeMB: 64 } })
    assert.equal(task.statusCode, 200, task.body)
    const c = task.json().collections[0]
    const batches = Array.from({ length: 12 }, (_, i) => ({ url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`, key: { 'x-upload-key': String(i).padStart(64, 'x') }, bytes: Buffer.alloc(size, 65 + i), owner: `提交人${i}` }))
    const starts = await Promise.all(batches.map(b => call(b.url, 'POST', { owner: b.owner, files: [{ name: `${b.owner}.txt`, size, lastModified: 1 }] }, b.key)))
    assert.equal(starts.filter(r => r.status === 200).length, 8)
    assert.equal(starts.filter(r => r.status === 413).length, 4)
    assert.equal(service.store.pendingBytes(), config.quotaBytes)
    const accepted = batches.filter((_, i) => starts[i].status === 200)
    async function retry(url: string, method: string, body: unknown, key: Record<string, string>) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const result = await call(url, method, body, key)
        if (result.status !== 429) return result
        await new Promise(r => setTimeout(r, 15))
      }
      throw new Error('上传并发名额未释放')
    }
    await Promise.all(accepted.map(async b => {
      const bytes = b.bytes.subarray(0, CHUNK_BYTES), r = await retry(`${b.url}/0/0`, 'PUT', bytes, { ...b.key, 'x-chunk-sha256': hash(bytes) })
      assert.equal(r.status, 200, JSON.stringify(r.data))
    }))
    await service.app.close(); service = await createApp(config, { serveFrontend: false }); base = await service.app.listen({ host: config.host, port: 0 })
    await Promise.all(accepted.map(async b => {
      assert.equal((await call(b.url, 'GET', undefined, b.key)).data.parts.length, 1)
      const bytes = b.bytes.subarray(CHUNK_BYTES), r = await retry(`${b.url}/0/1`, 'PUT', bytes, { ...b.key, 'x-chunk-sha256': hash(bytes) })
      assert.equal(r.status, 200, JSON.stringify(r.data))
    }))
    const results = await Promise.all(accepted.map(b => retry(`${b.url}/complete`, 'POST', {}, b.key)))
    results.forEach(r => assert.equal(r.status, 201, JSON.stringify(r.data)))
    for (let i = 0; i < accepted.length; i++) {
      const b = accepted[i], again = await call(`${b.url}/complete`, 'POST', {}, b.key)
      assert.equal(again.data.receiptId, results[i].data.receiptId)
      const file = service.store.files().find(f => f.owner === b.owner)!
      assert.equal(file.sha256, hash(b.bytes))
      assert.deepEqual(await readFile(join(config.dataDir, 'objects', service.store.fileKey(file.id)!)), b.bytes)
    }
    assert.equal(service.store.files().length, 8); assert.equal(service.store.collection(c.id)!.received, 8)
    assert.equal(service.store.pendingBytes(), 0); assert.equal(service.store.usedBytes(), config.quotaBytes)
    assert.deepEqual(await readdir(join(config.dataDir, 'chunks')), [])
    assert.deepEqual(await readdir(join(config.dataDir, 'tmp')), [])
    assert.equal((await call(batches[0].url + '/0/0', 'PUT', Buffer.alloc(CHUNK_BYTES), { 'x-upload-key': 'z'.repeat(64) })).status, 410)
  } finally { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})

test('分片损坏与数据库写满：失败不产生回执或孤立正文，修复后原批次可重试', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'upload-fault-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 0, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2, secureCookie: false }
  const service = await createApp(config, { serveFrontend: false }), headers = { origin: config.origin }
  try {
    const setup = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { setupToken: service.store.setupToken(), password: 'fault-test-password', displayName: '故障验收' } })
    const admin = { ...headers, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const task = await service.app.inject({ method: 'POST', url: '/api/collections', headers: admin, payload: { title: '故障收集', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 2, maxFileSizeMB: 1, maxFilesPerSubmission: 2 } })
    const c = task.json().collections[0], id = randomUUID(), url = `/api/public/${c.uploadToken}/uploads/${id}`, key = { ...headers, 'x-upload-key': 'x'.repeat(64) }
    await service.app.inject({ method: 'POST', url, headers: key, payload: { owner: '小屿', files: [{ name: 'a.txt', size: 3, lastModified: 1 }] } })
    await service.app.inject({ method: 'PUT', url: `${url}/0/0`, headers: { ...key, 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash(Buffer.from('abc')) }, payload: Buffer.from('abc') })
    const complete = () => service.app.inject({ method: 'POST', url: `${url}/complete`, headers: key, payload: {} })
    await writeFile(join(config.dataDir, 'chunks', `${id}.0.0`), 'bad')
    assert.equal((await complete()).statusCode, 409)
    assert.deepEqual(await readdir(join(config.dataDir, 'objects')), [])
    assert.deepEqual(await readdir(join(config.dataDir, 'tmp')), [])
    await writeFile(join(config.dataDir, 'chunks', `${id}.0.0`), 'abc')
    const add = service.store.addFile
    // Force the real database to its page limit; SQLite can roll back the transaction itself.
    const pages = service.store.db.prepare('PRAGMA page_count').get()!.page_count
    let diskError: unknown
    try {
      service.store.db.exec(`PRAGMA max_page_count=${pages}`)
      try { service.store.transaction(() => service.store.set('fault.fill', 'x'.repeat(1024 ** 2))) } catch (e) { diskError = e }
    } finally { service.store.db.exec('PRAGMA max_page_count=1073741823') }
    assert.equal((diskError as { errcode: number }).errcode, 13)
    assert.equal(service.store.get('fault.fill'), undefined)
    // Reuse that native error to exercise the HTTP commit rollback and object cleanup.
    service.store.addFile = () => { throw diskError }
    let failed
    try { failed = await complete() } finally { service.store.addFile = add }
    assert.equal(failed.statusCode, 507, failed.body)
    assert.equal(service.store.files().length, 0); assert.equal(service.store.collection(c.id)!.received, 0)
    assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM submission_records').get()!.n, 0)
    assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get()!.n, 0)
    assert.deepEqual(await readdir(join(config.dataDir, 'objects')), [])
    assert.deepEqual(await readdir(join(config.dataDir, 'tmp')), [])
    assert.equal(service.store.pendingBytes(), 3)
    assert.equal((await complete()).statusCode, 201)
    assert.equal(service.store.files().length, 1)
  } finally { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
