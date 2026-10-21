import { lookup } from 'node:dns/promises'
import { request as requestHttps } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isPublicAddress } from './ai.ts'
import { HttpError } from './security.ts'

export interface RemoteRequest { url: URL; method: string; headers?: Record<string, string>; body?: Buffer | Readable; signal?: AbortSignal }
export interface RemoteResponse { status: number; headers: IncomingMessage['headers']; body: AsyncIterable<Buffer> & { destroy?: () => void } }
export type RemoteHTTP = (input: RemoteRequest) => Promise<RemoteResponse>
export const remoteHTTP: RemoteHTTP = async ({ url, method, headers, body, signal }) => {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new HttpError(400, '远端只接受 HTTPS 443')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let timer: ReturnType<typeof setTimeout> | undefined
  const addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 5000) })]).finally(() => clearTimeout(timer))
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new HttpError(400, '远端地址解析到本机、内网或保留地址')
  const address = addresses[0]
  return new Promise((resolve, reject) => {
    const req = requestHttps(url, { method, headers, agent: false, family: address.family, lookup: (_h, _o, cb) => cb(null, address.address, address.family), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15 * 60 * 1000)]) }, response => resolve({ status: response.statusCode || 500, headers: response.headers, body: response }))
    req.on('error', () => reject(new HttpError(502, '远端连接中断或超时，请检查服务地址与网络')))
    req.setTimeout(45000, () => req.destroy(new Error('idle timeout')))
    if (body && !Buffer.isBuffer(body)) void pipeline(body, req).catch(() => req.destroy(new Error('upload interrupted')))
    else req.end(body)
  })
}
export async function remoteBody(response: RemoteResponse, limit = 256 * 1024) {
  const chunks: Buffer[] = []; let size = 0
  try { for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new HttpError(502, '远端响应超过限制'); chunks.push(chunk) }; return Buffer.concat(chunks) }
  catch (e) { response.body.destroy?.(); throw e }
}
export function remoteOK(response: RemoteResponse, allowed: number[] = []) {
  if ((response.status < 200 || response.status >= 300) && !allowed.includes(response.status)) {
    response.body.destroy?.()
    const message = response.status === 401 || response.status === 403 ? '远端拒绝授权，请检查凭证和目录权限' : response.status === 429 ? '远端请求过于频繁，请稍后重试' : response.status >= 500 ? `远端服务暂时不可用（HTTP ${response.status}），请稍后重试` : response.status === 404 ? '远端没有找到目标，请检查服务地址、存储桶或文件夹路径' : response.status >= 300 && response.status < 400 ? '远端返回重定向，请填写最终服务地址' : `远端请求失败（HTTP ${response.status}），请检查连接信息及目录权限`
    throw new HttpError(response.status === 429 ? 429 : 502, message)
  }
}
