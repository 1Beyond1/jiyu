import { FileIcon } from '../components/ui'
import { X } from 'lucide-react'
import { formatSize } from '../lib/workspace'
import type { UploadFeedback, UploadFileState } from '../types'

const labels: Record<UploadFileState, string> = { queued: '等待上传', checking: '核对已传分片', uploading: '正在上传', retrying: '连接重试中', uploaded: '已传完，等待整批回执', saving: '整批校验保存中', received: '已收到回执', paused: '已暂停', failed: '此文件上传未完成' }
export function UploadList({ files, feedback, busy, onRemove, onRetry }: { files: File[]; feedback: UploadFeedback | null; busy: boolean; onRemove: (index: number) => void; onRetry: () => void }) {
  if (!files.length) return null
  return <div className="upload-file-list" aria-label="文件上传状态">{files.map((f, i) => {
    const item = feedback?.files[i], state = item?.state || 'queued'
    const percent = f.size ? Math.round((item?.sentBytes || 0) / f.size * 100) : ['uploaded', 'saving', 'received'].includes(state) ? 100 : 0
    return <div className={`upload-file ${state}`} key={`${f.name}-${i}`}><FileIcon name={f.name} /><div className="upload-file-body"><strong>{f.name}</strong><div className="upload-file-status"><span>{labels[state]}</span><span>{formatSize(item?.sentBytes || 0)} / {formatSize(f.size)}</span></div><progress aria-label={`${f.name}上传进度`} value={percent} max={100} /><small>{item?.message || (state === 'queued' ? '按顺序上传，所有文件一起保存。' : state === 'uploaded' || state === 'saving' ? '文件已传输，取得整批回执后才算提交成功。' : '')}</small>{!busy && ['failed', 'paused'].includes(state) && <button className="text-button" type="button" onClick={onRetry}>{state === 'paused' ? '继续此文件并完成提交' : '重试此文件并继续'}</button>}</div>{!busy && <button type="button" className="icon-button" aria-label={`移除${f.name}`} onClick={() => onRemove(i)}><X size={15} /></button>}</div>
  })}{feedback && feedback.phase !== 'received' && <p className="field-hint">重试会先核对已传分片，再继续整批提交。更换姓名、字段或文件清单会开始新批次。</p>}</div>
}
