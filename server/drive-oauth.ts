import type { FastifyInstance } from 'fastify'
import type { Store } from './store.ts'
import type { StorageProfile } from '../src/types.ts'
import type { StorageCredentials } from './storage-adapters.ts'
import type { RemoteHTTP } from './remote-http.ts'
import { remoteBody, remoteOK } from './remote-http.ts'
import { encrypt, decrypt } from './secrets.ts'
import { digest, HttpError, object, text, token } from './security.ts'
import { createHash } from 'node:crypto'

type Drive = 'onedrive' | 'gdrive'
export interface OAuthProfile extends Omit<StorageProfile, 'hasCredentials'> { encryptedCredentials?: string }
export const driveOAuth = {
  onedrive: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'offline_access https://graph.microsoft.com/Files.ReadWrite' },
  gdrive: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/drive.file' },
}
export async function exchangeToken(http: RemoteHTTP, provider: Drive, params: Record<string, string>, signal: AbortSignal) {
  const body = Buffer.from(new URLSearchParams(params).toString())
  const response = await http({ url: new URL(driveOAuth[provider].token), method: 'POST', body, signal, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) } })
  remoteOK(response)
  const result = JSON.parse((await remoteBody(response)).toString())
  if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new HttpError(502, '网盘授权未完成，请检查应用配置与授权状态')
  return { accessToken: result.access_token, refreshToken: typeof result.refresh_token === 'string' ? result.refresh_token : undefined, expiresAt: Date.now() + result.expires_in * 1000 } as StorageCredentials
}

export function registerDriveOAuth(app: FastifyInstance, store: Store, options: {
  origin: string; http: RemoteHTTP; signal: AbortSignal;
  get: (id: string) => OAuthProfile;
  credentials: (profile: OAuthProfile) => StorageCredentials;
  save: (profile: OAuthProfile, value: StorageCredentials, reauthorize?: boolean) => OAuthProfile;
}) {
  const callback = (id: string) => `${options.origin}/api/storage/oauth/${id}/callback`
  app.post('/api/storage/oauth/:id/authorize', async req => {
    const id = String(object(req.params).id) as Drive
    if (!['onedrive', 'gdrive'].includes(id)) throw new HttpError(400, '此网盘不支持该授权方式')
    const p = options.get(id), c = options.credentials(p)
    if (object(req.body).revision !== p.revision) throw new HttpError(409, '连接设置已变更，请重新确认')
    if (!p.clientId || !c.clientSecret) throw new HttpError(400, '请先保存自己的 OAuth 应用 ID 和 Secret')
    const state = token(), verifier = token(), redirectUri = callback(id), config = driveOAuth[id]
    store.db.prepare('DELETE FROM storage_oauth WHERE expires<?').run(Date.now())
    const session = store.db.prepare('SELECT user_id FROM sessions WHERE hash=?').get(digest(req.cookies.jiyu_session || '')) as { user_id: string } | undefined
    store.db.prepare('INSERT INTO storage_oauth VALUES (?,?,?,?)').run(digest(state), id, encrypt(store, JSON.stringify({ verifier, revision: p.revision, redirectUri, userId: session?.user_id })), Date.now() + 10 * 60 * 1000)
    const url = new URL(config.authorize)
    for (const [k, v] of Object.entries({ client_id: p.clientId, response_type: 'code', redirect_uri: redirectUri, scope: config.scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(id === 'gdrive' ? { access_type: 'offline', prompt: 'consent' } : { response_mode: 'query' }) })) url.searchParams.set(k, v)
    return { authorizationUrl: url.href, redirectUri, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  })
  app.get('/api/storage/oauth/:id/callback', async (req, reply) => {
    const id = String(object(req.params).id) as Drive, query = object(req.query)
    if (!['onedrive', 'gdrive'].includes(id)) throw new HttpError(400, '授权平台无效')
    const state = text(query.state, '授权状态', 100), row = store.db.prepare('SELECT data,expires FROM storage_oauth WHERE id=? AND provider=?').get(digest(state), id) as { data: string; expires: number } | undefined
    if (!row || row.expires < Date.now()) throw new HttpError(410, '授权已过期或已使用，请回到存储空间重新发起')
    const auth = JSON.parse(decrypt(store, row.data)), p = options.get(id)
    const user = store.db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND disabled=0").get(auth.userId || '')
    if (auth.revision !== p.revision || !user) throw new HttpError(409, '应用设置或管理员权限已变更，请重新发起授权')
    store.db.prepare('DELETE FROM storage_oauth WHERE id=?').run(digest(state))
    if (query.error) throw new HttpError(400, '网盘授权被取消或拒绝，请回到存储空间重试')
    const c = options.credentials(p)
    const result = await exchangeToken(options.http, id, { grant_type: 'authorization_code', code: text(query.code, '授权码', 4096), redirect_uri: auth.redirectUri, client_id: p.clientId!, client_secret: c.clientSecret!, code_verifier: auth.verifier }, options.signal)
    if (!store.db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND disabled=0").get(auth.userId || '')) throw new HttpError(403, '管理员权限已变更，未保存授权')
    options.save(p, { clientSecret: c.clientSecret, ...result }, true)
    store.activity('完成网盘账号授权，等待连接校验')
    reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>集屿 · 授权完成</title><main><h1>网盘授权已完成</h1><p>回到存储空间，重新打开此连接并校验授权。</p><a href="/#/storage">回到集屿存储空间</a></main></html>')
  })
  return callback
}
