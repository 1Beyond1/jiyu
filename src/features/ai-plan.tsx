import { Check, Info } from 'lucide-react'
import { FileIcon, Modal } from '../components/ui'
import type { AIReply } from '../types'

export function AIPlan({ proposal, busy, error, onClose, onApply }: { proposal: AIReply; busy: boolean; error: string; onClose: () => void; onApply: () => void }) {
  return <Modal title="确认这份命名建议" subtitle={`模型建议 · ${proposal.changes.length} 个文件 · 确认后才会修改`} onClose={onClose} wide><p className="body-copy">{proposal.reply}</p><div className="rename-preview"><div className="rename-labels"><span>当前文件名</span><span>模型建议</span></div>{proposal.changes.map(change => <div className="rename-row" key={change.id}><span><FileIcon name={change.oldName} />{change.oldName}</span><span aria-hidden="true">→</span><strong>{change.name}</strong></div>)}</div><div className="form-note"><Info size={15} />服务器会再次检查原文件名和重名；方案 30 分钟内有效。应用后可使用现有撤销功能恢复名称。</div>{error && <p className="error-text" role="alert">{error}</p>}<footer className="modal-footer"><button className="button" disabled={busy} onClick={onClose}>暂不应用</button><button className="button primary" disabled={busy} onClick={onApply}><Check size={15} />{busy ? '正在保存…' : `确认修改 ${proposal.changes.length} 个文件`}</button></footer></Modal>
}
