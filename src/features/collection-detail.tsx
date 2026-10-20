import { useState } from 'react'
import { ArrowLeft, Check, CirclePause, Link, Pencil, Play } from 'lucide-react'
import { CollectionIcon, Modal } from '../components/ui'
import { FileTable } from './files'
import { collectionState, collectionStateNames, isExpired } from '../lib/collections'
import type { CollectedFile, Collection, CollectionStatus } from '../types'

interface CollectionDetailProps {
  collection: Collection
  files: CollectedFile[]
  onBack: () => void
  onEdit: () => void
  onShare: () => void
  onStatus: (status: CollectionStatus) => void
  onRename: (files: CollectedFile[]) => void
  onReview: (ids: string[]) => void
  onDetail: (file: CollectedFile) => void
}

export function CollectionDetail({ collection: c, files, onBack, onEdit, onShare, onStatus, onRename, onReview, onDetail }: CollectionDetailProps) {
  const [confirm, setConfirm] = useState<CollectionStatus | null>(null)
  const state = collectionState(c)
  const pending = files.filter(f => f.status === 'pending').length
  const percent = Math.min(100, Math.round(c.received / c.target * 100))
  const expired = isExpired(c)
  const actions = c.status === 'active' ? [
    { status: 'paused' as const, label: '暂停收集', icon: CirclePause },
    { status: 'completed' as const, label: '结束收集', icon: Check },
  ] : [
    { status: 'active' as const, label: '重新开放', icon: Play },
    ...(c.status === 'paused' ? [{ status: 'completed' as const, label: '结束收集', icon: Check }] : []),
  ]
  const confirmTitle = confirm === 'active' ? '重新开放这项收集？' : confirm === 'paused' ? '暂停这项收集？' : '结束这项收集？'
  return <>
    <button className="text-button collection-back" onClick={onBack}><ArrowLeft size={15} />全部收集</button>
    <div className="page-title collection-detail-title"><div><div className="collection-detail-kicker"><CollectionIcon category={c.category} /><span className={`status ${state}`}><i />{collectionStateNames[state]}</span></div><h1>{c.title}</h1><p>{c.description}</p></div><div className="button-row"><button className="button" onClick={onEdit}><Pencil size={15} />编辑规则</button><button className="button primary" onClick={onShare}><Link size={15} />分享收集</button></div></div>
    <section className="collection-brief" aria-label="收集进度与规则">
      <div className="collection-progress-summary"><p>收集进度<span>{percent}%</span></p><strong>{c.received}<small> / {c.target} 份</small></strong><div className="progress"><span style={{ width: `${percent}%` }} /></div><small>目标份数仅作进度参考</small></div>
      <dl><div><dt>截止时间</dt><dd>{c.deadline}<small>当天 23:59 · UTC+8</small></dd></div><div><dt>提交规则</dt><dd>单文件 ≤ {c.maxFileSizeMB} MB<small>每次最多 {c.maxFilesPerSubmission} 个文件</small></dd></div><div><dt>允许格式</dt><dd className="collection-formats">{c.formats}</dd></div></dl>
    </section>
    <div className="collection-lifecycle"><p>{state === 'active' ? '收集链接已开放，可以继续接收演示记录。' : state === 'expired' ? '已超过截止时间。延长截止日期后即可继续收集。' : state === 'paused' ? '收集已暂停，提交页暂不接收文件。' : '收集已结束，已收到的文件记录仍可整理。'}</p><div className="button-row">{actions.map(a => <button key={a.status} className="text-button" disabled={a.status === 'active' && expired} onClick={() => setConfirm(a.status)}><a.icon size={14} />{a.label}</button>)}</div>{expired && c.status !== 'active' && <small>延长截止日期后可重新开放</small>}</div>
    <div className="section-heading"><h2>收到的文件<span className="count-badge">{files.length}</span></h2><span className="muted">{pending} 份待整理 · 演示记录</span></div>
    <FileTable key={c.id} files={files} collections={[c]} onRename={onRename} onReview={onReview} onDetail={onDetail} />
    <div className="collection-detail-note">示例任务的进度包含历史演示数量，列表仅展示部分样本。新建任务按实际演示记录计数。</div>
    {confirm && <Modal title={confirmTitle} subtitle={c.title} onClose={() => setConfirm(null)}><p className="body-copy">{confirm === 'active' ? '原收集链接将再次接受提交，现有文件记录会保留。' : confirm === 'paused' ? '暂停后，原收集链接暂不接受提交。你可以随时重新开放，已收到的记录会保留。' : '结束后，原收集链接将停止接收提交。已收到的记录会保留，你也可以在截止日期内重新开放。'}</p><footer className="modal-footer"><button className="button" onClick={() => setConfirm(null)}>取消</button><button className="button primary" onClick={() => { onStatus(confirm); setConfirm(null) }}>{confirm === 'active' ? '重新开放' : confirm === 'paused' ? '暂停收集' : '结束收集'}</button></footer></Modal>}
  </>
}
