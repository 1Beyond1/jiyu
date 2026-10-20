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

export function uploadFiles(uploadToken: string, files: File[], owner: string, requestId: string, onProgress: (value: number) => void, signal: AbortSignal): Promise<UploadReceipt> {
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
