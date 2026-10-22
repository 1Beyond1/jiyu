import { useState } from 'react'
import { ArrowLeft, Check, CirclePause, Link, Pencil, Play } from 'lucide-react'
import { CollectionIcon, Modal } from '../components/ui'
import { FileTable } from './files'
import { collectionState, collectionStateNames, isExpired } from '../lib/collections'
import type { CollectedFile, Collection, CollectionStatus } from '../types'
import { ParticipantLedger } from './participants'
import { SaveTemplate } from './collection-templates'
import { useAccount } from './auth'

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
  onTrash?: (ids: string[]) => void
  onAI?: (files: CollectedFile[]) => void
}

export function CollectionDetail({ collection: c, files, onBack, onEdit, onShare, onStatus, onRename, onReview, onDetail, onTrash, onAI }: CollectionDetailProps) {
  const [confirm, setConfirm] = useState<CollectionStatus | null>(null)
  const [tab, setTab] = useState('files'), [selected, setSelected] = useState<{ ids: string[]; label: string } | null>(null), [saveTemplate, setSaveTemplate] = useState(false)
  const { canEdit } = useAccount()
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
    <div className="page-title collection-detail-title"><div><div className="collection-detail-kicker"><CollectionIcon category={c.category} /><span className={`status ${state}`}><i />{collectionStateNames[state]}</span></div><h1>{c.title}</h1><p>{c.description}</p></div><div className="button-row">{canEdit && onAI && <button className="button" onClick={() => onAI(files)}>检查这项收集</button>}<button className="button" onClick={onEdit}><Pencil size={15} />编辑规则</button><button className="button primary" onClick={onShare}><Link size={15} />分享收集</button></div></div>
    <section className="collection-brief" aria-label="收集进度与规则">
      <div className="collection-progress-summary"><p>累计接收进度<span>{percent}%</span></p><strong>{c.received}<small> / {c.target} 份</small></strong><div className="progress"><span style={{ width: `${percent}%` }} /></div><small>累计含替换前文件；有效文件见下方</small></div>
      <dl><div><dt>截止时间</dt><dd>{c.deadline}<small>当天 23:59 · UTC+8</small></dd></div><div><dt>提交规则</dt><dd>单文件 ≤ {c.maxFileSizeMB} MB<small>每次最多 {c.maxFilesPerSubmission} 个文件</small></dd></div><div><dt>允许格式</dt><dd className="collection-formats">{c.formats}</dd></div></dl>
    </section>
    <div className="collection-lifecycle"><p>{state === 'active' ? '收集链接已开放，可以接收文件。' : state === 'expired' ? '已超过截止时间。延长截止日期后即可继续收集。' : state === 'paused' ? '收集已暂停，提交页暂不接收文件。' : '收集已结束，已收到的文件仍可整理。'}</p><div className="button-row">{actions.map(a => <button key={a.status} className="text-button" disabled={a.status === 'active' && expired} onClick={() => setConfirm(a.status)}><a.icon size={14} />{a.label}</button>)}</div>{expired && c.status !== 'active' && <small>延长截止日期后可重新开放</small>}</div>
    <div className="collection-workflow-bar"><div className="tabs"><button className={tab === 'files' ? 'active' : ''} onClick={() => { setTab('files'); setSelected(null) }}>收到的文件（{files.length}）</button><button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>提交人 / 未交名单</button></div>{canEdit && <button className="text-button" onClick={() => setSaveTemplate(true)}>保存为模板</button>}</div>
    {tab === 'people' && <ParticipantLedger collection={c} revision={JSON.stringify([c.expectedSubmitters, files])} onSelect={(ids, label) => setSelected(ids ? { ids, label: label || '' } : null)} />}
    {(tab === 'files' || selected) && <><div className="section-heading"><h2>{selected ? `${selected.label}的文件` : '收到的文件'}</h2><span className="muted">{selected ? `${selected.ids.length} 份` : `${pending} 份待整理`}</span></div><FileTable key={`${c.id}-${selected?.label || 'all'}`} files={selected ? files.filter(f => selected.ids.includes(f.id)) : files} collections={[c]} onRename={onRename} onReview={onReview} onDetail={onDetail} onTrash={onTrash} onAI={onAI} /></>}
    {saveTemplate && <SaveTemplate collectionId={c.id} title={c.title} onClose={() => setSaveTemplate(false)} />}
    <div className="collection-detail-note">文件由工作台授权成员查看和下载。云端同步后仍保留本机副本，任务总容量包含回收站文件。</div>
    {confirm && <Modal title={confirmTitle} subtitle={c.title} onClose={() => setConfirm(null)}><p className="body-copy">{confirm === 'active' ? '原收集链接将再次接受提交，现有文件记录会保留。' : confirm === 'paused' ? '暂停后，原收集链接暂不接受提交。你可以随时重新开放，已收到的记录会保留。' : '结束后，原收集链接将停止接收提交。已收到的记录会保留，你也可以在截止日期内重新开放。'}</p><footer className="modal-footer"><button className="button" onClick={() => setConfirm(null)}>取消</button><button className="button primary" onClick={() => { onStatus(confirm); setConfirm(null) }}>{confirm === 'active' ? '重新开放' : confirm === 'paused' ? '暂停收集' : '结束收集'}</button></footer></Modal>}
  </>
}
