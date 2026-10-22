import { useState } from 'react'
import { ArrowRight, Check, FileDown, LogOut } from 'lucide-react'
import { Modal } from '../components/ui'
import type { Workspace } from '../types'
import { downloadText } from '../lib/workspace'
import { api, setCsrf } from '../lib/api'
import { AISettingsPanel } from './ai-settings'
import { MembersPanel } from './members'
import { BackupPanel } from './backup-settings'
import { useAccount } from './auth'
import { DiagnosticsPanel } from './diagnostics'

export function SettingsPage({ workspace, onSave, onLogout }: { workspace: Workspace; onSave: (name: string) => void; onLogout: () => void }) {
  const { user, isAdmin } = useAccount()
  const [name, setName] = useState(workspace.displayName), [passwordOpen, setPasswordOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  return <><div className="page-title"><div><p className="eyebrow">MAKE IT YOURS</p><h1>你的工作台，刚刚好。</h1><p>{isAdmin ? '管理成员、模型服务与数据备份。' : '查看你的账号信息，导出工作台记录。'}</p></div><button className="button" onClick={onLogout}><LogOut size={15} />退出登录</button></div><div className="settings-layout">
    {isAdmin && <section className="settings-panel"><h2>工作台信息</h2><p>名称会显示在你的收集页面。</p><form onSubmit={e => { e.preventDefault(); if (name.trim()) onSave(name.trim()) }}><label className="field">显示名称<input value={name} onChange={e => setName(e.target.value)} required maxLength={20} /></label><button className="button primary"><Check size={15} />保存设置</button></form></section>}
    <section className="settings-panel"><h2>我的账号</h2><p>{user?.displayName} · {user?.username}</p><dl className="detail-list"><div><dt>成员角色</dt><dd>{({ admin: '管理员', editor: '编辑者', viewer: '只读成员' })[user?.role || 'viewer']}</dd></div><div><dt>登录会话</dt><dd>登录有效期最长 12 小时</dd></div></dl><button className="button" onClick={() => { setPasswordOpen(true); setSaved(false); setError('') }}>修改我的密码</button></section>
    {isAdmin && <><DiagnosticsPanel /><MembersPanel /><AISettingsPanel /><BackupPanel /></>}
    <section className="settings-panel full"><h2>带走你的记录</h2><p>元数据清单包含任务与文件信息，完整正文需要使用备份或打包下载。</p><div className="button-row"><button className="button" onClick={() => downloadText('集屿-元数据清单.json', JSON.stringify(workspace, null, 2), 'application/json')}><FileDown size={15} />导出元数据清单</button><a className="button" href="https://github.com/1Beyond1/jiyu/blob/main/docs/DEPLOYMENT.md" target="_blank" rel="noreferrer">备份与恢复指南<ArrowRight size={15} /></a></div></section>
  </div>{passwordOpen && <Modal title="修改我的密码" subtitle="修改后，你在其他设备上的登录会话会失效。" onClose={() => { if (!busy) setPasswordOpen(false) }}><form onSubmit={async e => {
    e.preventDefault(); if (password !== confirmation) { setError('两次输入的新密码不一致'); return }
    setBusy(true); setError('')
    try { const result = await api<{ csrf: string }>('/api/auth/password', 'POST', { currentPassword, password }); setCsrf(result.csrf); setSaved(true); setCurrentPassword(''); setPassword(''); setConfirmation('') } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }}>{saved ? <p className="success-text">密码已修改，你的其他登录会话已撤销。</p> : <><label className="field">当前密码<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} maxLength={128} /></label><label className="field">新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></label><label className="field">确认新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label></>}{error && <p className="error-text" role="alert">{error}</p>}<footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={() => setPasswordOpen(false)}>关闭</button>{!saved && <button className="button primary" disabled={busy}>{busy ? '正在保存…' : '保存新密码'}</button>}</footer></form></Modal>}</>
}
