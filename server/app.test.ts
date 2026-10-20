import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, rm, appendFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createApp } from './app.ts'
import { createBackup, restoreBackup, pruneTrash } from './backup.ts'
import type { Config } from './config.ts'
import type { Workspace, Collection } from '../src/types.ts'

test('真实文件服务：认证、隔离、限额、整理、持久化、备份恢复', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'server-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', port: 3000, host: '127.0.0.1', quotaBytes: 2 * 1024 ** 2, requestBytes: 2 * 1024 ** 2, secureCookie: false }
  let service = await createApp(config, { serveFrontend: false })
  let cookie = '', csrf = ''
  const request = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, auth = true, extra = {}) => service.app.inject({ method, url, payload, headers: { origin: config.origin, ...(auth ? { cookie, 'x-csrf-token': csrf } : {}), ...extra } })
  const fileBytes = Buffer.from('%PDF-1.4\n集屿真实字节校验\n%%EOF')
  const upload = (uploadToken: string, entries = [{ name: '资料.pdf', bytes: fileBytes }], id = randomUUID()) => {
    const boundary = 'jiyu-test-boundary'
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="owner"\r\n\r\n测试用户\r\n`), ...entries.flatMap(f => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.bytes, Buffer.from('\r\n')]), Buffer.from(`--${boundary}--\r\n`)])
    return service.app.inject({ method: 'POST', url: `/api/public/${uploadToken}/upload`, headers: { origin: config.origin, 'content-type': `multipart/form-data; boundary=${boundary}`, 'idempotency-key': id }, payload })
  }
  try {
    assert.equal((await request('GET', '/api/workspace', undefined, false)).statusCode, 401)
    assert.equal((await request('POST', '/api/auth/setup', { setupToken: 'wrong', displayName: '管理者', password: 'test-password-12345' }, false)).statusCode, 403)
    const setup = await request('POST', '/api/auth/setup', { setupToken: service.store.setupToken(), displayName: '管理者', password: 'test-password-12345' }, false)
    assert.equal(setup.statusCode, 200, setup.body)
    cookie = setup.headers['set-cookie']!.toString().split(';')[0]; csrf = setup.json().csrf
    assert.match(setup.headers['set-cookie']!.toString(), /HttpOnly/)
    assert.equal((await request('POST', '/api/collections', {}, true, { origin: 'https://evil.invalid' })).statusCode, 403)
    assert.equal((await request('POST', '/api/collections', {}, true, { 'x-csrf-token': '' })).statusCode, 403)
    assert.equal((await request('GET', '/api/workspace')).json().collections.length, 0)
    const draft = { title: '真实资料', description: '集成验证', category: 'document', target: 1, deadline: '2099-12-31', formats: 'PDF, TXT', maxFileSizeMB: 1, maxFilesPerSubmission: 2, maxTotalSizeMB: 1 }
    const created = await request('POST', '/api/collections', draft)
    assert.equal(created.statusCode, 200, created.body)
    let workspace = created.json() as Workspace
    let collection = workspace.collections[0] as Collection
    assert.ok(collection.uploadToken && collection.uploadToken !== collection.id)
    const publicInfo = (await request('GET', `/api/public/${collection.uploadToken}`, undefined, false)).json()
    assert.equal(publicInfo.collection.uploadToken, undefined)
    assert.equal(publicInfo.files, undefined)
    assert.equal((await request('GET', `/api/public/${collection.id}`, undefined, false)).statusCode, 404)
    assert.equal((await upload(collection.uploadToken!, [{ name: '../escape.pdf', bytes: fileBytes }])).statusCode, 400)
    assert.equal((await upload(collection.uploadToken!, [{ name: '恶意.exe', bytes: fileBytes }])).statusCode, 400)
    assert.equal((await upload(collection.uploadToken!, [{ name: '大文件.pdf', bytes: Buffer.alloc(1024 ** 2 + 1) }])).statusCode, 413)
    assert.equal((await upload(collection.uploadToken!, Array.from({ length: 3 }, (_, i) => ({ name: `${i}.pdf`, bytes: fileBytes })))).statusCode, 413)
    assert.equal(service.store.files().length, 0)
    assert.deepEqual(await readdir(join(config.dataDir, 'tmp')), [])
    const requestId = randomUUID(), uploaded = await upload(collection.uploadToken!, undefined, requestId)
    assert.equal(uploaded.statusCode, 201, uploaded.body)
    assert.equal((await upload(collection.uploadToken!, undefined, requestId)).json().receiptId, uploaded.json().receiptId)
    workspace = (await request('GET', '/api/workspace')).json()
    assert.equal(workspace.files.length, 1)
    assert.equal(workspace.collections[0].received, 1)
    const file = workspace.files[0]
    assert.equal(file.name, '资料.pdf')
    assert.equal(file.sha256, createHash('sha256').update(fileBytes).digest('hex'))
    assert.equal((await request('GET', `/api/files/${file.id}/download`, undefined, false)).statusCode, 401)
    const downloaded = await request('GET', `/api/files/${file.id}/download`)
    assert.deepEqual(downloaded.rawPayload, fileBytes)
    assert.match(downloaded.headers['content-disposition']!.toString(), /attachment/)
    assert.equal(downloaded.headers['content-type'], 'application/octet-stream')
    const renamed = await request('POST', '/api/files/rename', { changes: [{ id: file.id, oldName: file.name, name: '整理_01.pdf' }] })
    assert.equal(renamed.statusCode, 200, renamed.body)
    assert.equal(renamed.json().workspace.files[0].name, '整理_01.pdf')
    assert.equal((await request('POST', `/api/files/rename/${renamed.json().operationId}/undo`, {})).json().files[0].name, file.name)
    assert.equal((await request('POST', '/api/files/rename', { changes: [{ id: file.id, oldName: 'stale.pdf', name: 'new.pdf' }] })).statusCode, 409)
    assert.equal((await request('POST', '/api/files/review', { ids: [file.id] })).json().files[0].status, 'ready')
    assert.equal((await request('POST', '/api/files/trash', { ids: [file.id] })).json().trash.length, 1)
    assert.equal((await request('GET', `/api/files/${file.id}/download`)).statusCode, 404)
    assert.equal((await request('POST', '/api/files/restore', { ids: [file.id] })).json().files.length, 1)
    assert.equal((await request('POST', `/api/collections/${collection.id}/status`, { status: 'paused' })).statusCode, 200)
    assert.equal((await upload(collection.uploadToken!)).statusCode, 410)
    await request('POST', `/api/collections/${collection.id}/status`, { status: 'active' })
    const rotated = await request('POST', `/api/collections/${collection.id}/rotate-token`, {})
    assert.equal((await request('GET', `/api/public/${collection.uploadToken}`, undefined, false)).statusCode, 404)
    collection = rotated.json().collections[0]
    assert.equal((await upload(collection.uploadToken!, [{ name: '第二份.txt', bytes: Buffer.alloc(1024 ** 2) }])).statusCode, 413)
    assert.equal(service.store.files().length, 1)
    await assert.rejects(createBackup(config.dataDir, join(dir, 'locked-backup')), /正被使用/)
    await service.app.close()
    service = await createApp(config, { serveFrontend: false })
    assert.equal((await request('GET', '/api/workspace')).json().files.length, 1)
    await service.app.close()
    const backupDir = join(dir, 'backup'), restoredDir = join(dir, 'restored')
    assert.equal((await createBackup(config.dataDir, backupDir)).files, 1)
    assert.equal((await restoreBackup(backupDir, restoredDir)).files, 1)
    service = await createApp({ ...config, dataDir: restoredDir }, { serveFrontend: false })
    assert.equal((await request('GET', '/api/workspace')).statusCode, 401)
    const login = await request('POST', '/api/auth/login', { password: 'test-password-12345' }, false)
    cookie = login.headers['set-cookie']!.toString().split(';')[0]; csrf = login.json().csrf
    assert.deepEqual((await request('GET', `/api/files/${file.id}/download`)).rawPayload, fileBytes)
    await appendFile(join(backupDir, 'objects', service.store.fileKey(file.id)!), 'tamper')
    await assert.rejects(restoreBackup(backupDir, join(dir, 'bad-restore')), /校验失败/)
    const oldCookie = cookie
    const passwordChange = await request('POST', '/api/auth/password', { currentPassword: 'test-password-12345', password: 'new-test-password-2026' })
    assert.equal(passwordChange.statusCode, 200)
    cookie = passwordChange.headers['set-cookie']!.toString().split(';')[0]; csrf = passwordChange.json().csrf
    assert.equal((await request('GET', '/api/workspace', undefined, true, { cookie: oldCookie })).statusCode, 401)
    assert.equal((await request('GET', '/api/workspace')).statusCode, 200)
    await request('POST', '/api/files/trash', { ids: [file.id] })
    await service.app.close()
    assert.equal((await pruneTrash(restoredDir, join(dir, 'before-prune'))).files, 1)
    service = await createApp({ ...config, dataDir: restoredDir }, { serveFrontend: false })
    assert.equal(service.store.files().length, 0)
    assert.deepEqual(await readdir(join(restoredDir, 'objects')), [])
    assert.equal((await restoreBackup(join(dir, 'before-prune'), join(dir, 'prune-recovered'))).files, 1)
  } finally {
    await service.app.close()
    const child = relative(root, dir)
    if (child && !child.startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})

test('并发上传预留配额，超限批次不留下正文或数据库记录', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'quota-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', port: 3000, host: '127.0.0.1', quotaBytes: 1024 ** 2, requestBytes: 2 * 1024 ** 2, secureCookie: false }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const init = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: store.setupToken(), password: 'quota-test-password', displayName: '配额测试' } })
    const headers = { origin: config.origin, cookie: init.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': init.json().csrf }
    const created = await app.inject({ method: 'POST', url: '/api/collections', headers, payload: { title: '配额测试', description: '', category: 'document', target: 10, deadline: '2099-12-31', formats: 'PDF', maxFileSizeMB: 1, maxFilesPerSubmission: 2, maxTotalSizeMB: 10 } })
    const collection = created.json().collections[0]
    const oversizedChunked = await app.inject({ method: 'POST', url: `/api/public/${collection.uploadToken}/upload`, headers: { origin: config.origin, 'idempotency-key': randomUUID(), 'content-type': 'multipart/form-data; boundary=quota', 'transfer-encoding': 'chunked' }, payload: Readable.from([Buffer.alloc(5 * 1024 ** 2), Buffer.from('\r\n--quota--\r\n')]) })
    assert.equal(oversizedChunked.statusCode, 413)
    const upload = (name: string) => app.inject({ method: 'POST', url: `/api/public/${collection.uploadToken}/upload`, headers: { origin: config.origin, 'idempotency-key': randomUUID(), 'content-type': 'multipart/form-data; boundary=quota' }, payload: Buffer.concat([Buffer.from(`--quota\r\nContent-Disposition: form-data; name="owner"\r\n\r\nTest\r\n--quota\r\nContent-Disposition: form-data; name="files"; filename="${name}.pdf"\r\n\r\n`), Buffer.alloc(700 * 1024), Buffer.from('\r\n--quota--\r\n')]) })
    const responses = await Promise.all([upload('first'), upload('second')])
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 413])
    assert.equal(store.files().length, 1)
    assert.equal(store.usedBytes(), 700 * 1024)
    assert.equal((await readdir(join(config.dataDir, 'objects'))).length, 1)
    assert.deepEqual(await readdir(join(config.dataDir, 'tmp')), [])
    const tinyUpload = () => app.inject({ method: 'POST', url: `/api/public/${collection.uploadToken}/upload`, headers: { origin: config.origin, 'idempotency-key': randomUUID(), 'content-type': 'multipart/form-data; boundary=quota' }, payload: Buffer.from('--quota\r\nContent-Disposition: form-data; name="owner"\r\n\r\nTest\r\n--quota\r\nContent-Disposition: form-data; name="files"; filename="tiny.pdf"\r\n\r\nabc\r\n--quota--\r\n') })
    assert.deepEqual((await Promise.all([tinyUpload(), tinyUpload()])).map(r => r.statusCode), [201, 201])
    assert.equal(store.collection(collection.id)!.received, 3)
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
