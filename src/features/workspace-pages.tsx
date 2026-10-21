import { useAccount } from './auth'
import { useState } from 'react'
import { ArrowRight, FileDown, FolderInput, ScanLine, Sparkles, WandSparkles } from 'lucide-react'
import { Modal } from '../components/ui'
import type { Workspace } from '../types'
import { csvCell, downloadText, formatSize } from '../lib/workspace'

export function ToolsPage({ workspace, onRename, onFiles, onAI }: { workspace: Workspace; onRename: () => void; onFiles: () => void; onAI: () => void }) {
  const { canEdit } = useAccount()
  const [duplicates, setDuplicates] = useState(false)
  const groups = new Map<string, typeof workspace.files>()
  for (const file of workspace.files) if (file.sha256) groups.set(file.sha256, [...(groups.get(file.sha256) || []), file])
  const matches = [...groups.values()].filter(files => files.length > 1)
  const tools = [
    { icon: WandSparkles, title: '批量重命名', description: '按任务、提交人、日期统一命名，先预览再应用。', example: '任务名_提交人_序号.pdf', label: '开始重命名', action: onRename, color: 'green' },
    { icon: FolderInput, title: '按收集分类', description: '按任务、提交人筛选，快速找到所需文件。', example: '每一份文件，都有自己的位置', label: '整理文件', action: onFiles, color: 'blue' },
    { icon: FileDown, title: '导出文件清单', description: '把文件名称、提交人和大小导出为 CSV。', example: `${workspace.files.length} 条文件记录，随时带走`, label: '导出清单', action: () => downloadText('集屿-文件清单.csv', '\uFEFF文件名称,提交人,文件大小\n' + workspace.files.map(f => [f.name, f.owner, formatSize(f.size)].map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8'), color: 'amber' },
    { icon: ScanLine, title: '重复文件检查', description: '按上传时的 SHA-256 校验值识别相同内容。', example: matches.length ? `${matches.length} 组内容相同的文件` : '目前没有发现重复文件', label: '查看检查结果', action: () => setDuplicates(true), color: 'violet' },
  ]
  return <><div className="page-title"><div><p className="eyebrow">ORGANIZE WITH EASE</p><h1>少一点重复，多一点有序。</h1><p>把繁琐的整理工作，变成一次轻松的操作。</p></div></div><div className="tools-grid">{tools.map(t => <article className="tool-card" key={t.title}><span className={`tool-icon ${t.color}`}><t.icon size={25} strokeWidth={1.5} /></span><h2>{t.title}</h2><p>{t.description}</p><code>{t.example}</code><button disabled={!canEdit && t.title === '批量重命名'} onClick={t.action}>{t.label}<ArrowRight size={16} /></button></article>)}</div><div className="ai-banner"><div className="ai-banner-symbol"><Sparkles size={25} /></div><div><h3>先看看建议，再决定怎么整理。</h3><p>可用内置规则，也可配置自己的模型；整理建议确认后才会应用。</p></div><button className="button" disabled={!canEdit} onClick={onAI}>打开助手<ArrowRight size={15} /></button></div>
    {duplicates && <Modal title="重复文件检查" subtitle={`找到 ${matches.length} 组内容相同的文件`} onClose={() => setDuplicates(false)}>{matches.length ? <div className="duplicate-list">{matches.map((files, i) => <div key={files[0].sha256}><strong>第 {i + 1} 组 · {formatSize(files[0].size)}</strong>{files.map(f => <p key={f.id}>{f.name}<small>{f.owner}</small></p>)}</div>)}</div> : <p className="body-copy">当前文件列表中没有发现 SHA-256 相同的文件。</p>}<div className="form-note">只显示检查结果，不会自动删除文件。请在文件管理中检查后决定是否移入回收站。</div><footer className="modal-footer"><button className="button primary" onClick={() => setDuplicates(false)}>完成</button></footer></Modal>}
  </>
}
