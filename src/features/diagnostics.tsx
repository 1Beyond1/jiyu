import { useState } from 'react'
import type { Diagnostics } from '../types'
import { api } from '../lib/api'

export function DiagnosticsPanel() {
  const [result, setResult] = useState<Diagnostics | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <section className="settings-panel full"><div className="section-heading"><div><h2>部署检查</h2><p>首次启动或迁移 VPS 后，检查本机收集所需环境。</p></div><button className="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { setResult(await api<Diagnostics>('/api/settings/diagnostics', 'POST', {})) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>{busy ? '检查中…' : result ? '重新检查' : '检查部署环境'}</button></div>{error && <p className="error-text" role="alert">{error}</p>}{result && <><p className="field-hint">检查于 {new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false })} · 检查只反映当前本机环境。</p><div className="diagnostic-list">{result.items.map(item => <div key={item.id}><span className={`status ${item.state === 'ok' ? 'active' : 'paused'}`}>{item.state === 'ok' ? '通过' : '待处理'}</span><div><strong>{item.label}</strong><p>{item.detail}</p>{item.state === 'attention' && item.action && <small>{item.action}</small>}</div></div>)}</div></>}<div className="form-note">开始使用：创建收集 → 预览提交页 → 用一份小文件试交 → 确认下载 → 设置备份。云端账号与模型连接需要分别在对应设置中检查。</div></section>
}
