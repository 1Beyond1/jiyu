import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile, rm, statfs } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { RemoteHTTP, RemoteRequest } from './remote-http.ts'
import { decrypt, encrypt } from './secrets.ts'
import { BaiduStorage } from './storage-adapters.ts'
import { storageSpace } from './storage-space.ts'

test('WebDAV/S3 完整校验、加密配置、云端队列、失败保留原件和安全重试', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'remote-storage-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }
  const objects = new Map<string, Buffer>(), requests: RemoteRequest[] = []; let corrupt = false
  const http: RemoteHTTP = async req => {
    requests.push(req)
    const key = req.url.href
    if (req.method === 'PUT') { const chunks: Buffer[] = []; if (Buffer.isBuffer(req.body)) chunks.push(req.body); else if (req.body) for await (const chunk of req.body) chunks.push(chunk); objects.set(key, Buffer.concat(chunks)) }
    if (req.method === 'DELETE') objects.delete(key)
    return { status: req.method === 'MKCOL' ? 201 : 200, headers: {}, body: Readable.from([req.method === 'GET' ? corrupt ? Buffer.from('damaged') : objects.get(key) || Buffer.alloc(0) : Buffer.alloc(0)]) }
  }
  const { app, store } = await createApp(config, { serveFrontend: false, storageHTTP: http })
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: store.setupToken(), displayName: '远端测试', password: 'test-storage-password' } })
    const headers = { origin: config.origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, headers, payload: url.endsWith('/test') ? { revision: JSON.parse(store.get(`storage.${url.split('/')[4]}`)!).revision, ...payload } : payload })
    const profile = { endpoint: 'https://dav.example.com/dav', username: 'test-user', root: '/集屿', credentials: { password: 'fixture-dav-password' } }
    const disk = (await call('GET', '/api/storage')).json()
    const nativeDisk = await statfs(config.dataDir)
    assert.equal(disk.totalBytes, nativeDisk.blocks * nativeDisk.bsize)
    assert.ok(Math.abs(disk.availableBytes - nativeDisk.bavail * nativeDisk.bsize) < 1024 ** 3)
    assert.equal(disk.quotaBytes, config.quotaBytes)
    assert.equal(disk.receiveRemainingBytes, Math.min(disk.quotaBytes, disk.availableBytes))
    assert.equal((await call('GET', '/api/storage/connections')).json().profiles.some((p: { id: string }) => p.id === 'quark'), false)
    assert.equal((await call('PUT', '/api/storage/connections/quark', profile)).statusCode, 400)
    assert.equal((await call('PUT', '/api/storage/connections/webdav', { ...profile, endpoint: 'https://127.0.0.1/dav' })).statusCode, 400)
    const saved = await call('PUT', '/api/storage/connections/webdav', profile)
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().enabled, false)
    assert.equal(store.get('storage.webdav')!.includes('fixture-dav-password'), false)
    assert.equal((await call('GET', '/api/storage/connections')).body.includes('fixture-dav-password'), false)
    const taskDraft = { title: '云端收集', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 2, storage: 'webdav' }
    assert.equal((await call('POST', '/api/collections', taskDraft)).statusCode, 400)
    const connected = await call('POST', '/api/storage/connections/webdav/test', {})
    assert.equal(connected.statusCode, 200, connected.body); assert.equal(connected.json().enabled, true)
    const unchanged = await call('PUT', '/api/storage/connections/webdav', { ...profile, credentials: {} })
    assert.equal(unchanged.json().revision, connected.json().revision, '未修改设置不能使待传输任务的连接版本失效')
    assert.equal(unchanged.json().enabled, true)
    assert.equal(objects.size, 0)
    assert.ok(requests.some(r => r.method === 'MKCOL' && r.url.pathname.endsWith('/')))
    const task = await call('POST', '/api/collections', taskDraft), id = randomUUID(), key = randomUUID(), bytes = Buffer.from('真实传输正文测试')
    await writeFile(join(config.dataDir, 'objects', key), bytes)
    store.addFile({ id, collectionId: task.json().collections[0].id, name: '资料.txt', owner: '小屿', size: bytes.length, createdAt: new Date().toISOString(), storage: 'webdav', status: 'pending', sha256: createHash('sha256').update(bytes).digest('hex') }, key)
    for (let n = 0; n < 200; n++) { if (store.files()[0].remoteStatus === 'ready') break; await new Promise(r => setTimeout(r, 10)) }
    assert.equal(store.files()[0].remoteStatus, 'ready')
    assert.deepEqual([...objects.values()][0], bytes)
    const secondId = randomUUID(), secondKey = randomUUID()
    await writeFile(join(config.dataDir, 'objects', secondKey), bytes)
    corrupt = true
    store.addFile({ ...store.files()[0], id: secondId, remoteStatus: 'queued', remotePath: undefined }, secondKey)
    for (let n = 0; n < 200; n++) { if (store.files().find(f => f.id === secondId)?.remoteStatus === 'failed') break; await new Promise(r => setTimeout(r, 10)) }
    assert.equal(store.files().find(f => f.id === secondId)?.remoteStatus, 'failed')
    assert.equal((await call('GET', `/api/files/${secondId}/download`)).rawPayload.toString(), bytes.toString())
    corrupt = false
    const retried = await call('POST', '/api/storage/transfers/retry', { ids: [secondId, secondId, id] })
    assert.equal(retried.statusCode, 200); assert.equal(retried.json().retried, 1, '只重试失败项，并去重；成功项不重复传输')
    for (let n = 0; n < 200; n++) { if (store.files().find(f => f.id === secondId)?.remoteStatus === 'ready') break; await new Promise(r => setTimeout(r, 10)) }
    assert.equal(store.files().find(f => f.id === secondId)?.remoteStatus, 'ready')
    corrupt = true
    assert.equal((await call('POST', '/api/storage/connections/webdav/test', {})).statusCode, 502)
    assert.equal((await call('GET', '/api/storage/connections')).json().profiles.find((p: { id: string }) => p.id === 'webdav').enabled, false)
    corrupt = false
    assert.equal((await call('PUT', '/api/storage/connections/webdav', { ...profile, endpoint: 'https://elsewhere.example/dav', credentials: {} })).statusCode, 400)
    const s3 = await call('PUT', '/api/storage/connections/s3', { endpoint: 'https://s3.example.com', root: '/jiyu', bucket: 'jiyu-files', region: 'us-east-1', credentials: { accessKeyId: 'fixture-key-id', secretAccessKey: 'fixture-secret-key' } })
    assert.equal(s3.statusCode, 200, s3.body)
    assert.equal((await call('POST', '/api/storage/connections/s3/test', {})).statusCode, 200)
    const put = requests.find(r => r.url.hostname === 's3.example.com' && r.method === 'PUT')!
    assert.match(put.url.pathname, /^\/jiyu-files\/jiyu\//)
    assert.match(put.headers!.authorization, /^AWS4-HMAC-SHA256 Credential=fixture-key-id\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/)
    assert.equal(put.headers!['x-amz-content-sha256'], createHash('sha256').update(put.body as Buffer).digest('hex'))
    assert.equal((await call('POST', '/api/storage/connections/webdav/disable', {})).statusCode, 200)
    assert.equal((await call('POST', '/api/collections', taskDraft)).statusCode, 400)
    // Historical removed-provider records stay readable through the retained local copy.
    const oldTask = task.json().collections[0]
    store.db.prepare("UPDATE collections SET data=json_set(data,'$.storage','quark') WHERE id=?").run(oldTask.id)
    store.db.prepare("UPDATE files SET data=json_set(data,'$.storage','quark') WHERE id=?").run(id)
    store.set('storage.quark', JSON.stringify({ ...connected.json(), id: 'quark', revision: 'legacy', enabled: true }))
    store.db.prepare("UPDATE remote_transfers SET provider='quark',state='queued',revision='legacy' WHERE file_id=?").run(id)
    assert.equal(store.byToken(oldTask.uploadToken)?.storage, 'local')
    assert.equal(store.files().find(f => f.id === id)?.storage, 'local')
    const before = requests.length
    for (let n = 0; n < 200; n++) { if (store.files().find(f => f.id === id)?.remoteStatus === 'failed') break; await new Promise(r => setTimeout(r, 10)) }
    assert.equal(requests.length, before, '移除的平台不能再发起云端请求')
    assert.equal((await call('GET', `/api/files/${id}/download`)).rawPayload.toString(), bytes.toString())
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})

test('百度官方分片协议只提交必要分片，并验证分片 MD5 和合并结果', async () => {
  const bytes = Buffer.alloc(4 * 1024 ** 2 + 10, 65), partHashes = [bytes.subarray(0, 4 * 1024 ** 2), bytes.subarray(4 * 1024 ** 2)].map(b => createHash('md5').update(b).digest('hex'))
  const path = '/apps/fixture/集屿/collection/file_资料.txt'; let received = 0
  const http: RemoteHTTP = async req => {
    let result: object = { errno: 0 }
    if (req.url.searchParams.get('method') === 'precreate') { const form = new URLSearchParams((req.body as Buffer).toString()); assert.deepEqual(JSON.parse(form.get('block_list')!), partHashes); result = { errno: 0, uploadid: 'fixture-upload-id', block_list: [1] } }
    else if (req.url.pathname.endsWith('/superfile2')) { received++; assert.equal(req.url.hostname, 'd.pcs.baidu.com'); assert.equal(req.url.searchParams.get('partseq'), '1'); assert.ok((req.body as Buffer).includes(bytes.subarray(4 * 1024 ** 2))); result = { md5: partHashes[1] } }
    else if (req.url.searchParams.get('method') === 'create') { const form = new URLSearchParams((req.body as Buffer).toString()); if (form.get('isdir') === '0') result = { errno: 0, path, size: bytes.length, fs_id: 123 } }
    return { status: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify(result))]) }
  }
  const adapter = new BaiduStorage({ id: 'baidu', endpoint: 'https://pan.baidu.com', root: '/apps/fixture/集屿', hasCredentials: true, enabled: true, revision: 'fixture' }, { accessToken: 'fixture-token' }, http, new AbortController().signal)
  const result = await adapter.put(path, bytes, bytes.length, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(received, 1); assert.equal(result.path, path)
})

test('百度设备授权不回显令牌，应用配置改变后旧授权不可复用', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'baidu-auth-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }
  const http: RemoteHTTP = async req => { const value = req.url.pathname.endsWith('/device/code') ? { device_code: 'fixture-device-secret', user_code: 'ABCD', verification_url: 'https://openapi.baidu.com/device', expires_in: 1800, interval: 5 } : req.url.pathname.endsWith('/token') ? { access_token: 'fixture-baidu-access-token', refresh_token: 'fixture-refresh-secret', expires_in: 3600 } : { errno: 0, baidu_name: '测试账号' }; return { status: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify(value))]) } }
  const { app, store } = await createApp(config, { serveFrontend: false, storageHTTP: http })
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: store.setupToken(), displayName: '百度测试', password: 'test-baidu-password' } })
    const headers = { origin: config.origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, headers, payload: url.endsWith('/test') ? { revision: JSON.parse(store.get(`storage.${url.split('/')[4]}`)!).revision, ...payload } : payload })
    const profile = { root: '/apps/fixture/集屿', clientId: 'fixture-app', credentials: { clientSecret: 'fixture-client-secret' } }
    assert.equal((await call('PUT', '/api/storage/connections/baidu', profile)).statusCode, 200)
    const auth = await call('POST', '/api/storage/baidu/authorize', { revision: JSON.parse(store.get('storage.baidu')!).revision })
    assert.equal(auth.statusCode, 200); assert.equal(auth.json().userCode, 'ABCD'); assert.equal(auth.body.includes('fixture-device-secret'), false)
    assert.equal((await call('POST', `/api/storage/baidu/authorize/${auth.json().id}`, {})).json().pending, true)
    const row = store.db.prepare('SELECT data FROM storage_oauth WHERE id=?').get(auth.json().id) as { data: string }
    const data = JSON.parse(decrypt(store, row.data)); data.nextPoll = 0; store.db.prepare('UPDATE storage_oauth SET data=? WHERE id=?').run(encrypt(store, JSON.stringify(data)), auth.json().id)
    const authorized = await call('POST', `/api/storage/baidu/authorize/${auth.json().id}`, {})
    assert.equal(authorized.json().authorized, true); assert.equal(authorized.body.includes('fixture-baidu-access-token'), false)
    assert.equal(store.get('storage.baidu')!.includes('fixture-baidu-access-token'), false)
    assert.equal((await call('POST', '/api/storage/connections/baidu/test', {})).statusCode, 200)
    const again = await call('POST', '/api/storage/baidu/authorize', { revision: JSON.parse(store.get('storage.baidu')!).revision })
    await call('PUT', '/api/storage/connections/baidu', { ...profile, root: '/apps/fixture/新目录' })
    assert.equal((await call('POST', `/api/storage/baidu/authorize/${again.json().id}`, {})).statusCode, 409)
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})

test('容量区分工作台配额、上传预留和数据磁盘；读取失败不冒充零容量', async () => {
  const native = await statfs(resolve('.artifacts'))
  const disk = async () => ({ ...native, blocks: 100, bavail: 30, bsize: 1024 })
  const constrained = await storageSpace('.', 20 * 1024, 100 * 1024, 10 * 1024, disk)
  assert.equal(constrained.quotaRemainingBytes, 70 * 1024)
  assert.equal(constrained.receiveRemainingBytes, 30 * 1024)
  assert.equal(constrained.totalBytes, 100 * 1024)
  const full = await storageSpace('.', 100, 100, 20, disk)
  assert.equal(full.receiveRemainingBytes, 0)
  const unavailable = await storageSpace('.', 20, 100, 10, async () => { throw new Error('unavailable') })
  assert.equal(unavailable.quotaRemainingBytes, 70)
  assert.equal(unavailable.availableBytes, null)
  assert.equal(unavailable.receiveRemainingBytes, null)
  assert.ok(unavailable.diskError)
})
