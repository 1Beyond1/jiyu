import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import { CHUNK_BYTES } from './uploads.ts'
import type { Config } from './config.ts'

test('分片续传跨重启、逐片校验、原子提交、私有凭证与配额共享', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'resume-test-'))
  const config: Config = { dataDir: join(dir, 'data'), host: '127.0.0.1', port: 3000, origin: 'http://127.0.0.1:3000', quotaBytes: CHUNK_BYTES * 2, requestBytes: CHUNK_BYTES * 2, secureCookie: false }
  let service = await createApp(config, { serveFrontend: false })
  const origin = { origin: config.origin }, key = 'x'.repeat(64)
  try {
    const setup = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers: origin, payload: { setupToken: service.store.setupToken(), password: 'test-resume-password', displayName: '续传测试' } })
    const headers = { ...origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const task = await service.app.inject({ method: 'POST', url: '/api/collections', headers, payload: { title: '续传', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 8, maxFilesPerSubmission: 10, maxTotalSizeMB: 8 } })
    const c = task.json().collections[0], batchId = randomUUID(), url = `/api/public/${c.uploadToken}/uploads/${batchId}`
    const draft = { owner: '小屿', files: [{ name: '大文件.txt', size: CHUNK_BYTES + 6, lastModified: 1 }, { name: '空文件.txt', size: 0, lastModified: 1 }] }
    const resumeHeaders = { ...origin, 'x-upload-key': key }
    const start = await service.app.inject({ method: 'POST', url, headers: resumeHeaders, payload: draft })
    assert.equal(start.statusCode, 200, start.body)
    // A batch persisted by v0.3 has no custom-field metadata; retry remains compatible.
    service.store.db.prepare('UPDATE uploads SET data=? WHERE id=?').run(JSON.stringify(draft), batchId)
    assert.equal((await service.app.inject({ method: 'POST', url, headers: resumeHeaders, payload: draft })).statusCode, 200)
    assert.equal(service.store.pendingBytes(), CHUNK_BYTES + 6)
    const second = await service.app.inject({ method: 'POST', url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`, headers: resumeHeaders, payload: { owner: '另一人', files: [{ name: '另一份.txt', size: CHUNK_BYTES, lastModified: 2 }] } })
    assert.equal(second.statusCode, 413)
    assert.equal((await service.app.inject({ method: 'GET', url, headers: { ...origin, 'x-upload-key': 'y'.repeat(64) } })).statusCode, 403)
    const part = async (number: number, payload: Buffer, hash = createHash('sha256').update(payload).digest('hex')) => service.app.inject({ method: 'PUT', url: `${url}/0/${number}`, headers: { ...resumeHeaders, 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash }, payload })
    assert.equal((await part(0, Buffer.alloc(CHUNK_BYTES, 65), '0'.repeat(64))).statusCode, 400)
    assert.equal((await part(0, Buffer.alloc(CHUNK_BYTES, 65))).statusCode, 200)
    assert.equal((await service.app.inject({ method: 'POST', url: `${url}/complete`, headers: resumeHeaders, payload: {} })).statusCode, 409)
    assert.equal(service.store.files().length, 0)
    await service.app.close(); service = await createApp(config, { serveFrontend: false })
    const status = await service.app.inject({ method: 'GET', url, headers: resumeHeaders })
    assert.equal(status.json().parts.length, 1)
    assert.equal((await part(0, Buffer.alloc(CHUNK_BYTES, 66))).statusCode, 409)
    assert.equal((await part(1, Buffer.from('集屿'))).statusCode, 200)
    const complete = await service.app.inject({ method: 'POST', url: `${url}/complete`, headers: resumeHeaders, payload: {} })
    assert.equal(complete.statusCode, 201, complete.body)
    assert.equal(complete.json().filesCount, 2)
    assert.equal((await service.app.inject({ method: 'POST', url: `${url}/complete`, headers: resumeHeaders, payload: {} })).json().receiptId, complete.json().receiptId)
    assert.equal((await service.app.inject({ method: 'GET', url, headers: resumeHeaders })).json().receipt.receiptId, complete.json().receiptId)
    assert.equal(service.store.pendingBytes(), 0)
    assert.deepEqual(await readdir(join(config.dataDir, 'chunks')), [])
    assert.equal(service.store.files().find(f => f.size)?.sha256, createHash('sha256').update(Buffer.alloc(CHUNK_BYTES, 65)).update('集屿').digest('hex'))
    assert.equal(service.store.collection(c.id)!.received, 2)
    const original = service.store.collection(c.id)!
    for (const stopped of [{ ...original, status: 'paused' as const }, { ...original, deadline: '2020-01-01' }]) {
      service.store.saveCollection(stopped)
      assert.equal((await service.app.inject({ method: 'GET', url, headers: resumeHeaders })).json().receipt.receiptId, complete.json().receiptId)
      assert.equal((await service.app.inject({ method: 'POST', url, headers: resumeHeaders, payload: draft })).json().receipt.receiptId, complete.json().receiptId)
      assert.equal((await service.app.inject({ method: 'POST', url: `${url}/complete`, headers: resumeHeaders, payload: {} })).json().receiptId, complete.json().receiptId)
      assert.equal((await service.app.inject({ method: 'GET', url, headers: { 'x-upload-key': 'z'.repeat(64) } })).statusCode, 403)
      assert.equal((await service.app.inject({ method: 'POST', url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`, headers: resumeHeaders, payload: draft })).statusCode, 410)
    }
    service.store.saveCollection(original)
    const freshUrl = `/api/public/${c.uploadToken}/uploads/${randomUUID()}`
    const freshDraft = { owner: '过期', files: [{ name: 'a.txt', size: 10, lastModified: 2 }] }
    await service.app.inject({ method: 'POST', url: freshUrl, headers: resumeHeaders, payload: freshDraft })
    const freshId = freshUrl.split('/').at(-1)!
    service.store.db.prepare('UPDATE uploads SET expires=? WHERE id=?').run(Date.now() - 1, freshId)
    assert.equal((await service.app.inject({ method: 'GET', url: freshUrl, headers: resumeHeaders })).statusCode, 410)
  } finally { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
