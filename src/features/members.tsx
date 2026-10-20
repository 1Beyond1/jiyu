import { useEffect, useState } from 'react'
import { Plus, Users } from 'lucide-react'
import { api } from '../lib/api'
import { Modal } from '../components/ui'
import type { SessionUser, UserRole } from '../types'
import { useAccount } from './auth'

const roles: Record<UserRole, string> = { admin: '管理员', editor: '编辑者', viewer: '只读成员' }
export function MembersPanel() {
  const { user: current } = useAccount()
  const [users, setUsers] = useState<SessionUser[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Partial<SessionUser> | null>(null), [password, setPassword] = useState('')
  useEffect(() => { void api<SessionUser[]>('/api/users').then(setUsers).catch(e => setError((e as Error).message)) }, [])
  return <section className="settings-panel full"><div className="section-heading"><div><h2><Users size={18} />工作台成员</h2><p>管理员管理设置和成员，编辑者收集整理，只读成员查看与下载。</p></div><button className="button" onClick={() => { setEditing({ username: '', displayName: '', role: 'editor', disabled: false }); setPassword(''); setError('') }}><Plus size={15} />添加成员</button></div><div className="member-list">{users.map(user => <div key={user.id}><span className="account-avatar">{user.displayName.slice(0, 1)}</span><div><strong>{user.displayName}{user.id === current?.id ? '（你）' : ''}</strong><small>{user.username} · {roles[user.role]}{user.disabled ? ' · 已停用' : ''}</small></div><button className="text-button" onClick={() => { setEditing(user); setPassword(''); setError('') }}>管理</button></div>)}</div>{error && !editing && <p className="error-text">{error}</p>}
    {editing && <Modal title={editing.id ? '管理成员' : '添加工作台成员'} onClose={() => { if (!busy) setEditing(null) }}><form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('')
      try { setUsers(await api<SessionUser[]>(editing.id ? `/api/users/${editing.id}` : '/api/users', editing.id ? 'PATCH' : 'POST', { ...editing, ...(password ? { password } : {}) })); setEditing(null); if (editing.id === current?.id) window.dispatchEvent(new Event('jiyu:session-expired')) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}><fieldset disabled={busy}><label className="field">登录名<input required disabled={!!editing.id} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}" maxLength={32} value={editing.username} onChange={e => setEditing({ ...editing, username: e.target.value })} autoComplete="off" /></label><label className="field">成员名称<input required maxLength={20} value={editing.displayName} onChange={e => setEditing({ ...editing, displayName: e.target.value })} /></label><label className="field">角色<select value={editing.role} onChange={e => setEditing({ ...editing, role: e.target.value as UserRole })}>{Object.entries(roles).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="field">{editing.id ? '重置密码（留空保留）' : '初始密码'}<input type="password" required={!editing.id} minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label>{editing.id && <label className="check-label"><input type="checkbox" checked={!!editing.disabled} onChange={e => setEditing({ ...editing, disabled: e.target.checked })} />停用账号</label>}<div className="form-note">所有成员共用此工作台，可查看其中的文件。保存账号修改后，该成员需要重新登录。</div>{error && <p className="error-text" role="alert">{error}</p>}<footer className="modal-footer"><button type="button" className="button" onClick={() => setEditing(null)}>取消</button><button className="button primary">{busy ? '正在保存…' : '保存成员'}</button></footer></fieldset></form></Modal>}
  </section>
}
