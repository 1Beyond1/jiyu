import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { StorageProfile } from '../src/types.ts'
import type { RemoteHTTP, RemoteResponse } from './remote-http.ts'
import { remoteBody, remoteOK } from './remote-http.ts'
import { HttpError, object } from './security.ts'

export interface StorageCredentials { password?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; accessToken?: string; refreshToken?: string; clientSecret?: string; expiresAt?: number }
export interface RemoteObject { path: string; size: number; sha256: string }
const hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const objectUrl = (profile: StorageProfile, path: string) => new URL(`${profile.endpoint.replace(/\/$/, '')}/${[...(profile.id === 's3' ? [profile.bucket!] : []), ...path.split('/').filter(Boolean)].map(encode).join('/')}${path.endsWith('/') ? '/' : ''}`)
export function s3Headers(method: string, url: URL, region: string, credentials: StorageCredentials, payloadHash: string, date = new Date()) {
  const time = date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = time.slice(0, 8), scope = `${day}/${region}/s3/aws4_request`
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': time, ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}) }
  const names = Object.keys(headers).sort(), canonicalHeaders = names.map(n => `${n}:${headers[n].trim()}\n`).join('')
  const query = [...url.searchParams].map(([k, v]) => [encode(k), encode(v)]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([k, v]) => `${k}=${v}`).join('&')
  const canonical = [method, url.pathname, query, canonicalHeaders, names.join(';'), payloadHash].join('\n')
  const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest()
  const signing = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signing).update(`AWS4-HMAC-SHA256\n${time}\n${scope}\n${hex(canonical)}`).digest('hex')
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }
}

export class StandardStorage {
  profile: StorageProfile
  credentials: StorageCredentials
  http: RemoteHTTP
  signal: AbortSignal
  constructor(profile: StorageProfile, credentials: StorageCredentials, http: RemoteHTTP, signal: AbortSignal) { this.profile = profile; this.credentials = credentials; this.http = http; this.signal = signal }
  private async request(method: string, path: string, body?: Buffer | Readable, size = 0, sha256 = hex('')) {
    const url = objectUrl(this.profile, path)
    const auth = this.profile.id === 's3' ? s3Headers(method, url, this.profile.region || 'us-east-1', this.credentials, sha256) : { authorization: `Basic ${Buffer.from(`${this.profile.username}:${this.credentials.password}`).toString('base64')}` }
    return this.http({ url, method, headers: { ...auth, ...(body ? { 'content-length': String(size), 'content-type': 'application/octet-stream' } : {}) }, body, signal: this.signal })
  }
  private async folders(path: string) {
    if (this.profile.id === 's3') return
    const parts = path.split('/').filter(Boolean).slice(0, -1)
    for (let i = 0; i < parts.length; i++) { const result = await this.request('MKCOL', `${parts.slice(0, i + 1).join('/')}/`); remoteOK(result, [405]); await remoteBody(result) }
  }
  async put(path: string, source: string | Buffer, size: number, sha256: string): Promise<RemoteObject> {
    await this.folders(path)
    const result = await this.request('PUT', path, typeof source === 'string' ? createReadStream(source) : source, size, sha256)
    remoteOK(result); await remoteBody(result)
    // Read back rather than trusting ETag (which is not universally an MD5).
    await this.verify(path, size, sha256)
    return { path, size, sha256 }
  }
  async verify(path: string, size: number, sha256: string) {
    const result = await this.request('GET', path); remoteOK(result)
    let received = 0; const hash = createHash('sha256')
    try { for await (const part of result.body) { received += part.length; if (received > size) throw new HttpError(502, '远端正文大小不一致'); hash.update(part) }; if (received !== size || hash.digest('hex') !== sha256) throw new HttpError(502, '远端正文校验不通过，本机原件已保留') }
    finally { result.body.destroy?.() }
  }
  async test() {
    const path = `${this.profile.root}/.jiyu-test-${randomUUID()}.txt`, content = Buffer.from('Jiyu storage connection integrity test\n')
    await this.put(path, content, content.length, hex(content))
    const response = await this.request('DELETE', path); remoteOK(response, [404]); await remoteBody(response)
  }
}

async function json(response: RemoteResponse) { remoteOK(response); let value: unknown; try { value = JSON.parse((await remoteBody(response)).toString('utf8')) } catch { throw new HttpError(502, '网盘返回无效数据') }; const data = object(value); if (data.errno !== undefined && Number(data.errno) !== 0) throw new HttpError(502, `网盘拒绝请求（错误码 ${Number(data.errno)}），请检查应用权限、授权和容量`); return data }
export class BaiduStorage {
  credentials: StorageCredentials
  http: RemoteHTTP
  signal: AbortSignal
  constructor(_profile: StorageProfile, credentials: StorageCredentials, http: RemoteHTTP, signal: AbortSignal) { this.credentials = credentials; this.http = http; this.signal = signal }
  private async api(method: string, fields: Record<string, string>, query: Record<string, string> = {}) {
    const url = new URL('https://pan.baidu.com/rest/2.0/xpan/file'); url.searchParams.set('method', method); url.searchParams.set('access_token', this.credentials.accessToken || '')
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const body = Buffer.from(new URLSearchParams(fields).toString())
    return json(await this.http({ url, method: 'POST', body, signal: this.signal, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) } }))
  }
  async mkdir(path: string) {
    try { await this.api('create', { path, isdir: '1', rtype: '0' }) }
    catch (e) { if (!(e instanceof HttpError) || !e.message.includes('错误码 -8')) throw e }
  }
  async put(path: string, source: string | Buffer, size: number, sha256: string): Promise<RemoteObject> {
    const chunks: string[] = [], chunkSize = 4 * 1024 ** 2, handle = typeof source === 'string' ? await open(source, 'r') : undefined
    const read = async (index: number) => { const offset = index * chunkSize, length = Math.min(chunkSize, size - offset); if (Buffer.isBuffer(source)) return source.subarray(offset, offset + length); const bytes = Buffer.alloc(length), result = await handle!.read(bytes, 0, length, offset); if (result.bytesRead !== length) throw new HttpError(409, '本机原文件大小已改变'); return bytes }
    try {
      for (let i = 0; i < Math.max(1, Math.ceil(size / chunkSize)); i++) chunks.push(createHash('md5').update(await read(i)).digest('hex'))
      const parents = path.split('/').filter(Boolean).slice(0, -1)
      for (let i = 0; i < parents.length; i++) await this.mkdir('/' + parents.slice(0, i + 1).join('/'))
      const pre = await this.api('precreate', { path, size: String(size), isdir: '0', autoinit: '1', rtype: '0', block_list: JSON.stringify(chunks) })
      const uploadId = pre.uploadid
      if (typeof uploadId !== 'string' || !uploadId) throw new HttpError(502, '网盘没有返回可用上传编号，本机原件已保留')
      const missing = Array.isArray(pre.block_list) ? pre.block_list : chunks.map((_hash, i) => i)
      for (const part of missing) {
        const index = Number(part)
        if (!Number.isInteger(index) || index < 0 || index >= chunks.length) throw new HttpError(502, '网盘返回无效分片序号')
        const bytes = await read(index), boundary = `jiyu-${randomUUID()}`
        const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])
        const url = new URL('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2')
        for (const [k, v] of Object.entries({ method: 'upload', access_token: this.credentials.accessToken || '', type: 'tmpfile', path, uploadid: uploadId, partseq: String(index) })) url.searchParams.set(k, v)
        const result = await json(await this.http({ url, method: 'POST', body, signal: this.signal, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) } }))
        if (result.md5 !== chunks[index]) throw new HttpError(502, '网盘分片校验失败，本机原件已保留')
      }
      const created = await this.api('create', { path, size: String(size), isdir: '0', uploadid: uploadId, block_list: JSON.stringify(chunks), rtype: '0' })
      if (created.path !== path || Number(created.size) !== size || !created.fs_id) throw new HttpError(502, '网盘合并结果未通过校验，本机原件已保留')
      return { path, size, sha256 }
    } finally { await handle?.close() }
  }
  async test() {
    const url = new URL('https://pan.baidu.com/rest/2.0/xpan/nas'); url.search = new URLSearchParams({ method: 'uinfo', access_token: this.credentials.accessToken || '' }).toString()
    await json(await this.http({ url, method: 'GET', signal: this.signal }))
  }
}
