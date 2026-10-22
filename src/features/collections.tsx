import { useState } from 'react'
import { ArrowUpRight, CalendarDays, Link, Plus, Check, Copy, ExternalLink } from 'lucide-react'
import { CollectionIcon, Empty, Modal } from '../components/ui'
import type { Collection } from '../types'
import { collectionState, collectionStateNames } from '../lib/collections'

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

export { CollectionForm } from './collection-form'

export function ShareCollection({ collection, onClose, onRotate, busy, serverError }: { collection: Collection; onClose: () => void; onRotate: () => void; busy: boolean; serverError?: string }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const url = `${location.origin}/#/submit/${collection.uploadToken}`
  const [rotate, setRotate] = useState(false)
  return <Modal title="好文件，一个链接就能收齐" subtitle={collection.title} onClose={onClose}>
    <div className="share-art"><div><CollectionIcon category={collection.category} /><span className="share-art-link"><Link size={18} /></span></div><p>提交者无需登录，即可上传文件</p><small>持有链接的人可提交，请仅分享给参与本次收集的人。</small></div>
    <label className="field">收集链接<div className="copy-field"><input value={url} readOnly aria-label="收集链接" /><button className="icon-button" aria-label="复制链接" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setCopyError('') } catch { setCopied(false); setCopyError('无法自动复制，请选中上方链接手动复制。') } }}>{copied ? <Check size={18} /> : <Copy size={18} />}</button></div></label>
    {copied && <p className="success-text" role="status">链接已复制</p>}{copyError && <p className="error-text" role="alert">{copyError}</p>}
    {serverError && <p className="error-text" role="alert">{serverError}</p>}
    <div className="form-note">链接不提供他人文件列表或下载权限。提交者须凭本人私密回执查询或替换本批文件。暂停或结束收集可立即停止接收。</div>
    {rotate ? <div className="rotate-confirm"><p>重新生成后，之前分享的链接会立即失效。</p><button className="button" disabled={busy} onClick={() => setRotate(false)}>取消</button><button className="button" disabled={busy} onClick={() => { onRotate(); setRotate(false); setCopied(false) }}>确认更换链接</button></div> : <button className="text-button" onClick={() => setRotate(true)}>更换收集链接</button>}
    <footer className="modal-footer"><button className="button" onClick={onClose}>完成</button><a href={url} target="_blank" rel="noreferrer" className="button primary">预览提交页<ExternalLink size={15} /></a></footer>
  </Modal>
}
