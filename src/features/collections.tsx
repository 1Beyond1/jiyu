import { useState } from 'react'
import { ArrowUpRight, CalendarDays, Link, Plus, Check, Copy, ExternalLink } from 'lucide-react'
import { CollectionIcon, Empty, Modal } from '../components/ui'
import type { Collection } from '../types'

export function CollectionCard({ collection: c, onOpen, onShare }: { collection: Collection; onOpen: (id: string) => void; onShare: (c: Collection) => void }) {
  const percent = Math.min(100, Math.round(c.received / c.target * 100))
  return <article className={`collection-card ${c.category}`}>
    <div className="card-top"><CollectionIcon category={c.category} /><span className={`status ${c.status}`}><i />{c.status === 'active' ? '收集中' : c.status === 'completed' ? '已完成' : '已暂停'}</span></div>
    <button className="card-title" onClick={() => onOpen(c.id)}>{c.title}<ArrowUpRight size={16} /></button>
    <p className="card-description">{c.description}</p>
    <div className="card-progress-label"><span><b>{c.received}</b><span className="muted"> / {c.target} 份</span></span><span>{percent}%</span></div>
    <div className="progress"><span style={{ width: `${percent}%` }} /></div>
    <footer><span><CalendarDays size={13} />{c.deadline.slice(5).replace('-', '月')}日截止</span><button className="share-button" onClick={() => onShare(c)} aria-label={`分享${c.title}`}><Link size={14} /><span>分享收集</span></button></footer>
  </article>
}

export function Collections({ collections, onOpen, onShare, onCreate }: { collections: Collection[]; onOpen: (id: string) => void; onShare: (c: Collection) => void; onCreate: () => void }) {
  const [tab, setTab] = useState('all')
  const list = collections.filter(c => tab === 'all' || c.status === tab)
  return <><div className="page-title"><div><p className="eyebrow">COLLECTIONS</p><h1>让收集，有条不紊。</h1><p>一个链接收齐文件，进展尽在掌握。</p></div><button className="button primary" onClick={onCreate}><Plus size={17} />新建收集</button></div>
    <div className="tabs">{[['all', '全部收集'], ['active', '收集中'], ['completed', '已完成'], ['paused', '已暂停']].map(([value, label]) => <button className={tab === value ? 'active' : ''} key={value} onClick={() => setTab(value)}>{label}<span>{collections.filter(c => value === 'all' || c.status === value).length}</span></button>)}</div>
    {list.length ? <div className="collection-grid all-collections">{list.map(c => <CollectionCard key={c.id} collection={c} onOpen={onOpen} onShare={onShare} />)}<button className="create-card" onClick={onCreate}><span><Plus size={24} /></span><b>发起下一项收集</b><p>让文件自己找到归处</p></button></div> : <Empty title="暂无这类收集" text="新建一项收集，或切换其他状态查看。" />}
  </>
}

export function CreateCollection({ onClose, onCreate }: { onClose: () => void; onCreate: (c: Collection) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [target, setTarget] = useState(20)
  const [deadline, setDeadline] = useState('2026-10-31')
  const [category, setCategory] = useState<Collection['category']>('document')
  const [formats, setFormats] = useState('PDF, DOCX, XLSX, ZIP')
  return <Modal title="发起一项新收集" subtitle="设置好规则，剩下的交给一个链接。" onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); if (!title.trim()) return; onCreate({ id: crypto.randomUUID(), title: title.trim(), description: description.trim() || '期待每一份认真准备的文件', target, deadline, category, formats, received: 0, storage: 'local', status: 'active' }) }}>
      <label className="field">收集名称<input autoFocus required maxLength={50} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：十月设计素材收集" /></label>
      <label className="field">收集说明<textarea maxLength={150} value={description} onChange={e => setDescription(e.target.value)} placeholder="告诉提交者，你想收集什么…" rows={3} /></label>
      <div className="form-row"><label className="field">预计收集份数<input type="number" min={1} max={10000} required value={target} onChange={e => setTarget(Number(e.target.value))} /></label><label className="field">截止日期<input type="date" required value={deadline} onChange={e => setDeadline(e.target.value)} /></label></div>
      <div className="form-row"><label className="field">收集类型<select value={category} onChange={e => setCategory(e.target.value as Collection['category'])}><option value="document">文档资料</option><option value="design">设计素材</option><option value="photo">摄影图片</option></select></label><label className="field">存储位置<select><option>本地存储（演示）</option></select></label></div>
      <label className="field">允许的文件格式<input required value={formats} onChange={e => setFormats(e.target.value)} /><small>多个后缀用逗号分隔；单文件上限 100 MB。</small></label>
      <div className="form-note">界面预览：任务保存在当前浏览器，收集链接用于预览提交流程。</div>
      <footer className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" type="submit"><Plus size={16} />创建收集</button></footer>
    </form>
  </Modal>
}

export function ShareCollection({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const url = `${location.origin}/#/submit/${collection.id}`
  return <Modal title="好文件，一个链接就能收齐" subtitle={collection.title} onClose={onClose}>
    <div className="share-art"><div><CollectionIcon category={collection.category} /><span className="share-art-link"><Link size={18} /></span></div><p>提交者无需登录，即可选择文件</p><small>当前为同浏览器演示，尚未连接上传服务</small></div>
    <label className="field">收集链接<div className="copy-field"><input value={url} readOnly aria-label="收集链接" /><button className="icon-button" aria-label="复制链接" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true) } catch { setCopied(false) } }}>{copied ? <Check size={18} /> : <Copy size={18} />}</button></div></label>
    {copied && <p className="success-text" role="status">链接已复制</p>}
    <footer className="modal-footer"><button className="button" onClick={onClose}>完成</button><a href={url} target="_blank" rel="noreferrer" className="button primary">预览提交页<ExternalLink size={15} /></a></footer>
  </Modal>
}
