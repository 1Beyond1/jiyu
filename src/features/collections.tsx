import { useState } from 'react'
import { ArrowUpRight, CalendarDays, Link, Plus, Check, Copy, ExternalLink } from 'lucide-react'
import { CollectionIcon, Empty, Modal } from '../components/ui'
import type { Collection } from '../types'
import { collectionState, collectionStateNames, defaultCollectionLimits, fileExtensions, localDate, nextWeek } from '../lib/collections'

export function CollectionCard({ collection: c, onOpen, onShare }: { collection: Collection; onOpen: (id: string) => void; onShare: (c: Collection) => void }) {
  const percent = Math.min(100, Math.round(c.received / c.target * 100))
  const state = collectionState(c)
  return <article className={`collection-card ${c.category}`}>
    <div className="card-top"><CollectionIcon category={c.category} /><span className={`status ${state}`}><i />{collectionStateNames[state]}</span></div>
    <button className="card-title" onClick={() => onOpen(c.id)}>{c.title}<ArrowUpRight size={16} /></button>
    <p className="card-description">{c.description}</p>
    <div className="card-progress-label"><span><b>{c.received}</b><span className="muted"> / {c.target} 份</span></span><span>{percent}%</span></div>
    <div className="progress"><span style={{ width: `${percent}%` }} /></div>
    <footer><span><CalendarDays size={13} />{c.deadline.slice(5).replace('-', '月')}日截止</span><button className="share-button" onClick={() => onShare(c)} aria-label={`分享${c.title}`}><Link size={14} /><span>分享收集</span></button></footer>
  </article>
}

export function Collections({ collections, onOpen, onShare, onCreate }: { collections: Collection[]; onOpen: (id: string) => void; onShare: (c: Collection) => void; onCreate: () => void }) {
  const [tab, setTab] = useState('all')
  const list = collections.filter(c => tab === 'all' || collectionState(c) === tab)
  return <><div className="page-title"><div><p className="eyebrow">COLLECTIONS</p><h1>让收集，有条不紊。</h1><p>一个链接收齐文件，进展尽在掌握。</p></div><button className="button primary" onClick={onCreate}><Plus size={17} />新建收集</button></div>
    <div className="tabs collection-tabs">{[['all', '全部收集'], ['active', '收集中'], ['completed', '已完成'], ['paused', '已暂停'], ['expired', '已截止']].map(([value, label]) => <button className={tab === value ? 'active' : ''} key={value} onClick={() => setTab(value)}>{label}<span>{collections.filter(c => value === 'all' || collectionState(c) === value).length}</span></button>)}</div>
    {list.length ? <div className="collection-grid all-collections">{list.map(c => <CollectionCard key={c.id} collection={c} onOpen={onOpen} onShare={onShare} />)}<button className="create-card" onClick={onCreate}><span><Plus size={24} /></span><b>发起下一项收集</b><p>让文件自己找到归处</p></button></div> : <Empty title="暂无这类收集" text="新建一项收集，或切换其他状态查看。" />}
  </>
}

export function CollectionForm({ collection, onClose, onSave }: { collection?: Collection; onClose: () => void; onSave: (c: Collection) => void }) {
  const [title, setTitle] = useState(collection?.title || '')
  const [description, setDescription] = useState(collection?.description || '')
  const [target, setTarget] = useState(collection?.target || 20)
  const [deadline, setDeadline] = useState(collection?.deadline || nextWeek())
  const [category, setCategory] = useState<Collection['category']>(collection?.category || 'document')
  const [formats, setFormats] = useState(collection?.formats || 'PDF, DOCX, XLSX, ZIP')
  const [maxFileSizeMB, setMaxFileSizeMB] = useState(collection?.maxFileSizeMB || defaultCollectionLimits.maxFileSizeMB)
  const [maxFilesPerSubmission, setMaxFilesPerSubmission] = useState(collection?.maxFilesPerSubmission || defaultCollectionLimits.maxFilesPerSubmission)
  const [error, setError] = useState('')
  return <Modal title={collection ? '编辑收集规则' : '发起一项新收集'} subtitle={collection ? '修改会同步到原有收集链接，已收到的记录会保留。' : '设置好规则，剩下的交给一个链接。'} onClose={onClose}>
    <form onSubmit={e => {
      e.preventDefault()
      const extensions = fileExtensions(formats)
      if (!title.trim()) { setError('请填写收集名称。'); return }
      if (!extensions.length || extensions.length > 20 || extensions.some(ext => !/^[a-z0-9]{1,12}$/.test(ext))) { setError('请填写有效的文件后缀，例如 PDF, JPG, ZIP，最多 20 种。'); return }
      onSave({ id: collection?.id || crypto.randomUUID(), title: title.trim(), description: description.trim() || '期待每一份认真准备的文件', target, deadline, category, formats: extensions.join(', ').toUpperCase(), received: collection?.received || 0, storage: collection?.storage || 'local', status: collection?.status || 'active', maxFileSizeMB, maxFilesPerSubmission })
    }}>
      <label className="field">收集名称<input autoFocus required maxLength={50} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：十月设计素材收集" /></label>
      <label className="field">收集说明<textarea maxLength={150} value={description} onChange={e => setDescription(e.target.value)} placeholder="告诉提交者，你想收集什么…" rows={3} /></label>
      <div className="form-row"><label className="field">预计收集份数<input type="number" min={1} max={10000} required value={target} onChange={e => setTarget(Number(e.target.value))} /><small>用于进度参考，收齐后仍可继续提交。</small></label><label className="field">截止日期<input type="date" required min={!collection || collection.status === 'active' ? localDate() : undefined} value={deadline} onChange={e => setDeadline(e.target.value)} /><small>截至当天 23:59（UTC+8）。</small></label></div>
      <div className="form-row"><label className="field">收集类型<select value={category} onChange={e => setCategory(e.target.value as Collection['category'])}><option value="document">文档资料</option><option value="design">设计素材</option><option value="photo">摄影图片</option></select></label><label className="field">存储位置<select><option>本地存储（演示）</option></select></label></div>
      <label className="field">允许的文件格式<input required maxLength={260} value={formats} onChange={e => setFormats(e.target.value)} /><small>多个后缀用逗号分隔，例如 PDF, JPG, ZIP。</small></label>
      <div className="form-row"><label className="field">单文件上限（MB）<input type="number" required min={1} max={1024} value={maxFileSizeMB} onChange={e => setMaxFileSizeMB(Number(e.target.value))} /></label><label className="field">每次最多提交（个）<input type="number" required min={1} max={100} value={maxFilesPerSubmission} onChange={e => setMaxFilesPerSubmission(Number(e.target.value))} /></label></div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="form-note">界面预览：任务保存在当前浏览器，收集链接用于预览提交流程。</div>
      <footer className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" type="submit"><Check size={16} />{collection ? '保存修改' : '创建收集'}</button></footer>
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
