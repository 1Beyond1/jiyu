import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, FileUp, LockKeyhole, X } from 'lucide-react'
import { Brand, FileIcon } from '../components/ui'
import type { CollectedFile, Collection } from '../types'
import { formatSize } from '../lib/workspace'

export function Submission({ collection, ownerName, onSubmit }: { collection?: Collection; ownerName: string; onSubmit: (files: CollectedFile[]) => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  if (!collection) return <main className="submission-page"><Brand /><div className="submission-card"><h1>没有找到这项收集</h1><p>这可能是另一个浏览器中的演示链接。请回到工作台重新预览。</p><a className="button primary" href="#/overview">返回工作台<ArrowRight size={15} /></a></div></main>
  const c = collection
  const ended = c.status !== 'active' || new Date(`${c.deadline}T23:59:59+08:00`).getTime() < Date.now()
  function addFiles(incoming: FileList | File[] | null) {
    if (!incoming) return
    const extensions = c.formats.split(/[,，\s]+/).map(s => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
    const list = Array.from(incoming)
    const invalid = list.find(f => f.size > 100 * 1024 * 1024 || !extensions.includes(f.name.split('.').pop()?.toLowerCase() || ''))
    if (invalid) { setError(`「${invalid.name}」不符合格式要求或超过 100 MB，请重新选择。`); return }
    setError('')
    setFiles(old => [...old, ...list.filter(f => !old.some(o => o.name === f.name && o.size === f.size))])
  }
  return <main className="submission-page"><div className="submission-top"><Brand /><span className="preview-badge">提交页预览</span></div><section className="submission-card">{submitted ? <div className="submission-success"><CheckCircle2 size={52} strokeWidth={1.4} /><p className="eyebrow">ALL SET</p><h1>每一份认真，都已收到。</h1><p>演示提交完成，{files.length} 条文件记录已添加到工作台。</p><div className="form-note">本次仅保存文件名、大小等信息，没有上传或保存文件内容。</div><a className="button primary" href="#/overview">返回工作台<ArrowRight size={16} /></a></div> : <><span className="submission-kicker">{ownerName} 邀请你提交文件</span><h1>{c.title}</h1><p className="submission-description">{c.description}</p><div className="submission-meta"><span>截止 {c.deadline}</span><span>已收到 {c.received} 份</span></div>{ended ? <div className="empty"><LockKeyhole size={30} /><h3>这项收集已暂停或结束</h3><p>请联系收集发起人了解下一步安排。</p></div> : <form onSubmit={e => { e.preventDefault(); if (!files.length) { setError('请先选择要提交的文件。'); return } const date = new Date().toISOString(); onSubmit(files.map(f => ({ id: crypto.randomUUID(), name: f.name, size: f.size, collectionId: c.id, owner: name.trim(), createdAt: date, storage: c.storage, status: 'pending' }))); setSubmitted(true) }}>
    <label className="field">你的姓名<input value={name} onChange={e => setName(e.target.value)} required maxLength={30} placeholder="方便发起人知道这份文件来自你" /></label>
    <input ref={picker} type="file" multiple accept={c.formats.split(/[,，\s]+/).filter(Boolean).map(s => `.${s.replace(/^\./, '').toLowerCase()}`).join(',')} className="sr-only" onChange={e => { addFiles(e.target.files); e.target.value = '' }} aria-label="选择提交文件" />
    <button type="button" className={`drop-zone ${dragging ? 'dragging' : ''}`} onClick={() => picker.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}><span><FileUp size={29} strokeWidth={1.5} /></span><strong>点击选择，或把文件拖到这里</strong><p>{c.formats} · 单文件不超过 100 MB</p></button>
    {!!files.length && <div className="upload-list">{files.map((f, i) => <div key={`${f.name}-${i}`}><FileIcon name={f.name} /><span>{f.name}<small>{formatSize(f.size)}</small></span><button type="button" className="icon-button" aria-label={`移除${f.name}`} onClick={() => setFiles(files.filter((_, index) => i !== index))}><X size={15} /></button></div>)}</div>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="form-note">界面演示：只记录文件信息，不上传文件内容。</div><button type="submit" className="button primary submit-button"><Check size={16} />提交演示记录</button>
  </form>}</> }</section><footer className="submission-bottom"><a href="#/overview"><ArrowLeft size={13} />返回工作台</a><span>由归集提供支持 · 让文件，各得其所</span></footer></main>
}
