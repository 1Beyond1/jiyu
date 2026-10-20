import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, LockKeyhole, RefreshCw } from 'lucide-react'
import { Brand } from '../components/ui'
import { api, setCsrf } from '../lib/api'

interface Session { authenticated: boolean; setupRequired: boolean; csrf?: string }

export function AdminGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  async function refresh() {
    try { const data = await api<Session>('/api/auth/status'); setCsrf(data.csrf || ''); setSession(data); setError('') } catch (e) { setError((e as Error).message || '无法连接集屿服务') }
  }
  useEffect(() => { void refresh(); const expired = () => { setSession({ authenticated: false, setupRequired: false }); setCsrf('') }; window.addEventListener('jiyu:session-expired', expired); return () => window.removeEventListener('jiyu:session-expired', expired) }, [])
  if (session?.authenticated) return children
  if (error) return <main className="auth-page"><Brand /><section className="auth-card"><h1>暂时连接不上工作台</h1><p>{error}</p><button className="button primary" onClick={() => void refresh()}><RefreshCw size={16} />重新连接</button></section></main>
  if (!session) return <main className="auth-page"><Brand /><p className="muted" role="status">正在连接集屿…</p></main>
  return <AuthForm setup={session.setupRequired} onAuthenticated={value => { setCsrf(value.csrf || ''); setSession(value) }} />
}

function AuthForm({ setup, onAuthenticated }: { setup: boolean; onAuthenticated: (value: Session) => void }) {
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [setupToken, setSetupToken] = useState(''), [displayName, setDisplayName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return <main className="auth-page"><Brand /><section className="auth-card"><span className="auth-symbol"><LockKeyhole size={24} strokeWidth={1.4} /></span><p className="eyebrow">YOUR PRIVATE WORKSPACE</p><h1>{setup ? '让文件，从这里归屿。' : '欢迎回到集屿。'}</h1><p>{setup ? '设置管理员，开启你的私人文件工作台。' : '输入管理员密码，继续收集与整理。'}</p><form onSubmit={async e => {
    e.preventDefault(); if (setup && password !== confirmation) { setError('两次输入的密码不一致'); return }
    setBusy(true); setError('')
    try { onAuthenticated(await api<Session>(setup ? '/api/auth/setup' : '/api/auth/login', 'POST', { password, ...(setup ? { setupToken, displayName } : {}) })) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }}><fieldset disabled={busy}>
    {setup && <><label className="field">初始化口令<input required value={setupToken} onChange={e => setSetupToken(e.target.value)} autoComplete="off" maxLength={100} /><small>由服务器数据目录中的 setup-token 文件提供，仅首次使用需要。</small></label><label className="field">显示名称<input required maxLength={20} value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="例如：我的工作室" autoComplete="nickname" /></label></>}
    <label className="field">管理员密码<input type="password" required minLength={setup ? 12 : 1} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} autoFocus />{setup && <small>至少 12 个字符，建议使用密码管理器生成。</small>}</label>
    {setup && <label className="field">确认密码<input type="password" required minLength={12} maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="new-password" /></label>}
    {error && <p className="error-text" role="alert">{error}</p>}<button className="button primary submit-button">{busy ? '请稍候…' : setup ? '创建管理员' : '进入工作台'}<ArrowRight size={16} /></button>
  </fieldset></form></section><p className="auth-footnote">文件保存在你自己的服务器 · 集屿 v0.3</p></main>
}
