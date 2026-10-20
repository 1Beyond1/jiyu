import { Check, Info } from 'lucide-react'
import { FileIcon, Modal } from '../components/ui'
import type { AIReply } from '../types'

export function AIPlan({ proposal, busy, error, onClose, onApply }: { proposal: AIReply; busy: boolean; error: string; onClose: () => void; onApply: () => void }) {
  const count = new Set([...proposal.changes.map(c => c.id), ...(proposal.tags || []).map(c => c.id)]).size
  return <Modal title="确认这份整理建议" subtitle={`模型建议 · ${count} 个文件 · 确认后才会修改`} onClose={onClose} wide>
    <p className="body-copy">{proposal.reply}</p>
    {!!proposal.changes.length && <div className="rename-preview"><div className="rename-labels"><span>当前文件名</span><span>模型建议</span></div>{proposal.changes.map(change => <div className="rename-row" key={change.id}><span><FileIcon name={change.oldName} />{change.oldName}</span><span aria-hidden="true">→</span><strong>{change.name}</strong></div>)}</div>}
    {!!proposal.tags?.length && <div className="classification-preview"><h3>分类标签</h3>{proposal.tags.map(change => <div key={change.id}><strong>{change.name}</strong><p>原标签：{change.oldTags.join('、') || '无'}</p><div className="file-tags">{change.tags.map(tag => <span key={tag}>{tag}</span>)}{!change.tags.length && <small>清除标签</small>}</div></div>)}</div>}
    <div className="form-note"><Info size={15} />服务器会再次检查文件名、分类状态和重名；方案 30 分钟内有效。应用后可撤销此次名称与分类修改。</div>{error && <p className="error-text" role="alert">{error}</p>}
    <footer className="modal-footer"><button className="button" disabled={busy} onClick={onClose}>暂不应用</button><button className="button primary" disabled={busy} onClick={onApply}><Check size={15} />{busy ? '正在保存…' : `确认整理 ${count} 个文件`}</button></footer>
  </Modal>
}
