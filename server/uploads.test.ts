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

test('调整字段顺序不打断续传，文件和字段值变化仍拒绝，完成时执行最新必填规则', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'resume-fields-test-'))
  const config: Config = { dataDir: join(dir, 'data'), host: '127.0.0.1', port: 3000, origin: 'http://127.0.0.1:3000', quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2, secureCookie: false }
  const service = await createApp(config, { serveFrontend: false })
  const origin = { origin: config.origin }
  try {
    const setup = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers: origin, payload: { setupToken: service.store.setupToken(), password: 'test-fields-password', displayName: '字段续传测试' } })
    const headers = { ...origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const fields = [{ id: 'field_student', label: '学号', required: true }, { id: 'field_class', label: '班级', required: false }]
    const rules = { title: '字段顺序', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 10, maxTotalSizeMB: 1, fields, identityField: 'field_student' }
    const created = await service.app.inject({ method: 'POST', url: '/api/collections', headers, payload: rules })
    assert.equal(created.statusCode, 200, created.body)
    const c = created.json().collections[0], url = `/api/public/${c.uploadToken}/uploads/${randomUUID()}`
    const uploadHeaders = { ...origin, 'x-upload-key': 'f'.repeat(64) }
    const draft = { owner: '小屿', fields: { field_student: 'A01', field_class: '一班' }, files: [{ name: 'a.txt', size: 3, lastModified: 1 }, { name: 'b.txt', size: 0, lastModified: 2 }] }
    const start = (payload = draft, h = uploadHeaders) => service.app.inject({ method: 'POST', url, headers: h, payload })
    assert.equal((await start()).statusCode, 200)
    const part = await service.app.inject({ method: 'PUT', url: `${url}/0/0`, headers: { ...uploadHeaders, 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update('abc').digest('hex') }, payload: Buffer.from('abc') })
    assert.equal(part.statusCode, 200, part.body)
    const reordered = await service.app.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, headers, payload: { ...rules, fields: [...fields].reverse() } })
    assert.equal(reordered.statusCode, 200, reordered.body)
    const resumed = await start()
    assert.equal(resumed.statusCode, 200, resumed.body)
    assert.equal(resumed.json().parts.length, 1)
    assert.equal((await start(draft, { ...uploadHeaders, 'x-upload-key': 'g'.repeat(64) })).statusCode, 403)
    for (const changed of [
      { ...draft, owner: '另一人' },
      { ...draft, fields: { ...draft.fields, field_student: 'A02' } },
      { ...draft, fields: { ...draft.fields, field_class: '二班' } },
      { ...draft, files: [...draft.files].reverse() },
      { ...draft, files: draft.files.map(f => ({ ...f, lastModified: 3 })) },
    ]) assert.equal((await start(changed)).statusCode, 409)
    const tightened = await service.app.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, headers, payload: { ...rules, fields: [...fields, { id: 'field_group', label: '小组', required: true }] } })
    assert.equal(tightened.statusCode, 200, tightened.body)
    assert.equal((await service.app.inject({ method: 'POST', url: `${url}/complete`, headers: uploadHeaders, payload: {} })).statusCode, 400)
    assert.equal(service.store.files().length, 0)
    assert.deepEqual(await readdir(join(config.dataDir, 'objects')), [])
    assert.equal(service.store.pendingBytes(), 3)
    await service.app.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, headers, payload: { ...rules, fields: [...fields].reverse() } })
    const completed = await service.app.inject({ method: 'POST', url: `${url}/complete`, headers: uploadHeaders, payload: {} })
    assert.equal(completed.statusCode, 201, completed.body)
    assert.equal(service.store.files().length, 2)
    assert.equal(service.store.files()[0].submissionFields?.field_student, 'A01')
  } finally { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
