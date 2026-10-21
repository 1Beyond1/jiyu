import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, FileUp, LockKeyhole, X } from 'lucide-react'
import { Brand, FileIcon } from '../components/ui'
import { api, uploadFiles, discardUpload, hasPendingUpload } from '../lib/api'
import { fileExtensions, isExpired, submissionError } from '../lib/collections'
import { formatSize } from '../lib/workspace'
import type { Collection, UploadReceipt } from '../types'

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
  const [files, setFiles] = useState<File[]>([]), [name, setName] = useState(''), [error, setError] = useState(''), [receipt, setReceipt] = useState<UploadReceipt | null>(null)
  const [dragging, setDragging] = useState(false), [progress, setProgress] = useState(0), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now)
  const [pending, setPending] = useState(() => hasPendingUpload(uploadToken))
  const picker = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null), requestId = useRef(crypto.randomUUID())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => { clearInterval(timer); controller.current?.abort() } }, [])
  const ended = c.status !== 'active' || isExpired(c, now)
  function addFiles(incoming: FileList | null) {
    if (!incoming || busy) return
    const next = [...files]
    for (const file of Array.from(incoming)) if (!next.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) next.push(file)
    const invalid = submissionError(c, next)
    if (invalid) { setError(invalid); return }
    if (next.reduce((sum, f) => sum + f.size, 0) > (c.requestLimitMB || 512) * 1024 ** 2) { setError(`单次提交总量不能超过 ${c.requestLimitMB || 512} MB`); return }
    setFiles(next); setError(''); requestId.current = crypto.randomUUID()
  }
  return <main className="submission-page"><div className="submission-top"><Brand /><span className="preview-badge">文件提交</span></div><section className="submission-card">{receipt ? <div className="submission-success"><CheckCircle2 size={52} strokeWidth={1.4} /><p className="eyebrow">ALL SET</p><h1>每一份认真，都已收到。</h1><p>{receipt.filesCount} 份文件已保存到发起人的服务器。</p><div className="receipt-box"><span>提交回执</span><code>{receipt.receiptId}</code><small>共 {formatSize(receipt.bytes)} · 请保留回执，方便联系发起人。</small></div></div> : <><span className="submission-kicker">{ownerName} 邀请你提交文件</span><h1>{c.title}</h1><p className="submission-description">{c.description}</p><div className="submission-meta"><span>截止 {c.deadline}</span><span>已收到 {c.received} 份</span></div>{ended && !busy ? <div className="empty"><LockKeyhole size={30} /><h3>{c.status === 'active' ? '这项收集已截止' : c.status === 'paused' ? '这项收集已暂停' : '这项收集已结束'}</h3><p>请联系发起人了解下一步安排。</p></div> : <form onSubmit={async e => {
    e.preventDefault(); const invalid = submissionError(c, files)
    if (invalid || !name.trim()) { setError(invalid || '请填写你的姓名'); return }
    setBusy(true); setPending(true); setError(''); setProgress(0); controller.current = new AbortController()
    try { setReceipt(await uploadFiles(uploadToken, files, name.trim(), requestId.current, setProgress, controller.current.signal)) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }}><fieldset disabled={busy}>
    {pending && <div className="form-note">已启用断点续传。刷新后重新填写原姓名、选择原文件即可继续，分片保留 24 小时。<button type="button" className="text-button" onClick={async () => { setBusy(true); try { await discardUpload(uploadToken); setPending(false); setError(''); requestId.current = crypto.randomUUID() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>重新开始</button></div>}
    <label className="field">你的姓名<input value={name} onChange={e => { setName(e.target.value); requestId.current = crypto.randomUUID() }} required maxLength={30} placeholder="方便发起人知道文件来自你" autoComplete="name" /></label>
    <input ref={picker} type="file" multiple accept={fileExtensions(c.formats).map(s => `.${s}`).join(',')} className="sr-only" onChange={e => { addFiles(e.target.files); e.target.value = '' }} aria-label="选择提交文件" />
    <button type="button" className={`drop-zone ${dragging ? 'dragging' : ''}`} onClick={() => picker.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}><span><FileUp size={29} strokeWidth={1.5} /></span><strong>点击选择，或把文件拖到这里</strong><p>{c.formats}<br />单文件 ≤ {c.maxFileSizeMB} MB · 每次最多 {c.maxFilesPerSubmission} 个<br />单次总量 ≤ {c.requestLimitMB || 512} MB</p></button>
    {!!files.length && <div className="upload-list">{files.map((f, i) => <div key={`${f.name}-${i}`}><FileIcon name={f.name} /><span>{f.name}<small>{formatSize(f.size)}</small></span><button type="button" className="icon-button" aria-label={`移除${f.name}`} onClick={() => { setFiles(files.filter((_, index) => index !== i)); setError(''); requestId.current = crypto.randomUUID() }}><X size={15} /></button></div>)}</div>}
    <div className="form-note">文件将保存到发起人的服务器，仅工作台授权成员可查看和下载。</div><button className="button primary submit-button" type="submit" disabled={!files.length}>{busy ? `上传中 ${progress}%` : error ? '重试提交' : `提交${files.length ? ` ${files.length} 份` : ''}文件`}<ArrowRight size={16} /></button>
  </fieldset>{busy && <div className="upload-progress" role="status"><div className="progress"><span style={{ width: `${progress}%` }} /></div><p>{progress >= 99 ? '正在校验并保存，请稍候…' : `正在上传 ${progress}%`}<button type="button" className="text-button" onClick={() => controller.current?.abort()}>暂停上传</button></p></div>}{error && <p className="error-text" role="alert">{error}</p>}</form>}</>}</section><footer className="submission-bottom"><span><LockKeyhole size={13} />仅工作台授权成员可见</span><span>由集屿提供支持</span></footer></main>
}
