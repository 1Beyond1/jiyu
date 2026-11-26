import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowRight, LockKeyhole, RefreshCw, Sparkles } from 'lucide-react'
import { Brand } from '../components/ui'
import { api, setCsrf } from '../lib/api'
import type { SessionUser } from '../types'
import { APP_VERSION } from '../types'

interface Session {
  authenticated: boolean
  setupRequired: boolean
  demoEnabled?: boolean
  csrf?: string
  user?: SessionUser
}
const UserContext = createContext<SessionUser | undefined>(undefined)
export function useAccount() {
  const user = useContext(UserContext)
  return {
    user,
    canEdit: !!user && user.role !== 'viewer',
    isAdmin: user?.role === 'admin',
    isDemo: !!user?.demo,
  }
}

export function AdminGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const data = await api<Session>('/api/auth/status')
      setCsrf(data.csrf || '')
      setSession(data)
      setError('')
    } catch (e) {
      setError((e as Error).message || '无法连接集屿服务')
    }
  }, [])
  useEffect(() => {
    void refresh()
    const expired = () => {
      try {
        const keys: string[] = []
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i)
          if (k?.startsWith('jiyu:passcode:')) keys.push(k)
        }
        for (const k of keys) sessionStorage.removeItem(k)
      } catch {
        /* ignore storage access errors */
      }
      setSession((prev) => ({
        authenticated: false,
        setupRequired: false,
        demoEnabled: prev?.demoEnabled,
      }))
      setCsrf('')
    }
    window.addEventListener('jiyu:session-expired', expired)
    return () => window.removeEventListener('jiyu:session-expired', expired)
  }, [refresh])
  if (session?.authenticated)
    return <UserContext.Provider value={session.user}>{children}</UserContext.Provider>
  if (error)
    return (
      <main className="auth-page">
        <Brand />
        <section className="auth-card">
          <h1>暂时连接不上工作台</h1>
          <p>{error}</p>
          <button type="button" className="button primary" onClick={() => void refresh()}>
            <RefreshCw size={16} />
            重新连接
          </button>
        </section>
      </main>
    )
  if (!session)
    return (
      <main className="auth-page">
        <Brand />
        <p className="muted" role="status">
          正在连接集屿…
        </p>
      </main>
    )
  return (
    <AuthForm
      setup={session.setupRequired}
      demoEnabled={Boolean(session.demoEnabled)}
      onAuthenticated={(value) => {
        setCsrf(value.csrf || '')
        setSession((prev) => ({ ...value, demoEnabled: prev?.demoEnabled ?? value.demoEnabled }))
      }}
    />
  )
}

function AuthForm({
  setup,
  demoEnabled,
  onAuthenticated,
}: {
  setup: boolean
  demoEnabled: boolean
  onAuthenticated: (value: Session) => void
}) {
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [setupToken, setSetupToken] = useState(''),
    [displayName, setDisplayName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [demoBusy, setDemoBusy] = useState(false)
  const [username, setUsername] = useState('admin')
  async function enterDemo() {
    if (busy || demoBusy) return
    setDemoBusy(true)
    setError('')
    try {
      onAuthenticated(await api<Session>('/api/auth/demo', 'POST', {}))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDemoBusy(false)
    }
  }
  return (
    <main className="auth-page">
      <Brand />
      <section className="auth-card">
        <span className="auth-symbol">
          <LockKeyhole size={24} strokeWidth={1.4} />
        </span>
        <p className="eyebrow">YOUR PRIVATE WORKSPACE</p>
        <h1>{setup ? '让文件，从这里归屿。' : '欢迎回到集屿。'}</h1>
        <p>
          {setup
            ? '设置管理员，开启你的私人文件工作台。'
            : demoEnabled
              ? '无需账号密码即可一键体验核心工作台，或使用管理员账号登录完整后台。'
              : '使用你的成员账号登录，继续收集与整理。'}
        </p>
        {!setup && demoEnabled && (
          <div className="demo-entry">
            <button
              type="button"
              className="button primary submit-button"
              disabled={busy || demoBusy}
              onClick={() => void enterDemo()}
            >
              <Sparkles size={16} />
              {demoBusy ? '正在进入体验工作台…' : '一键访客体验（成员身份）'}
              <ArrowRight size={16} />
            </button>
            <p className="demo-entry-note">
              以编辑者身份免密体验创建收集、分享提交、材料核对、台账导出与 AI
              助手；系统设置、成员与密钥管理仅管理员可用。
            </p>
            <div className="auth-divider" aria-hidden="true">
              <span>或使用账号密码登录</span>
            </div>
          </div>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (setup && password !== confirmation) {
              setError('两次输入的密码不一致')
              return
            }
            setBusy(true)
            setError('')
            try {
              onAuthenticated(
                await api<Session>(setup ? '/api/auth/setup' : '/api/auth/login', 'POST', {
                  password,
                  ...(setup ? { setupToken, displayName } : { username }),
                }),
              )
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <fieldset disabled={busy || demoBusy}>
            {setup && (
              <>
                <label className="field">
                  初始化口令
                  <input
                    required
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    autoComplete="off"
                    maxLength={100}
                  />
                  <small>由服务器数据目录中的 setup-token 文件提供，仅首次使用需要。</small>
                </label>
                <label className="field">
                  显示名称
                  <input
                    required
                    maxLength={20}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="例如：我的工作室"
                    autoComplete="nickname"
                  />
                </label>
              </>
            )}
            {!setup && (
              <label className="field">
                登录名
                <input
                  required
                  maxLength={32}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </label>
            )}
            <label className="field">
              {setup ? '管理员密码' : '密码'}
              <input
                type="password"
                required
                minLength={setup ? 12 : 1}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setup ? 'new-password' : 'current-password'}
              />
              {setup && <small>至少 12 个字符，初始管理员登录名为 admin。</small>}
            </label>
            {setup && (
              <label className="field">
                确认密码
                <input
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className={`button ${!setup && demoEnabled ? '' : 'primary'} submit-button`}
            >
              {busy ? '请稍候…' : setup ? '创建管理员' : '进入工作台'}
              <ArrowRight size={16} />
            </button>
          </fieldset>
        </form>
      </section>
      <p className="auth-footnote">文件保存在你自己的服务器 · 集屿 v{APP_VERSION}</p>
    </main>
  )
}
