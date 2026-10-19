import { useState } from 'react'
import { ArrowRight, Check, Cloud, Database, FileDown, FolderInput, HardDrive, LockKeyhole, ScanLine, Settings2, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react'
import { Modal } from '../components/ui'
import type { Workspace } from '../types'
import { csvCell, downloadText, formatSize } from '../lib/workspace'

export function ToolsPage({ workspace, onRename, onFiles, onAI }: { workspace: Workspace; onRename: () => void; onFiles: () => void; onAI: () => void }) {
  const [info, setInfo] = useState(false)
  const tools = [
    { icon: WandSparkles, title: '批量重命名', description: '用统一规则，让零散的文件名整齐起来。', example: '任务名_提交人_序号.pdf', label: '开始重命名', action: onRename, color: 'green' },
    { icon: FolderInput, title: '按收集分类', description: '按任务、提交人筛选，快速找到所需文件。', example: '每一份文件，都有自己的位置', label: '整理文件', action: onFiles, color: 'blue' },
    { icon: FileDown, title: '导出文件清单', description: '把文件名称、提交人和大小导出为 CSV。', example: `${workspace.files.length} 条文件记录，随时带走`, label: '导出清单', action: () => downloadText('集屿-文件清单.csv', '\uFEFF文件名称,提交人,文件大小\n' + workspace.files.map(f => [f.name, f.owner, formatSize(f.size)].map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8'), color: 'amber' },
    { icon: ScanLine, title: '重复文件检查', description: '计划按文件内容校验，找出真正的重复文件。', example: '需要接入真实文件后启用', label: '了解功能', action: () => setInfo(true), color: 'violet' },
  ]
  return <><div className="page-title"><div><p className="eyebrow">ORGANIZE WITH EASE</p><h1>少一点重复，多一点有序。</h1><p>把繁琐的整理工作，变成一次轻松的操作。</p></div></div>
    <div className="tools-grid">{tools.map(t => <article className="tool-card" key={t.title}><span className={`tool-icon ${t.color}`}><t.icon size={25} strokeWidth={1.5} /></span><h2>{t.title}</h2><p>{t.description}</p><code>{t.example}</code><button onClick={t.action}>{t.label}<ArrowRight size={16} /></button></article>)}</div>
    <div className="ai-banner"><div className="ai-banner-symbol"><Sparkles size={25} strokeWidth={1.4} /></div><div><h3>说说你的想法，剩下的交给 AI。</h3><p>从一句「帮我统一文件名」开始，让整理变得更自然。</p></div><button className="button" onClick={onAI}>试试集屿 AI<ArrowUpRightIcon /></button></div>
    {info && <Modal title="按内容，找到重复文件" subtitle="规划中的功能" onClose={() => setInfo(false)}><p className="body-copy">接入真实存储后，将先计算文件内容的 SHA-256 校验值，再列出完全相同的文件。你可以逐项检查后决定保留哪一份。</p><div className="form-note">当前只有演示元数据，无法判断文件内容是否重复。</div><footer className="modal-footer"><button className="button primary" onClick={() => setInfo(false)}>知道了</button></footer></Modal>}
  </>
}

function ArrowUpRightIcon() { return <ArrowRight size={15} className="arrow-diagonal" /> }

const providers = [
  { id: 'local', name: '本地存储', subtitle: '你的服务器，你的文件', icon: HardDrive, connected: true, text: '直接存储到 VPS 挂载目录，适合快速开始。', detail: '正式版会把上传目录挂载到容器外，使用随机存储键保存文件，并将原始文件名单独记录到数据库。备份应覆盖数据库与文件内容。' },
  { id: 'onedrive', name: 'OneDrive', subtitle: '让熟悉的网盘接住文件', icon: Cloud, connected: false, text: '通过官方授权连接个人或组织网盘。', detail: '计划使用 Microsoft 官方 OAuth 授权，无需向集屿提供微软账号密码。授权回调、令牌加密、刷新与上传都由服务端完成；当前尚未接入。' },
  { id: 's3', name: 'S3 对象存储', subtitle: '为持续增长的文件留出空间', icon: Database, connected: false, text: '计划支持 AWS S3、Cloudflare R2 等兼容服务。', detail: '正式版通过服务端保存受限的访问凭证或生成短期上传地址。上传策略会校验容量与类型，实际兼容性会针对服务商逐一测试。当前尚未接入。' },
]

export function StoragePage() {
  const [provider, setProvider] = useState<(typeof providers)[number] | null>(null)
  return <><div className="page-title"><div><p className="eyebrow">YOUR FILES, YOUR STORAGE</p><h1>文件的归处，由你决定。</h1><p>从本地开始，也为你常用的云端存储留好位置。</p></div><span className="subtle-label"><LockKeyhole size={14} />存储接入规划</span></div>
    <div className="storage-summary"><span className="storage-big-icon"><HardDrive size={28} strokeWidth={1.4} /></span><div><h2>我的本地存储<span className="status active"><i />演示默认</span></h2><p>12.8 GB <span>/ 100 GB</span><small>示例容量</small></p><div className="progress"><span style={{ width: '12.8%' }} /></div></div><div className="storage-summary-note">从容收集，安心整理。<br /><span>真实容量将在连接服务后读取</span></div></div>
    <div className="section-heading"><h2>存储连接</h2><span className="muted">按需选择，逐步接入</span></div>
    <div className="storage-grid">{providers.map(p => <article className="storage-card" key={p.id}><div className="card-top"><span className={`provider-icon ${p.id}`}><p.icon size={28} strokeWidth={1.5} /></span><span className={`status ${p.connected ? 'active' : 'neutral'}`}><i />{p.connected ? '演示默认' : '待接入'}</span></div><h2>{p.name}</h2><h4>{p.subtitle}</h4><p>{p.text}</p><button className={`button ${p.connected ? '' : 'soft'}`} onClick={() => setProvider(p)}>{p.connected ? '查看存储详情' : '查看接入方案'}<ArrowRight size={15} /></button></article>)}</div>
    <div className="storage-roadmap"><Settings2 size={20} /><div><h3>更多选择，按需而来</h3><p>后续优先扩展 WebDAV、Google Drive。国内网盘将根据官方开放能力逐个评估。</p></div><span>接入计划</span></div>
    <div className="privacy-note"><ShieldCheck size={18} /><p>文件安全需要完整的存储、权限和备份方案。当前为界面预览，尚未执行真实的上传、加密或备份。</p></div>
    {provider && <Modal title={provider.name} subtitle={provider.subtitle} onClose={() => setProvider(null)}><p className="body-copy">{provider.detail}</p><div className="form-note">当前阶段不会收集账号、密码、令牌或存储密钥。</div><footer className="modal-footer"><button className="button primary" onClick={() => setProvider(null)}>知道了</button></footer></Modal>}
  </>
}

export function SettingsPage({ workspace, onSave, onReset }: { workspace: Workspace; onSave: (name: string) => void; onReset: () => void }) {
  const [name, setName] = useState(workspace.displayName)
  const [reset, setReset] = useState(false)
  return <><div className="page-title"><div><p className="eyebrow">MAKE IT YOURS</p><h1>你的工作台，刚刚好。</h1><p>管理个人偏好，了解当前预览的边界。</p></div></div>
    <div className="settings-layout"><section className="settings-panel"><h2>工作台信息</h2><p>这些信息只保存在当前浏览器。</p><form onSubmit={e => { e.preventDefault(); if (name.trim()) onSave(name.trim()) }}><label className="field">显示名称<input value={name} onChange={e => setName(e.target.value)} required maxLength={20} /></label><label className="field">工作台名称<input value="我的工作空间" readOnly /></label><button className="button primary"><Check size={15} />保存设置</button></form></section>
    <section className="settings-panel"><h2>AI 与数据隐私</h2><p>让辅助整理始终在你的掌控之中。</p><dl className="detail-list"><div><dt>当前模式</dt><dd>交互演示 · 未连接模型</dd></div><div><dt>文件内容</dt><dd>不会读取或发送</dd></div><div><dt>执行方式</dt><dd>先预览，确认后应用</dd></div></dl><div className="form-note">正式接入计划：自选模型服务，密钥仅存服务端；分析文件内容需要单独开启。</div></section>
    <section className="settings-panel full"><h2>演示数据</h2><p>可以导出工作台记录，或恢复初始示例。恢复操作会清除你在原型里创建的任务和文件记录。</p><div className="button-row"><button className="button" onClick={() => downloadText('集屿-工作台记录.json', JSON.stringify(workspace, null, 2), 'application/json')}><FileDown size={15} />导出记录</button><button className="button danger-text" onClick={() => setReset(true)}>恢复初始演示</button></div></section></div>
    {reset && <Modal title="恢复初始演示？" onClose={() => setReset(false)}><p className="body-copy">你创建的收集、文件记录和命名修改将被初始示例替换。建议先导出工作台记录。</p><footer className="modal-footer"><button className="button" onClick={() => setReset(false)}>取消</button><button className="button primary" onClick={() => { onReset(); setReset(false) }}>恢复演示</button></footer></Modal>}
  </>
}
