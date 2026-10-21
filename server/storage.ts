import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { encrypt, decrypt } from './secrets.ts'
import type { Store } from './store.ts'
import type { StorageProfile, StorageId, TransferInfo } from '../src/types.ts'
import { cloudStorageIds } from '../src/types.ts'
import { HttpError, object, text } from './security.ts'
import { endpointBase } from './ai.ts'
import { remoteHTTP, remoteBody, remoteOK } from './remote-http.ts'
import type { RemoteHTTP } from './remote-http.ts'
import { StandardStorage, BaiduStorage } from './storage-adapters.ts'
import type { StorageCredentials } from './storage-adapters.ts'
import { DriveStorage } from './drive-storage.ts'
import { exchangeToken, registerDriveOAuth } from './drive-oauth.ts'

type Provider = StorageProfile['id']
interface SavedProfile extends Omit<StorageProfile, 'hasCredentials'> { encryptedCredentials?: string }
const providers: readonly Provider[] = cloudStorageIds
const implemented = new Set<Provider>(providers)
export function storageProfile(store: Store, provider: Provider) { const value = store.get(`storage.${provider}`); return value ? JSON.parse(value) as SavedProfile : undefined }
export function requireStorage(store: Store, value: unknown): StorageId {
  if (value === undefined || value === 'local') return 'local'
  const id = String(value) as Provider, profile = storageProfile(store, id)
  if (!implemented.has(id) || !profile?.enabled || !profile.verifiedAt) throw new HttpError(400, '请先在存储空间配置并验证所选连接')
  return id
}
function rootInput(value: unknown) {
  const root = text(value, '目标目录', 300)
  if (root.includes('\\') || root.split('/').some(s => s === '.' || s === '..') || /[\x00-\x1f<>?|#%]/.test(root)) throw new HttpError(400, '目标目录包含无效路径字符')
  return '/' + root.split('/').filter(Boolean).join('/')
}

export function registerStorage(app: FastifyInstance, store: Store, http: RemoteHTTP = remoteHTTP, origin = 'http://127.0.0.1:3000') {
  let running: Promise<void> | undefined, stopping = false, testing = false
  const controller = new AbortController()
  const credentials = (p: SavedProfile) => p.encryptedCredentials ? JSON.parse(decrypt(store, p.encryptedCredentials)) as StorageCredentials : {}
  const safe = (p: SavedProfile): StorageProfile => {
    const { encryptedCredentials, ...data } = p
    let authorized = false
    if (['baidu', 'onedrive', 'gdrive'].includes(p.id)) { try { authorized = !!credentials(p).accessToken } catch { /* Re-enter credentials if the master key is unavailable. */ } }
    return { ...data, hasCredentials: !!encryptedCredentials, authorized }
  }
  const profiles = () => providers.map(id => { const p = storageProfile(store, id); return p ? safe(p) : { id, endpoint: '', root: '/集屿', enabled: false, hasCredentials: false, revision: '' } })
  const get = (id: unknown) => { if (!providers.includes(String(id) as Provider)) throw new HttpError(400, '存储类型无效'); const profile = storageProfile(store, String(id) as Provider); if (!profile) throw new HttpError(400, '请先保存连接设置'); return profile }
  const saveCredentials = (p: SavedProfile, value: StorageCredentials, reauthorize = false) => { const current = get(p.id); if (current.revision !== p.revision) throw new HttpError(409, '连接设置已变更，请重新操作'); const saved = { ...current, ...(reauthorize ? { enabled: false, verifiedAt: undefined, revision: randomUUID() } : {}), encryptedCredentials: encrypt(store, JSON.stringify(value)) }; store.set(`storage.${p.id}`, JSON.stringify(saved)); return saved }
  const refresh = async (p: SavedProfile) => {
    const c = credentials(p)
    if ((p.id === 'onedrive' || p.id === 'gdrive') && !p.via && (!c.accessToken || (c.expiresAt && c.expiresAt < Date.now() + 60000))) {
      if (!c.refreshToken || !c.clientSecret || !p.clientId) throw new HttpError(400, '网盘授权已过期，请重新连接')
      const fresh = await exchangeToken(http, p.id, { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: p.clientId, client_secret: c.clientSecret, ...(p.id === 'onedrive' ? { scope: 'offline_access https://graph.microsoft.com/Files.ReadWrite' } : {}) }, controller.signal)
      Object.assign(c, { ...fresh, refreshToken: fresh.refreshToken || c.refreshToken }); saveCredentials(p, c)
    }
    if (p.id === 'baidu' && (!c.accessToken || (c.expiresAt && c.expiresAt < Date.now() + 60000))) {
      if (!c.refreshToken || !c.clientSecret || !p.clientId) throw new HttpError(400, '百度授权已过期，请重新连接')
      const url = new URL('https://openapi.baidu.com/oauth/2.0/token')
      url.search = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: p.clientId, client_secret: c.clientSecret }).toString()
      const response = await http({ url, method: 'GET', signal: controller.signal }); remoteOK(response)
      const result = JSON.parse((await remoteBody(response)).toString())
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in)) throw new HttpError(502, '百度授权刷新失败，请重新连接')
      Object.assign(c, { accessToken: result.access_token, refreshToken: result.refresh_token || c.refreshToken, expiresAt: Date.now() + result.expires_in * 1000 })
      saveCredentials(p, c)
    }
    return c
  }
  const adapter = (p: SavedProfile, c: StorageCredentials) => p.id === 'baidu' ? new BaiduStorage(safe(p), c, http, controller.signal) : (p.id === 'onedrive' || p.id === 'gdrive') && !p.via ? new DriveStorage(safe(p), c, http, controller.signal) : new StandardStorage(safe(p), c, http, controller.signal)
  registerDriveOAuth(app, store, { origin, http, signal: controller.signal, get, credentials, save: saveCredentials })
  app.get('/api/storage/connections', async () => ({ profiles: profiles(), supported: [...implemented], callbackUrls: { onedrive: `${origin}/api/storage/oauth/onedrive/callback`, gdrive: `${origin}/api/storage/oauth/gdrive/callback` }, transfers: store.db.prepare('SELECT * FROM remote_transfers ORDER BY updated_at DESC LIMIT 100').all() }))
  app.put('/api/storage/connections/:id', async req => {
    const id = String(object(req.params).id) as Provider, body = object(req.body)
    if (!implemented.has(id)) throw new HttpError(400, '此平台的独立应用授权适配尚未完成，暂不能配置为收集目标')
    const old = storageProfile(store, id), root = rootInput(body.root)
    const endpoint = id === 'baidu' ? 'https://pan.baidu.com' : id === 'onedrive' ? 'https://graph.microsoft.com' : id === 'gdrive' ? 'https://www.googleapis.com' : endpointBase(body.endpoint)
    const dav = id === 'webdav', oauth = ['baidu', 'onedrive', 'gdrive'].includes(id)
    const p: SavedProfile = { id, endpoint, root, enabled: false, revision: randomUUID(), ...(id === 's3' ? { region: text(body.region ?? 'us-east-1', '区域', 64), bucket: text(body.bucket, '存储桶', 63) } : {}), ...(dav ? { username: text(body.username, '账号', 100) } : {}), ...(oauth ? { clientId: text(body.clientId, '应用 ID', 200) } : {}) }
    if (p.bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(p.bucket)) throw new HttpError(400, '存储桶名称无效')
    if (p.region && !/^[a-z0-9-]{1,64}$/.test(p.region)) throw new HttpError(400, '区域名称无效')
    if (p.username?.includes(':')) throw new HttpError(400, 'WebDAV 账号不能包含冒号')
    if (id === 'baidu' && !root.startsWith('/apps/')) throw new HttpError(400, '请填写百度为你的应用授权的 /apps/应用名 目录')
    const supplied = object(body.credentials || {})
    let prior: StorageCredentials = {}
    if (old) { try { prior = credentials(old) } catch { /* Fresh credentials may replace an unrecoverable encrypted value. */ } }
    const next: StorageCredentials = {}
    const keys = dav ? ['password'] : id === 's3' ? ['accessKeyId', 'secretAccessKey', 'sessionToken'] : ['clientSecret', 'accessToken', 'refreshToken']
    const changedAccount = old && (old.endpoint !== p.endpoint || old.username !== p.username || old.clientId !== p.clientId)
    for (const key of keys) { const value = supplied[key]; if (typeof value === 'string' && value.trim()) { if (/[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, '连接凭证不能包含控制字符'); (next as Record<string, unknown>)[key] = text(value, '连接凭证', 8192) } else if (!changedAccount) (next as Record<string, unknown>)[key] = (prior as Record<string, unknown>)[key] }
    if (oauth && next.accessToken === prior.accessToken) next.expiresAt = prior.expiresAt
    if (dav && !next.password || id === 's3' && (!next.accessKeyId || !next.secretAccessKey) || oauth && !next.clientSecret) throw new HttpError(400, '请填写连接凭证，更换地址或账号需重新填写')
    if (old && (['endpoint', 'root', 'region', 'bucket', 'username', 'clientId', 'via'] as const).every(key => old[key] === p[key]) && keys.every(key => (next as Record<string, unknown>)[key] === (prior as Record<string, unknown>)[key])) return safe(old)
    p.encryptedCredentials = encrypt(store, JSON.stringify(next))
    store.set(`storage.${id}`, JSON.stringify(p)); store.activity('保存远端存储连接，等待验证')
    return safe(p)
  })
  app.post('/api/storage/connections/:id/test', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async req => {
    if (testing) throw new HttpError(429, '已有连接测试正在进行')
    const p = get(object(req.params).id); if (!implemented.has(p.id)) throw new HttpError(400, '此连接暂不可用')
    if (object(req.body).revision !== p.revision) throw new HttpError(409, '连接设置已变更，请刷新并重新确认测试')
    testing = true
    try { await adapter(p, await refresh(p)).test(); const current = get(p.id); if (p.revision !== current.revision) throw new HttpError(409, '连接设置已变更，请重新测试'); const saved = { ...current, enabled: true, verifiedAt: new Date().toISOString() }; store.set(`storage.${p.id}`, JSON.stringify(saved)); store.activity('远端存储连接验证通过'); return safe(saved) }
    catch (error) { const current = get(p.id); if (current.revision === p.revision) store.set('storage.' + p.id, JSON.stringify({ ...current, enabled: false, verifiedAt: undefined })); throw error }
    finally { testing = false }
  })
  app.post('/api/storage/connections/:id/disable', async req => { const p = get(object(req.params).id); store.set(`storage.${p.id}`, JSON.stringify({ ...p, enabled: false, verifiedAt: undefined, revision: randomUUID() })); return { ok: true } })
  app.post('/api/storage/baidu/authorize', async req => {
    const p = get('baidu'), c = credentials(p)
    if (object(req.body).revision !== p.revision) throw new HttpError(409, '连接设置已变更，请刷新后重新发起授权')
    if (!p.clientId || !c.clientSecret) throw new HttpError(400, '请先保存百度应用的 API Key 与 Secret Key')
    const url = new URL('https://openapi.baidu.com/oauth/2.0/device/code'); url.search = new URLSearchParams({ response_type: 'device_code', client_id: p.clientId, scope: 'basic,netdisk' }).toString()
    const response = await http({ url, method: 'GET', signal: controller.signal }); remoteOK(response)
    const result = JSON.parse((await remoteBody(response)).toString())
    if (typeof result.device_code !== 'string' || typeof result.user_code !== 'string' || typeof result.verification_url !== 'string' || !Number.isFinite(result.expires_in)) throw new HttpError(502, '百度没有返回可用授权，请检查应用资格与网盘权限')
    const verification = new URL(result.verification_url)
    if (verification.protocol !== 'https:' || !(verification.hostname === 'baidu.com' || verification.hostname.endsWith('.baidu.com'))) throw new HttpError(502, '百度返回了无法识别的授权地址')
    const id = randomUUID(), expires = Date.now() + Math.min(result.expires_in, 1800) * 1000
    store.db.prepare('DELETE FROM storage_oauth WHERE expires<?').run(Date.now())
    store.db.prepare('INSERT INTO storage_oauth VALUES (?,?,?,?)').run(id, 'baidu', encrypt(store, JSON.stringify({ deviceCode: result.device_code, revision: p.revision, nextPoll: Date.now() + Math.max(5, Number(result.interval) || 5) * 1000 })), expires)
    return { id, userCode: result.user_code, verificationUrl: verification.href, expiresAt: new Date(expires).toISOString(), interval: Math.max(5, Number(result.interval) || 5) }
  })
  app.post('/api/storage/baidu/authorize/:id', async req => {
    const id = text(object(req.params).id, '授权编号', 36), p = get('baidu'), c = credentials(p)
    const row = store.db.prepare('SELECT data,expires FROM storage_oauth WHERE id=? AND provider=?').get(id, 'baidu') as { data: string; expires: number } | undefined
    if (!row || row.expires < Date.now()) throw new HttpError(410, '授权已过期，请重新发起')
    const auth = JSON.parse(decrypt(store, row.data))
    if (auth.revision !== p.revision) throw new HttpError(409, '连接配置已修改，请重新发起授权')
    if (auth.nextPoll > Date.now()) return { pending: true }
    auth.nextPoll = Date.now() + 5000; store.db.prepare('UPDATE storage_oauth SET data=? WHERE id=?').run(encrypt(store, JSON.stringify(auth)), id)
    const url = new URL('https://openapi.baidu.com/oauth/2.0/token'); url.search = new URLSearchParams({ grant_type: 'device_token', code: auth.deviceCode, client_id: p.clientId!, client_secret: c.clientSecret! }).toString()
    const response = await http({ url, method: 'GET', signal: controller.signal }); remoteOK(response)
    const result = JSON.parse((await remoteBody(response)).toString())
    if (['authorization_pending', 'slow_down'].includes(result.error)) return { pending: true }
    if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in)) throw new HttpError(502, '授权未完成或被拒绝，请在百度页面确认后重试')
    const saved = saveCredentials(p, { ...c, accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000 }, true)
    store.db.prepare('DELETE FROM storage_oauth WHERE id=?').run(id)
    return { pending: false, authorized: true, profile: safe(saved) }
  })
  app.post('/api/storage/transfers/retry', async req => {
    const ids = object(req.body).ids
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw new HttpError(400, '请选择 1–100 项传输')
    for (const id of ids) { const row = store.db.prepare('SELECT provider,state FROM remote_transfers WHERE file_id=?').get(String(id)) as { provider: Provider; state: string } | undefined; if (!row || row.state === 'transferring') continue; const p = get(row.provider); if (!p.enabled) throw new HttpError(400, '请先验证并启用连接'); store.db.prepare("UPDATE remote_transfers SET state='queued',revision=?,attempts=0,error=NULL WHERE file_id=?").run(p.revision, String(id)) }
    return { ok: true }
  })
  const work = async () => {
    while (!stopping) {
      const row = store.db.prepare("SELECT * FROM remote_transfers WHERE state='queued' ORDER BY updated_at LIMIT 1").get() as unknown as (TransferInfo & { revision: string }) | undefined
      if (!row) return
      const file = store.files().find(f => f.id === row.file_id && !f.deletedAt), p = storageProfile(store, row.provider as Provider)
      if (!implemented.has(row.provider as Provider) || !file || !p?.enabled || !p.verifiedAt || row.revision !== p.revision) { store.db.prepare("UPDATE remote_transfers SET state='failed',error='文件已移除，或连接已停用 / 变更；本机原件保留',updated_at=? WHERE file_id=?").run(new Date().toISOString(), row.file_id); continue }
      store.db.prepare("UPDATE remote_transfers SET state='transferring',attempts=attempts+1,updated_at=? WHERE file_id=?").run(new Date().toISOString(), row.file_id)
      try {
        const path = join(store.dataDir, 'objects', store.fileKey(file.id)!), hash = createHash('sha256'); let bytes = 0
        for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length }
        if (bytes !== file.size || hash.digest('hex') !== file.sha256) throw new HttpError(409, '本机原件校验失败，已停止云端传输')
        const remotePath = `${p.root}/${file.collectionId}/${file.id}_${file.name}`
        const result = await adapter(p, await refresh(p)).put(remotePath, path, file.size, file.sha256!)
        const current = get(p.id)
        if (current.revision !== row.revision) throw new HttpError(409, '传输期间连接配置已变更，请核对云端结果后重试')
        store.transaction(() => {
          store.db.prepare("UPDATE remote_transfers SET state='ready',remote_path=?,updated_at=?,error=NULL WHERE file_id=?").run(result.path, new Date().toISOString(), file.id)
          const latest = store.files().find(f => f.id === file.id)!
          store.saveFile({ ...latest, remotePath: result.path, remoteStatus: 'ready' }); store.activity('一份收集文件已完成云端同步，本机副本保留')
        })
      } catch (error) { store.db.prepare('UPDATE remote_transfers SET state=?,error=?,updated_at=? WHERE file_id=?').run(stopping ? 'queued' : 'failed', error instanceof HttpError ? error.message : '云端传输未完成，本机原件已保留，请检查网络或授权后重试', new Date().toISOString(), row.file_id) }
    }
  }
  const timer = setInterval(() => { if (!running && !stopping) running = work().finally(() => { running = undefined }) }, 1000); timer.unref()
  return async () => { stopping = true; clearInterval(timer); controller.abort(); await running }
}
