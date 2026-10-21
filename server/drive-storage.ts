import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { StorageProfile } from '../src/types.ts'
import type { RemoteHTTP, RemoteResponse } from './remote-http.ts'
import { remoteBody, remoteOK } from './remote-http.ts'
import type { StorageCredentials, RemoteObject } from './storage-adapters.ts'
import { HttpError } from './security.ts'

const itemPath = (id: string) => id === 'root' ? '/me/drive/root' : `/me/drive/items/${encodeURIComponent(id)}`
async function json(r: RemoteResponse) { remoteOK(r); try { return JSON.parse((await remoteBody(r)).toString()) as Record<string, unknown> } catch { throw new HttpError(502, '网盘返回无效数据') } }
function uploadURL(value: unknown, provider: 'onedrive' | 'gdrive') {
  if (typeof value !== 'string') throw new HttpError(502, '网盘没有返回上传地址')
  const url = new URL(value)
  const host = url.hostname.toLowerCase(), allowed = provider === 'gdrive' ? host === 'www.googleapis.com' : ['1drv.com', 'onedrive.com', 'sharepoint.com', 'sharepoint-df.com', 'onedrive.live.com'].some(d => host === d || host.endsWith(`.${d}`))
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed) throw new HttpError(502, '网盘返回了不受支持的传输地址')
  return url
}

export class DriveStorage {
  profile: StorageProfile; credentials: StorageCredentials; http: RemoteHTTP; signal: AbortSignal
  constructor(profile: StorageProfile, credentials: StorageCredentials, http: RemoteHTTP, signal: AbortSignal) { this.profile = profile; this.credentials = credentials; this.http = http; this.signal = signal }
  private async api(path: string, method = 'GET', payload?: object) {
    const body = payload ? Buffer.from(JSON.stringify(payload)) : undefined
    return this.http({ url: new URL(`${this.profile.id === 'onedrive' ? 'https://graph.microsoft.com/v1.0' : 'https://www.googleapis.com/drive/v3'}${path}`), method, body, signal: this.signal, headers: { authorization: `Bearer ${this.credentials.accessToken}`, ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) } })
  }
  private async folder(path: string) {
    let id = 'root'
    for (const part of path.split('/').filter(Boolean)) {
      if (this.profile.id === 'onedrive') {
        const response = await this.api(`${itemPath(id)}:/${encodeURIComponent(part)}`)
        if (response.status === 404) { response.body.destroy?.(); const created = await json(await this.api(`${itemPath(id)}/children`, 'POST', { name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })); if (!created.folder || typeof created.id !== 'string') throw new HttpError(502, '网盘目录创建失败'); id = created.id }
        else { const found = await json(response); if (!found.folder || typeof found.id !== 'string') throw new HttpError(409, '网盘目标路径已被文件占用'); id = found.id }
      } else {
        const q = `name='${part.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}' and '${id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
        const data = await json(await this.api(`/files?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '2' })}`))
        const list = data.files as { id: string }[] | undefined
        if (list?.length && list.length > 1) throw new HttpError(409, '网盘中存在同名目录，请更换专用目录名称')
        if (list?.[0]?.id) id = list[0].id
        else { const made = await json(await this.api('/files?fields=id', 'POST', { name: part, mimeType: 'application/vnd.google-apps.folder', parents: [id] })); if (typeof made.id !== 'string') throw new HttpError(502, '网盘目录创建失败'); id = made.id }
      }
    }
    return id
  }
  private async verify(id: string, size: number, sha256: string) {
    let response = await this.api(this.profile.id === 'onedrive' ? `/me/drive/items/${encodeURIComponent(id)}/content` : `/files/${encodeURIComponent(id)}?alt=media`)
    if (this.profile.id === 'onedrive' && [301, 302, 303, 307, 308].includes(response.status)) {
      const url = uploadURL(response.headers.location, 'onedrive'); response.body.destroy?.()
      response = await this.http({ url, method: 'GET', signal: this.signal })
    }
    remoteOK(response)
    let count = 0; const hash = createHash('sha256')
    try { for await (const bytes of response.body) { count += bytes.length; if (count > size) throw new HttpError(502, '网盘正文大小不符'); hash.update(bytes) }; if (count !== size || hash.digest('hex') !== sha256) throw new HttpError(502, '网盘正文校验失败，本机原件已保留') }
    finally { response.body.destroy?.() }
  }
  async put(path: string, source: string | Buffer, size: number, sha256: string): Promise<RemoteObject> {
    const parts = path.split('/').filter(Boolean), name = parts.pop()!, parent = await this.folder(parts.join('/')), microsoft = this.profile.id === 'onedrive'
    let existing: Record<string, unknown> | undefined
    if (microsoft) { const response = await this.api(`${itemPath(parent)}:/${encodeURIComponent(name)}`); if (response.status !== 404) existing = await json(response); else response.body.destroy?.() }
    else { const q = `name='${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}' and '${parent}' in parents and trashed=false`; const data = await json(await this.api(`/files?${new URLSearchParams({ q, fields: 'files(id,size)', pageSize: '2' })}`)); const list = data.files as Record<string, unknown>[] | undefined; if (list?.length && list.length > 1) throw new HttpError(409, '云端存在多份相同对象名，请人工核对'); existing = list?.[0] }
    if (existing) { if (typeof existing.id !== 'string' || Number(existing.size) !== size) throw new HttpError(409, '云端对象已改变，不会覆盖，请人工核对'); await this.verify(existing.id, size, sha256); return { path, size, sha256 } }
    if (size === 0) {
      const result = microsoft ? await json(await this.http({ url: new URL(`https://graph.microsoft.com/v1.0${itemPath(parent)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`), method: 'PUT', body: Buffer.alloc(0), signal: this.signal, headers: { authorization: `Bearer ${this.credentials.accessToken}`, 'content-length': '0', 'content-type': 'application/octet-stream' } })) : await json(await this.api('/files?fields=id,size', 'POST', { name, parents: [parent], mimeType: 'application/octet-stream' }))
      if (typeof result.id !== 'string' || Number(result.size) !== 0) throw new HttpError(502, '网盘未确认空文件')
      await this.verify(result.id, 0, sha256); return { path, size, sha256 }
    }
    let upload: URL
    if (microsoft) {
      const session = await json(await this.api(`${itemPath(parent)}:/${encodeURIComponent(name)}:/createUploadSession`, 'POST', { item: { '@microsoft.graph.conflictBehavior': 'fail', name } }))
      upload = uploadURL(session.uploadUrl, 'onedrive')
    } else {
      const body = Buffer.from(JSON.stringify({ name, parents: [parent], appProperties: { jiyuObject: name.split('_')[0] } }))
      const response = await this.http({ url: new URL('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size'), method: 'POST', body, signal: this.signal, headers: { authorization: `Bearer ${this.credentials.accessToken}`, 'content-type': 'application/json', 'content-length': String(body.length), 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(size) } })
      remoteOK(response); upload = uploadURL(response.headers.location, 'gdrive'); await remoteBody(response)
    }
    const file = typeof source === 'string' ? await open(source, 'r') : undefined
    const chunkSize = microsoft ? 10 * 320 * 1024 : 8 * 1024 ** 2
    let result: Record<string, unknown> | undefined
    try {
      for (let start = 0; start < size; start += chunkSize) {
        const length = Math.min(chunkSize, size - start), bytes = Buffer.isBuffer(source) ? source.subarray(start, start + length) : Buffer.alloc(length)
        if (file && (await file.read(bytes, 0, length, start)).bytesRead !== length) throw new HttpError(409, '本机原件大小已改变')
        const response = await this.http({ url: upload, method: 'PUT', body: bytes, signal: this.signal, headers: { 'content-length': String(length), 'content-range': `bytes ${start}-${start + length - 1}/${size}`, 'content-type': 'application/octet-stream' } })
        if (!microsoft && response.status === 308) { await remoteBody(response); continue }
        result = await json(response)
      }
      if (!result || typeof result.id !== 'string' || Number(result.size) !== size) throw new HttpError(502, '网盘没有确认完整文件，本机原件已保留')
      await this.verify(result.id, size, sha256)
      return { path, size, sha256 }
    } finally { await file?.close() }
  }
  async test() { if (this.profile.id === 'onedrive') await json(await this.api('/me/drive?$select=id,driveType')); else await json(await this.api('/files?pageSize=1&fields=files(id)')) }
}
