import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import { createBackup, restoreBackup } from './backup.ts'
import type { Collection, UploadReceipt } from '../src/types.ts'
import type { Config } from './config.ts'
import { Store } from './store.ts'

test('schema 4 升级保留旧任务与设置，模板和回执表可用', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'schema5-test-'))
  let store = new Store(dir)
  try {
    store.set('fixture', '原设置')
    const oldTask: Collection = { id: randomUUID(), title: '旧任务', description: '', category: 'document', received: 0, target: 20, deadline: '2099-12-31', storage: 'local', status: 'active', formats: 'TXT', maxFileSizeMB: 100, maxFilesPerSubmission: 20 }
    store.saveCollection(oldTask)
    store.db.exec('DROP TABLE collection_templates; DROP TABLE submission_records; PRAGMA user_version=4;')
    store.close(); store = new Store(dir)
    assert.equal(store.get('fixture'), '原设置'); assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 5)
    assert.equal(store.collection(oldTask.id)?.title, '旧任务'); assert.equal(store.collection(oldTask.id)?.fields, undefined)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM collection_templates').get()!.n, 0)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM submission_records').get()!.n, 0)
  } finally { store.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})

test('收集字段、名单隐私、自动命名、私密回执替换、并发与模板备份闭环', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'workflow-test-'))
  const config: Config = { dataDir: join(dir, 'data'), host: '127.0.0.1', port: 3000, origin: 'http://127.0.0.1:3000', quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2, secureCookie: false }
  let service = await createApp(config, { serveFrontend: false })
  const origin = { origin: config.origin }, secret = 'a'.repeat(64)
  try {
    const setup = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers: origin, payload: { setupToken: service.store.setupToken(), password: 'test-workflow-password', displayName: '流程测试' } })
    let headers = { ...origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const draft = { title: '作业收集', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 10, maxTotalSizeMB: 1, fields: [{ id: 'field_student', label: '学号', required: true }, { id: 'field_class', label: '班级', required: false }], identityField: 'field_student', expectedSubmitters: ['A01', 'A02'], naming: { parts: ['field_student', 'owner', 'original'], separator: '_' }, submissionMode: 'single', allowReplacement: true }
    const created = await service.app.inject({ method: 'POST', url: '/api/collections', headers, payload: draft })
    assert.equal(created.statusCode, 200, created.body)
    let c = created.json().collections[0] as Collection
    const pub = await service.app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}` })
    assert.equal(pub.json().collection.expectedSubmitters, undefined); assert.equal(pub.json().collection.uploadToken, undefined)
    assert.equal((await service.app.inject({ method: 'POST', url: `/api/public/${c.uploadToken}/upload`, headers: origin, payload: {} })).statusCode, 400)
    const start = (owner = '小 / 屿', fields: Record<string, string> = { field_student: 'A01', field_class: '一班' }, replace?: { receiptId: string; key: string }) => {
      const url = `/api/public/${c.uploadToken}/uploads/${randomUUID()}`, h = { ...origin, 'x-upload-key': secret }
      return { url, h, request: service.app.inject({ method: 'POST', url, headers: h, payload: { owner, fields, ...(replace ? { replace } : {}), files: [{ name: '作业.txt', size: 3, lastModified: 1 }, { name: '作业.txt', size: 3, lastModified: 1 }] } }) }
    }
    const missing = start('未填', {}); assert.equal((await missing.request).statusCode, 400); assert.equal(service.store.pendingBytes(), 0)
    const first = start(); assert.equal((await first.request).statusCode, 200)
    async function chunks(b: ReturnType<typeof start>) { for (let i = 0; i < 2; i++) { const r = await service.app.inject({ method: 'PUT', url: `${b.url}/${i}/0`, headers: { ...b.h, 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update('abc').digest('hex') }, payload: Buffer.from('abc') }); assert.equal(r.statusCode, 200, r.body) } }
    const complete = (b: ReturnType<typeof start>) => service.app.inject({ method: 'POST', url: `${b.url}/complete`, headers: b.h, payload: {} })
    await chunks(first); const result = await complete(first); assert.equal(result.statusCode, 201, result.body)
    const receipt = result.json() as UploadReceipt
    assert.equal(receipt.editKey, undefined)
    assert.deepEqual(service.store.files().map(f => f.name).sort(), ['A01_小 - 屿_作业.txt', 'A01_小 - 屿_作业_2.txt'].sort())
    assert.equal(service.store.files()[0].originalName, '作业.txt')
    assert.equal((await complete(first)).json().receiptId, receipt.receiptId)
    const people = await service.app.inject({ method: 'GET', url: `/api/collections/${c.id}/participants`, headers })
    assert.equal(people.json().participants.find((p: { identity: string }) => p.identity === 'A01').duplicates, 1)
    assert.equal(people.json().participants.find((p: { identity: string }) => p.identity === 'A02').fileIds.length, 0)
    assert.equal((await start().request).statusCode, 409)
    assert.equal((await start('冒充', { field_student: 'A01' }, { receiptId: receipt.receiptId, key: 'z'.repeat(64) }).request).statusCode, 403)
    assert.equal((await start('串人', { field_student: 'A02' }, { receiptId: receipt.receiptId, key: secret }).request).statusCode, 403)
    const receiptUrl = `/api/public/${c.uploadToken}/receipts/${receipt.receiptId}`
    assert.equal((await service.app.inject({ method: 'GET', url: receiptUrl, headers: { 'x-receipt-key': 'z'.repeat(64) } })).statusCode, 403)
    assert.equal((await service.app.inject({ method: 'GET', url: receiptUrl, headers: { 'x-receipt-key': secret } })).json().files.length, 2)
    assert.equal((await service.app.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, headers, payload: { ...draft, identityField: 'owner' } })).statusCode, 409)
    const replaceA = start('小屿', { field_student: 'A01' }, { receiptId: receipt.receiptId, key: secret }), replaceB = start('小屿', { field_student: 'A01' }, { receiptId: receipt.receiptId, key: secret })
    assert.equal((await replaceA.request).statusCode, 200); assert.equal((await replaceB.request).statusCode, 200)
    const persistedBatch = service.store.db.prepare('SELECT data FROM uploads WHERE id=?').get(replaceA.url.split('/').at(-1)!) as { data: string }
    assert.equal(persistedBatch.data.includes(secret), false)
    await chunks(replaceA); await chunks(replaceB)
    const results = await Promise.all([complete(replaceA), complete(replaceB)])
    assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 409])
    assert.equal(service.store.files().filter(f => f.deletedAt).length, 2); assert.equal(service.store.files().filter(f => !f.deletedAt).length, 2); assert.equal(service.store.usedBytes(), 12)
    assert.equal((await readdir(join(config.dataDir, 'objects'))).length, 4)
    assert.equal((await service.app.inject({ method: 'GET', url: receiptUrl, headers: { 'x-receipt-key': secret } })).json().superseded, true)
    // Capture a rule change while chunks are in flight; no destructive side effects on failure.
    const currentReceipt = results.find(r => r.statusCode === 201)!.json() as UploadReceipt
    const blocked = start('小屿', { field_student: 'A01' }, { receiptId: currentReceipt.receiptId, key: secret }); assert.equal((await blocked.request).statusCode, 200); await chunks(blocked)
    const changed = await service.app.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, headers, payload: { ...draft, allowReplacement: false } }); assert.equal(changed.statusCode, 200)
    assert.equal((await complete(blocked)).statusCode, 403); assert.equal(service.store.files().filter(f => !f.deletedAt).length, 2)
    const template = await service.app.inject({ method: 'POST', url: '/api/templates', headers, payload: { name: '作业模板', collectionId: c.id } })
    assert.equal(template.statusCode, 200, template.body)
    const t = template.json(); for (const key of ['expectedSubmitters', 'uploadToken', 'storage', 'deadline', 'received', 'id']) assert.equal(t.rules[key], undefined)
    assert.equal(t.rules.fields.length, 2)
    assert.equal((await service.app.inject({ method: 'PATCH', url: `/api/templates/${t.id}`, headers, payload: { archived: true } })).json().archived, true)
    assert.equal((await service.app.inject({ method: 'PATCH', url: `/api/templates/${t.id}`, headers, payload: { archived: false } })).json().archived, false)
    await service.app.close(); await createBackup(config.dataDir, join(dir, 'backup')); await restoreBackup(join(dir, 'backup'), join(dir, 'restored'))
    const restored = new Store(join(dir, 'restored'))
    try { assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM collection_templates').get()!.n, 1); assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM submission_records').get()!.n, 2); assert.equal(restored.pendingBytes(), 0); assert.equal(restored.files().length, 4) } finally { restored.close() }
    const restoredService = await createApp({ ...config, dataDir: join(dir, 'restored') }, { serveFrontend: false })
    try {
      // Restore keeps receipt capabilities but revokes administrator sessions and unfinished batches.
      assert.equal((await restoredService.app.inject({ method: 'GET', url: '/api/templates', headers })).statusCode, 401)
      const recovered = await restoredService.app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}/receipts/${currentReceipt.receiptId}`, headers: { 'x-receipt-key': secret } })
      assert.equal(recovered.statusCode, 200, recovered.body)
      assert.equal(recovered.json().files.length, 2)
      assert.equal(recovered.json().superseded, false)
      assert.equal((await restoredService.app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}/receipts/${currentReceipt.receiptId}`, headers: { 'x-receipt-key': 'z'.repeat(64) } })).statusCode, 403)
      assert.equal((await restoredService.app.inject({ method: 'GET', url: blocked.url, headers: blocked.h })).statusCode, 410)
      assert.equal((await restoredService.app.inject({ method: 'GET', url: first.url, headers: first.h })).json().receipt.receiptId, receipt.receiptId)
    } finally { await restoredService.app.close() }
    service = await createApp(config, { serveFrontend: false })
    const login = await service.app.inject({ method: 'POST', url: '/api/auth/login', headers: origin, payload: { username: 'admin', password: 'test-workflow-password' } })
    headers = { ...origin, cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': login.json().csrf }
    c = service.store.collection(c.id)!
    assert.equal((await service.app.inject({ method: 'GET', url: `/api/collections/${c.id}/participants`, headers })).json().participants.length, 2)
  } finally { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
