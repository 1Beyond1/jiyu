import type { UploadReceipt } from '../types'

let csrf = ''
export function setCsrf(value: string) { csrf = value }
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, signal, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json().catch(() => ({ error: '服务返回了无效响应' }))
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('jiyu:session-expired'))
    throw new Error(data.error || '操作失败，请稍后重试')
  }
  return data as T
}

export function uploadMultipart(uploadToken: string, files: File[], owner: string, requestId: string, onProgress: (value: number) => void, signal: AbortSignal): Promise<UploadReceipt> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(), form = new FormData()
    form.append('owner', owner)
    for (const file of files) form.append('files', file, file.name)
    request.open('POST', `/api/public/${encodeURIComponent(uploadToken)}/upload`)
    request.setRequestHeader('Idempotency-Key', requestId)
    request.timeout = 10 * 60 * 1000
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))) }
    request.onload = () => {
      try { const data = JSON.parse(request.responseText); if (request.status >= 200 && request.status < 300) { onProgress(100); resolve(data) } else reject(new Error(data.error || '上传失败，请重试')) }
      catch { reject(new Error('服务响应异常，请重试以确认提交结果')) }
    }
    request.onerror = () => reject(new Error('网络连接中断，请重试；已完成的提交不会重复保存'))
    request.ontimeout = () => reject(new Error('上传超时，请检查网络后重试'))
    request.onabort = () => reject(new Error('上传已取消，可以重新提交'))
    const abort = () => request.abort()
    signal.addEventListener('abort', abort, { once: true })
    request.onloadend = () => signal.removeEventListener('abort', abort)
    request.send(form)
  })
}

interface UploadState { id: string; chunkBytes: number; parts: { file_index: number; part_index: number; sha256: string; size: number }[]; receipt?: UploadReceipt }
interface ResumeRecord { id: string; key: string; signature: string; savedAt: number }
const resumeStorage = (uploadToken: string) => `jiyu:upload:${uploadToken}`
export function forgetUpload(uploadToken: string) { try { localStorage.removeItem(resumeStorage(uploadToken)) } catch { /* Private browsing may disable persistence. */ } }
export async function discardUpload(uploadToken: string) {
  let record: ResumeRecord | null = null
  try { record = JSON.parse(localStorage.getItem(resumeStorage(uploadToken)) || 'null') as ResumeRecord | null } catch { /* No resumable metadata. */ }
  if (record) {
    const response = await fetch(`/api/public/${encodeURIComponent(uploadToken)}/uploads/${record.id}`, { method: 'DELETE', headers: { 'X-Upload-Key': record.key }, credentials: 'same-origin' })
    if (!response.ok && ![404, 410].includes(response.status)) throw new Error('暂时无法取消旧批次，请稍后重试')
  }
  forgetUpload(uploadToken)
}
export function hasPendingUpload(uploadToken: string) { try { const r = JSON.parse(localStorage.getItem(resumeStorage(uploadToken)) || 'null') as ResumeRecord | null; return !!r && r.savedAt > Date.now() - 24 * 60 * 60 * 1000 } catch { return false } }

export async function uploadFiles(uploadToken: string, files: File[], owner: string, _requestId: string, onProgress: (value: number) => void, signal: AbortSignal): Promise<UploadReceipt> {
  const signature = JSON.stringify({ owner, files: files.map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified })) })
  let record: ResumeRecord | null = null
  try { record = JSON.parse(localStorage.getItem(resumeStorage(uploadToken)) || 'null') as ResumeRecord | null } catch { /* Continue without local persistence. */ }
  if (record && record.signature !== signature) { await discardUpload(uploadToken); record = null }
  if (!record || record.savedAt < Date.now() - 24 * 60 * 60 * 1000) record = { id: crypto.randomUUID(), key: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''), signature, savedAt: Date.now() }
  try { localStorage.setItem(resumeStorage(uploadToken), JSON.stringify(record)) } catch { /* Current page still retains its continuation credential. */ }
  const base = `/api/public/${encodeURIComponent(uploadToken)}/uploads/${record.id}`
  const request = async <T>(url: string, method: string, body?: string | Blob, headers?: Record<string, string>): Promise<T> => {
    let lastError: Error | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      try {
        const response = await fetch(url, { method, signal, credentials: 'same-origin', body, headers: { 'X-Upload-Key': record!.key, ...headers } })
        const data = await response.json().catch(() => ({ error: '服务响应异常，请重试' }))
        if (response.ok) return data as T
        if (![429, 502, 503, 504].includes(response.status)) throw Object.assign(new Error(data.error || '上传失败'), { terminal: true })
        lastError = new Error(data.error || '服务繁忙，请重试')
      } catch (error) { if (signal.aborted || (error as { terminal?: boolean }).terminal) throw error; lastError = error as Error }
      if (attempt < 2) await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(signal.reason) }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1000 * (attempt + 1)); signal.addEventListener('abort', abort, { once: true }) })
    }
    throw lastError || new Error('网络连接中断，重新提交可从已完成的分片继续')
  }
  try {
    const state = await request<UploadState>(base, 'POST', signature, { 'Content-Type': 'application/json' })
    if (state.receipt) { forgetUpload(uploadToken); onProgress(100); return state.receipt }
    const total = files.reduce((sum, f) => sum + f.size, 0); let sent = 0
    for (let index = 0; index < files.length; index++) {
      const file = files[index]
      for (let part = 0; part < Math.ceil(file.size / state.chunkBytes); part++) {
        signal.throwIfAborted()
        const bytes = file.slice(part * state.chunkBytes, (part + 1) * state.chunkBytes)
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('')
        const previous = state.parts.find(p => p.file_index === index && p.part_index === part)
        if (previous && previous.sha256 !== hash) throw new Error('所选文件内容与已上传的分片不同，请使用原文件，或点击“重新开始”')
        if (!previous) await request(`${base}/${index}/${part}`, 'PUT', bytes, { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': hash })
        sent += bytes.size; onProgress(Math.min(99, Math.round(sent / Math.max(1, total) * 100)))
      }
    }
    const result = await request<UploadReceipt>(`${base}/complete`, 'POST', '{}', { 'Content-Type': 'application/json' })
    forgetUpload(uploadToken); onProgress(100); return result
  } catch (error) { if (signal.aborted) throw new Error('上传已暂停，已完成的分片保留 24 小时，重新提交即可继续'); throw error }
}
