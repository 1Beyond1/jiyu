import { useEffect, useState } from 'react'
import { ArrowRight, Cloud, Database, FileDown, FolderInput, HardDrive, LockKeyhole, ScanLine, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react'
import { Modal } from '../components/ui'
import type { Workspace } from '../types'
import { csvCell, downloadText, formatSize } from '../lib/workspace'
import { api } from '../lib/api'


export function ToolsPage({ workspace, onRename, onFiles, onAI }: { workspace: Workspace; onRename: () => void; onFiles: () => void; onAI: () => void }) {
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
  return <><div className="page-title"><div><p className="eyebrow">ORGANIZE WITH EASE</p><h1>少一点重复，多一点有序。</h1><p>把繁琐的整理工作，变成一次轻松的操作。</p></div></div><div className="tools-grid">{tools.map(t => <article className="tool-card" key={t.title}><span className={`tool-icon ${t.color}`}><t.icon size={25} strokeWidth={1.5} /></span><h2>{t.title}</h2><p>{t.description}</p><code>{t.example}</code><button onClick={t.action}>{t.label}<ArrowRight size={16} /></button></article>)}</div><div className="ai-banner"><div className="ai-banner-symbol"><Sparkles size={25} /></div><div><h3>先看看建议，再决定怎么整理。</h3><p>可用内置规则，也可配置自己的模型；整理建议确认后才会应用。</p></div><button className="button" onClick={onAI}>打开助手<ArrowRight size={15} /></button></div>
    {duplicates && <Modal title="重复文件检查" subtitle={`找到 ${matches.length} 组内容相同的文件`} onClose={() => setDuplicates(false)}>{matches.length ? <div className="duplicate-list">{matches.map((files, i) => <div key={files[0].sha256}><strong>第 {i + 1} 组 · {formatSize(files[0].size)}</strong>{files.map(f => <p key={f.id}>{f.name}<small>{f.owner}</small></p>)}</div>)}</div> : <p className="body-copy">当前文件列表中没有发现 SHA-256 相同的文件。</p>}<div className="form-note">只显示检查结果，不会自动删除文件。请在文件管理中检查后决定是否移入回收站。</div><footer className="modal-footer"><button className="button primary" onClick={() => setDuplicates(false)}>完成</button></footer></Modal>}
  </>
}

export function StoragePage({ workspace }: { workspace: Workspace }) {
  const [provider, setProvider] = useState(''), [available, setAvailable] = useState<number | null>(null)
  useEffect(() => { void api<{ availableBytes: number }>('/api/storage').then(info => setAvailable(info.availableBytes)).catch(() => {}) }, [])
  const used = workspace.storage?.usedBytes || 0, quota = workspace.storage?.quotaBytes || 1
  const providers = [
    { id: 'local', name: '服务器本地', icon: HardDrive, subtitle: '文件保存在自己的服务器', text: '文件正文与应用分开存放，重命名只修改显示名称。', detail: `当前文件使用 ${formatSize(used)}，配额 ${formatSize(quota)}。${available !== null ? `磁盘剩余 ${formatSize(available)}。` : ''}配额包含回收站文件。请定期备份，并将备份复制到另一台设备。` },
    { id: 'onedrive', name: 'OneDrive', icon: Cloud, subtitle: '官方授权接入规划', text: '后续通过官方授权连接个人或组织网盘。', detail: '当前未接入，不会收集微软账号密码。后续使用官方 OAuth，服务端保存和刷新授权。' },
    { id: 's3', name: 'S3 / WebDAV', icon: Database, subtitle: '存储适配规划', text: '后续按需求接入兼容对象存储与 WebDAV。', detail: '当前未接入；第一版使用本地存储。新增存储适配前会先测试上传、下载和备份兼容性。' },
  ]
  return <><div className="page-title"><div><p className="eyebrow">YOUR FILES, YOUR STORAGE</p><h1>文件的归处，由你决定。</h1><p>文件留在自己的服务器，容量和用量清楚可见。</p></div><span className="subtle-label"><LockKeyhole size={14} />本地存储已启用</span></div><div className="storage-summary"><span className="storage-big-icon"><HardDrive size={28} /></span><div><h2>服务器本地存储<span className="status active"><i />已启用</span></h2><p>{formatSize(used)} <span>/ {formatSize(quota)}</span></p><div className="progress"><span style={{ width: `${Math.min(100, used / quota * 100)}%` }} /></div></div><div className="storage-summary-note">{available !== null ? `磁盘剩余 ${formatSize(available)}` : '正在读取磁盘空间…'}<br /><span>配额包含回收站中的文件</span></div></div><div className="section-heading"><h2>存储连接</h2><span className="muted">按需选择，逐步接入</span></div><div className="storage-grid">{providers.map(p => <article className="storage-card" key={p.id}><div className="card-top"><span className={`provider-icon ${p.id}`}><p.icon size={28} /></span><span className={`status ${p.id === 'local' ? 'active' : 'neutral'}`}><i />{p.id === 'local' ? '已启用' : '待接入'}</span></div><h2>{p.name}</h2><h4>{p.subtitle}</h4><p>{p.text}</p><button className="button" onClick={() => setProvider(p.id)}>{p.id === 'local' ? '查看存储详情' : '查看接入计划'}<ArrowRight size={15} /></button></article>)}</div><div className="privacy-note"><ShieldCheck size={18} /><p>上传文件保存 SHA-256 校验值，下载需要管理员登录。磁盘加密与异地备份由服务器部署和运维负责。</p></div>{provider && <Modal title={providers.find(p => p.id === provider)!.name} onClose={() => setProvider('')}><p className="body-copy">{providers.find(p => p.id === provider)!.detail}</p><footer className="modal-footer"><button className="button primary" onClick={() => setProvider('')}>完成</button></footer></Modal>}</>
}
