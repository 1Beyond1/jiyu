import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createApp } from './app.ts'
import { DriveStorage } from './drive-storage.ts'
import type { RemoteHTTP, RemoteRequest } from './remote-http.ts'
import type { StorageProfile } from '../src/types.ts'

test('Microsoft/Google OAuth 使用 PKCE 和一次性状态，回调不依赖跨站会话 Cookie', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'drive-oauth-test-'))
  const captures: RemoteRequest[] = []
  const http: RemoteHTTP = async req => { captures.push(req); return { status: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify(req.url.pathname.endsWith('/token') ? { access_token: 'fixture-drive-access', refresh_token: 'fixture-drive-refresh', expires_in: 3600 } : { id: 'fixture-drive' }))]) } }
  const origin = 'http://127.0.0.1:3000'
  const { app, store } = await createApp({ dataDir: join(dir, 'data'), origin, host: '127.0.0.1', port: 3000, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }, { serveFrontend: false, storageHTTP: http })
  try {
    const init = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin }, payload: { setupToken: store.setupToken(), displayName: 'OAuth 测试', password: 'test-drive-password' } })
    const headers = { origin, cookie: init.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': init.json().csrf }
    for (const id of ['onedrive', 'gdrive']) {
      const profile = await app.inject({ method: 'PUT', url: `/api/storage/connections/${id}`, headers, payload: { root: '/集屿', clientId: 'fixture-client-id', credentials: { clientSecret: 'fixture-client-secret' } } })
      assert.equal(profile.statusCode, 200, profile.body)
      const begin = await app.inject({ method: 'POST', url: `/api/storage/oauth/${id}/authorize`, headers, payload: { revision: profile.json().revision } })
      assert.equal(begin.statusCode, 200, begin.body)
      const auth = new URL(begin.json().authorizationUrl), state = auth.searchParams.get('state')!
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(auth.searchParams.get('redirect_uri'), `${origin}/api/storage/oauth/${id}/callback`)
      assert.equal((await app.inject({ method: 'GET', url: `/api/storage/oauth/${id}/callback?state=wrong&code=fixture-code` })).statusCode, 410)
      const result = await app.inject({ method: 'GET', url: `/api/storage/oauth/${id}/callback?${new URLSearchParams({ state, code: 'fixture-code' })}` })
      assert.equal(result.statusCode, 200, result.body); assert.match(result.body, /授权已完成/)
      assert.equal(result.body.includes('fixture-drive-access'), false)
      const token = captures.at(-1)!, form = new URLSearchParams((token.body as Buffer).toString())
      assert.equal(form.get('grant_type'), 'authorization_code')
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), auth.searchParams.get('code_challenge'))
      assert.equal((await app.inject({ method: 'GET', url: `/api/storage/oauth/${id}/callback?${new URLSearchParams({ state, code: 'fixture-code' })}` })).statusCode, 410)
      const saved = JSON.parse(store.get(`storage.${id}`)!)
      assert.equal(saved.enabled, false); assert.notEqual(saved.revision, profile.json().revision); assert.equal(JSON.stringify(saved).includes('fixture-drive-access'), false)
      const connections = await app.inject({ method: 'GET', url: '/api/storage/connections', headers })
      assert.equal(connections.json().profiles.find((p: StorageProfile) => p.id === id).authorized, true)
      assert.equal(connections.json().callbackUrls[id], `${origin}/api/storage/oauth/${id}/callback`)
      assert.equal(connections.body.includes('fixture-drive-access'), false)
    }
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})

for (const provider of ['onedrive', 'gdrive'] as const) test(`${provider} 原生分片上传、云端读回和重试去重`, async () => {
  const bytes = Buffer.alloc(8 * 1024 ** 2 + 10, 65), uploaded: Buffer[] = []; let present = false
  const requests: RemoteRequest[] = []
  const http: RemoteHTTP = async req => {
    requests.push(req)
    let status = 200, value: unknown = {}, headers: Record<string, string> = {}, raw: Buffer | undefined
    if (req.url.hostname === 'upload.up.1drv.com' || req.url.pathname === '/session') { uploaded.push(req.body as Buffer); if (uploaded.reduce((s, b) => s + b.length, 0) === bytes.length) { present = true; value = { id: 'file-id', size: bytes.length } } else { status = provider === 'onedrive' ? 202 : 308; value = { nextExpectedRanges: ['3276800-'] } } }
    else if (req.url.pathname.endsWith('/createUploadSession')) value = { uploadUrl: 'https://upload.up.1drv.com/session' }
    else if (req.url.pathname.startsWith('/upload/drive/')) headers = { location: 'https://www.googleapis.com/session' }
    else if (req.url.pathname.endsWith('/content') || req.url.searchParams.get('alt') === 'media') raw = bytes
    else if (provider === 'onedrive') { if (req.url.pathname.includes('file_')) { if (present) value = { id: 'file-id', size: bytes.length }; else status = 404 } else value = { id: 'folder-id', folder: {} } }
    else if (req.method === 'POST') value = { id: 'folder-id' }
    else { const q = req.url.searchParams.get('q') || ''; value = { files: q.includes('mimeType=') ? [{ id: 'folder-id' }] : present ? [{ id: 'file-id', size: String(bytes.length) }] : [] } }
    return { status, headers, body: Readable.from([raw || Buffer.from(JSON.stringify(value))]) }
  }
  const profile: StorageProfile = { id: provider, endpoint: '', root: '/集屿', enabled: true, hasCredentials: true, revision: 'fixture' }
  const adapter = new DriveStorage(profile, { accessToken: 'fixture-bearer' }, http, new AbortController().signal)
  const hash = createHash('sha256').update(bytes).digest('hex')
  await adapter.put('/集屿/task/file_资料.txt', bytes, bytes.length, hash)
  assert.deepEqual(Buffer.concat(uploaded), bytes)
  assert.ok(uploaded.length > 1, '两种网盘均应经过非最终分片响应')
  const parts = uploaded.length; await adapter.put('/集屿/task/file_资料.txt', bytes, bytes.length, hash); assert.equal(uploaded.length, parts)
  assert.ok(requests.some(r => r.method === 'GET' && (r.url.pathname.endsWith('/content') || r.url.searchParams.get('alt') === 'media')))
  for (const req of requests.filter(r => r.url.hostname === 'upload.up.1drv.com')) assert.equal(req.headers?.authorization, undefined)
})
