import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, FileUp, LockKeyhole } from 'lucide-react'
import { Brand } from '../components/ui'
import { api, uploadFiles, discardUpload, recoverUploadReceipt, hasPendingUpload, pendingSubmission } from '../lib/api'
import { fileExtensions, isExpired, submissionError, effectiveFileLimit } from '../lib/collections'
import { formatSize } from '../lib/workspace'
import { ReceiptManager } from './submission-receipt'
import { UploadList } from './upload-list'
import type { Collection, UploadReceipt, ReceiptDetail, SubmissionMetadata, UploadFeedback } from '../types'

export function PublicSubmission({ uploadToken }: { uploadToken: string }) {
  const [info, setInfo] = useState<{ collection: Collection; ownerName: string } | null>(null), [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    const load = async () => { try { const data = await api<{ collection: Collection; ownerName: string }>(`/api/public/${encodeURIComponent(uploadToken)}`); if (alive) { setInfo(data); setError('') } } catch (e) { if (alive) setError((e as Error).message) } }
    void load(); const timer = setInterval(() => void load(), 15000)
    return () => { alive = false; clearInterval(timer) }
  }, [uploadToken, retry])
  if (!info) return <main className="auth-page"><Brand /><section className="auth-card"><h1>{error ? '暂时无法打开这项收集' : '正在打开收集…'}</h1><p>{error || '正在读取最新的收集规则。'}</p>{error && <button className="button" onClick={() => setRetry(n => n + 1)}>重新打开</button>}</section></main>
  return <>{error && <div className="submission-refresh-error" role="alert">收集信息暂未更新：{error}。已选文件和上传进度已保留。<button className="text-button" onClick={() => setRetry(n => n + 1)}>重试读取</button></div>}<Submission key={uploadToken} collection={info.collection} ownerName={info.ownerName} uploadToken={uploadToken} /></>
}

function Submission({ collection: c, ownerName, uploadToken }: { collection: Collection; ownerName: string; uploadToken: string }) {
  const [files, setFiles] = useState<File[]>([]), [name, setName] = useState(() => pendingSubmission(uploadToken).owner || ''), [error, setError] = useState(''), [receipt, setReceipt] = useState<UploadReceipt | null>(null)
  const [dragging, setDragging] = useState(false), [progress, setProgress] = useState(0), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now)
  const [fields, setFields] = useState<Record<string, string>>(() => pendingSubmission(uploadToken).fields || {}), [replacement, setReplacement] = useState<SubmissionMetadata['replace']>(() => pendingSubmission(uploadToken).replace)
  const [confirming, setConfirming] = useState(false)
  const [feedback, setFeedback] = useState<UploadFeedback | null>(null)
  const [pending, setPending] = useState(() => hasPendingUpload(uploadToken))
  const picker = useRef<HTMLInputElement>(null), form = useRef<HTMLFormElement>(null), controller = useRef<AbortController | null>(null), requestId = useRef(crypto.randomUUID())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => { clearInterval(timer); controller.current?.abort() } }, [])
  const ended = c.status !== 'active' || isExpired(c, now)
  function continueSubmission(detail: ReceiptDetail, replace: boolean, key: string) {
    setName(detail.owner); setFields(detail.fields); setReplacement(replace ? { receiptId: detail.receipt.receiptId, key } : undefined); setReceipt(null); setFeedback(null); setFiles([]); setError(''); setPending(hasPendingUpload(uploadToken)); requestId.current = crypto.randomUUID()
  }
  const receiptManager = <ReceiptManager c={c} uploadToken={uploadToken} receipt={receipt} onOpen={setReceipt} onContinue={continueSubmission} />
  function addFiles(incoming: FileList | null) {
    if (!incoming || busy) return
    const next = [...files]
    for (const file of Array.from(incoming)) if (!next.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) next.push(file)
    const invalid = submissionError(c, next)
    if (invalid) { setError(invalid); return }
    if (next.reduce((sum, f) => sum + f.size, 0) > (c.requestLimitMB || 512) * 1024 ** 2) { setError(`单次提交总量不能超过 ${c.requestLimitMB || 512} MB`); return }
    setFeedback(null); setFiles(next); setError(''); requestId.current = crypto.randomUUID()
  }
  async function submit() {
    if (busy) return
    if (!form.current?.reportValidity()) return
    const invalid = submissionError(c, files)
    if (invalid || !name.trim()) { setError(invalid || '请填写你的姓名'); return }
    const missing = c.fields?.find(f => f.required && !fields[f.id]?.trim())
    if (missing) { setError(`请填写${missing.label}`); return }
    setBusy(true); setPending(true); setError(''); setProgress(0); controller.current = new AbortController()
    try { setReceipt(await uploadFiles(uploadToken, files, name.trim(), requestId.current, setProgress, controller.current.signal, { fields: Object.fromEntries((c.fields || []).map(f => [f.id, fields[f.id] || ''])), ...(replacement ? { replace: replacement } : {}) }, setFeedback)); setPending(false) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <main className="submission-page"><div className="submission-top"><Brand /><span className="preview-badge">文件提交</span></div><section className="submission-card">{receipt ? <div className="submission-success"><CheckCircle2 size={52} strokeWidth={1.4} /><p className="eyebrow">ALL SET</p><h1>每一份认真，都已收到。</h1><p>{receipt.filesCount} 份文件已保存到发起人的服务器。</p><div className="receipt-box"><span>提交回执</span><code>{receipt.receiptId}</code><small>共 {formatSize(receipt.bytes)} · 请保留回执，方便联系发起人。</small></div>{receiptManager}</div> : <><span className="submission-kicker">{ownerName} 邀请你提交文件</span><h1>{c.title}</h1><p className="submission-description">{c.description}</p><div className="submission-meta"><span>截止 {c.deadline}</span><span>已收到 {c.received} 份</span></div>{!busy && receiptManager}{pending && !busy && <div className="form-note">上次提交未取得回执，可直接确认结果，无需重新选择文件。<button className="button" disabled={confirming} onClick={async () => { setConfirming(true); setError(''); try { const saved = await recoverUploadReceipt(uploadToken); if (saved) { setReceipt(saved); setPending(false) } else setError('这批文件尚未保存，请选择原文件继续上传。') } catch (e) { setError((e as Error).message) } finally { setConfirming(false) } }}>确认上次提交结果</button></div>}{ended && !busy ? <div className="empty"><LockKeyhole size={30} /><h3>{c.status === 'active' ? '这项收集已截止' : c.status === 'paused' ? '这项收集已暂停' : '这项收集已结束'}</h3><p>请联系发起人了解下一步安排。</p>{error && <p className="error-text" role="alert">{error}</p>}</div> : <form ref={form} onSubmit={e => { e.preventDefault(); void submit() }}><fieldset disabled={busy || confirming}>
    {pending && <div className="form-note">已启用断点续传。刷新后重新填写原姓名和提交信息、选择原文件即可继续，分片保留 24 小时。<button type="button" className="text-button" onClick={async () => { setBusy(true); try { await discardUpload(uploadToken); setPending(false); setFeedback(null); setError(''); requestId.current = crypto.randomUUID() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>重新开始</button></div>}
    <label className="field">你的姓名<input value={name} onChange={e => { setName(e.target.value); requestId.current = crypto.randomUUID() }} required maxLength={30} placeholder="方便发起人知道文件来自你" autoComplete="name" /></label>
    {(c.fields || []).map(f => <label className="field" key={f.id}>{f.label}{!f.required && '（选填）'}<input value={fields[f.id] || ''} required={f.required} maxLength={80} onChange={e => setFields(old => ({ ...old, [f.id]: e.target.value }))} /></label>)}
    {replacement && <div className="replacement-note"><strong>正在替换原批次</strong><p>请重新选择这批完整文件。提交成功后原批次进入回收站，其他补交批次保持保留。</p><button type="button" className="text-button" onClick={() => setReplacement(undefined)}>取消替换，改为普通提交</button></div>}
    {c.maxFileSizeMB > effectiveFileLimit(c) && <p className="field-hint">当前服务器单次接收上限为 {c.requestLimitMB ?? 512} MB，单文件可上传上限已按此调整。</p>}
    {!!c.naming?.parts.length && <p className="field-hint">发起人已设置自动命名，原扩展名和原名记录会保留。</p>}
    <input ref={picker} type="file" multiple accept={fileExtensions(c.formats).map(s => `.${s}`).join(',')} className="sr-only" onChange={e => { addFiles(e.target.files); e.target.value = '' }} aria-label="选择提交文件" />
    <button type="button" className={`drop-zone ${dragging ? 'dragging' : ''}`} onClick={() => picker.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}><span><FileUp size={29} strokeWidth={1.5} /></span><strong>点击选择，或把文件拖到这里</strong><p>{c.formats}<br />单文件 ≤ {effectiveFileLimit(c)} MB · 每次最多 {c.maxFilesPerSubmission} 个<br />单次总量 ≤ {c.requestLimitMB || 512} MB</p></button>
    <UploadList files={files} feedback={feedback} busy={busy} onRetry={() => void submit()} onRemove={i => { setFiles(old => old.filter((_, index) => index !== i)); setFeedback(null); setError(''); requestId.current = crypto.randomUUID() }} />
    <div className="form-note">文件将保存到发起人的服务器，仅工作台授权成员可查看和下载。</div><button className="button primary submit-button" type="submit" disabled={!files.length}>{busy ? `上传中 ${progress}%` : feedback?.phase === 'paused' ? '继续上传' : error ? '重试并确认回执' : replacement ? `确认替换为 ${files.length} 份文件` : `提交${files.length ? ` ${files.length} 份` : ''}文件`}<ArrowRight size={16} /></button>
  </fieldset>{busy && <div className="upload-progress" role="status"><div className="progress"><span style={{ width: `${progress}%` }} /></div><p>{feedback?.phase === 'saving' ? '文件已传完，正在等待整批回执…' : feedback?.phase === 'preparing' ? '正在连接并读取续传记录…' : `已确认传输 ${progress}%`}<button type="button" className="text-button" onClick={() => controller.current?.abort()}>暂停上传</button></p></div>}{error && <p className="error-text" role="alert">{error}</p>}</form>}</>}</section><footer className="submission-bottom"><span><LockKeyhole size={13} />仅工作台授权成员可见</span><span>由集屿提供支持</span></footer></main>
}
