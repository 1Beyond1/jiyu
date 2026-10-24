import type { UploadReceipt, SubmissionMetadata, UploadFeedback, UploadFileProgress } from '../types'

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
function comparableSignature(signature: string) {
  const b = JSON.parse(signature)
  return JSON.stringify({ owner: b.owner, files: b.files, fields: Object.fromEntries(Object.entries(b.fields || {}).sort(([a], [z]) => a.localeCompare(z))), ...(b.materialIds ? { materialIds: b.materialIds } : {}), ...(b.replace ? { replace: { receiptId: b.replace.receiptId, key: b.replace.key } } : {}) })
}
export function forgetUpload(uploadToken: string) { try { localStorage.removeItem(resumeStorage(uploadToken)) } catch { /* Private browsing may disable persistence. */ } }
function saveUploadReceipt(uploadToken: string, record: ResumeRecord, receipt: UploadReceipt, files: { size: number }[]) {
  if (!receipt || !/^[a-f0-9-]{36}$/.test(receipt.receiptId) || receipt.filesCount !== files.length || receipt.bytes !== files.reduce((sum, f) => sum + f.size, 0) || !Number.isFinite(Date.parse(receipt.createdAt))) throw new Error('尚未取得有效提交回执，请重试确认结果；已传分片会保留。')
  const saved = { ...receipt, editKey: record.key }
  try { localStorage.setItem(`jiyu:receipt:${uploadToken}`, JSON.stringify(saved)) } catch { /* Manual receipt download remains available. */ }
  forgetUpload(uploadToken); return saved
}
export async function recoverUploadReceipt(uploadToken: string): Promise<UploadReceipt | null> {
  const record = JSON.parse(localStorage.getItem(resumeStorage(uploadToken)) || 'null') as ResumeRecord | null
  if (!record) return null
  const response = await fetch(`/api/public/${encodeURIComponent(uploadToken)}/uploads/${record.id}`, { credentials: 'same-origin', headers: { 'X-Upload-Key': record.key } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '暂时无法确认提交结果，请稍后重试')
  if (!data.receipt) return null
  return saveUploadReceipt(uploadToken, record, data.receipt, JSON.parse(record.signature).files)
}
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
export function pendingSubmission(uploadToken: string): SubmissionMetadata & { owner?: string; files?: { name: string; size: number; lastModified: number }[] } {
  try { const r = JSON.parse(localStorage.getItem(resumeStorage(uploadToken)) || 'null') as ResumeRecord | null; return r && r.savedAt > Date.now() - 24 * 60 * 60 * 1000 ? JSON.parse(r.signature) : {} } catch { return {} }
}

export async function uploadFiles(uploadToken: string, files: File[], owner: string, _requestId: string, onProgress: (value: number) => void, signal: AbortSignal, metadata: SubmissionMetadata = {}, onFeedback?: (feedback: UploadFeedback) => void): Promise<UploadReceipt> {
  const feedback: UploadFileProgress[] = files.map(f => ({ state: 'queued', sentBytes: 0, totalBytes: f.size }))
  let phase: UploadFeedback['phase'] = 'preparing', currentFile: number | undefined
  const emit = () => onFeedback?.({ phase, files: feedback.map(f => ({ ...f })) })
  const update = (i: number, state: UploadFileProgress['state'], message?: string) => { feedback[i] = { ...feedback[i], state, message }; emit() }
  emit()
  const signature = JSON.stringify({ owner, files: files.map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified })), ...metadata })
  let record: ResumeRecord | null = null
  try { record = JSON.parse(localStorage.getItem(resumeStorage(uploadToken)) || 'null') as ResumeRecord | null } catch { /* Continue without local persistence. */ }
  let matches = false
  try { matches = !!record && comparableSignature(record.signature) === comparableSignature(signature) } catch { /* A malformed local draft can be discarded. */ }
  if (record && !matches) { try { await discardUpload(uploadToken); record = null } catch (e) { phase = 'failed'; emit(); throw e } }
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
      if (attempt < 2) {
        if (currentFile !== undefined) update(currentFile, 'retrying', `${lastError?.message || '连接中断'}，正在进行第 ${attempt + 1} 次自动重试`)
        await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(signal.reason) }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1000 * (attempt + 1)); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })
      }
    }
    throw lastError || new Error('网络连接中断，重新提交可从已完成的分片继续')
  }
  try {
    const completed = (receipt: UploadReceipt) => {
      const saved = saveUploadReceipt(uploadToken, record!, receipt, files)
      phase = 'received'; feedback.forEach(f => { f.state = 'received'; f.sentBytes = f.totalBytes; delete f.message }); emit()
      forgetUpload(uploadToken); onProgress(100); return saved
    }
    const state = await request<UploadState>(base, 'POST', signature, { 'Content-Type': 'application/json' })
    if (state.receipt) return completed(state.receipt)
    if (!Number.isSafeInteger(state.chunkBytes) || state.chunkBytes < 1 || !Array.isArray(state.parts)) throw new Error('服务返回的续传信息无效，请重试连接。')
    const total = files.reduce((sum, f) => sum + f.size, 0); let sent = 0
    phase = 'uploading'; emit()
    for (let index = 0; index < files.length; index++) {
      currentFile = index
      const file = files[index]
      update(index, 'checking')
      for (let part = 0; part < Math.ceil(file.size / state.chunkBytes); part++) {
        signal.throwIfAborted()
        const bytes = file.slice(part * state.chunkBytes, (part + 1) * state.chunkBytes)
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('')
        const previous = state.parts.find(p => p.file_index === index && p.part_index === part)
        if (previous && previous.sha256 !== hash) throw new Error('所选文件内容与已上传的分片不同，请使用原文件，或点击“重新开始”')
        update(index, previous ? 'checking' : 'uploading')
        if (!previous) await request(`${base}/${index}/${part}`, 'PUT', bytes, { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': hash })
        feedback[index].sentBytes += bytes.size; emit()
        sent += bytes.size; onProgress(Math.min(99, Math.round(sent / Math.max(1, total) * 100)))
      }
      update(index, 'uploaded')
    }
    currentFile = undefined; phase = 'saving'; feedback.forEach(f => { f.state = 'saving' }); emit()
    const result = await request<UploadReceipt>(`${base}/complete`, 'POST', '{}', { 'Content-Type': 'application/json' })
    return completed(result)
  } catch (error) {
    phase = signal.aborted ? 'paused' : 'failed'
    if (currentFile !== undefined) update(currentFile, signal.aborted ? 'paused' : 'failed', signal.aborted ? '已确认分片保留，继续时会核对原文件' : (error as Error).message)
    else feedback.forEach(f => { if (f.state === 'saving') f.state = 'uploaded' })
    emit()
    if (signal.aborted) throw new Error('上传已暂停，已完成的分片保留 24 小时。继续提交会核对已传分片，不会重复保存文件。')
    throw error
  }
}
