import { useEffect, useState } from 'react'
import { Check, FlaskConical, RefreshCw, Sparkles } from 'lucide-react'
import type { AIRun, AISettings } from '../types'
import { api } from '../lib/api'
import { formatDate } from '../lib/workspace'

export function AISettingsPanel() {
  const [settings, setSettings] = useState<AISettings | null>(null), [history, setHistory] = useState<AIRun[]>([])
  const [apiKey, setApiKey] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [remove, setRemove] = useState(false)
  async function load() {
    try { const [settings, runs] = await Promise.all([api<AISettings>('/api/ai/settings'), api<AIRun[]>('/api/ai/history')]); setSettings(settings); setHistory(runs); setError(''); setDirty(false) } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { void load() }, [])
  function update(changes: Partial<AISettings>) { setSettings(old => old ? { ...old, ...changes } : old); setDirty(true); setNotice('') }
  return <section className="settings-panel full ai-settings"><div className="ai-settings-heading"><span className="assistant-mark"><Sparkles size={19} /></span><div><h2>模型服务</h2><p>接入你自己的模型，辅助理解文件信息与命名。</p></div>{settings && <span className={`status ${settings.enabled ? 'active' : 'neutral'}`}><i />{settings.enabled ? '已启用' : '未启用'}</span>}</div>{!settings ? <><p>{error || '正在读取模型设置…'}</p>{error && <button className="button" onClick={() => void load()}><RefreshCw size={15} />重新读取</button>}</> : <>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); setNotice('')
      try { const saved = await api<AISettings>('/api/ai/settings', 'PATCH', { ...settings, apiKey }); setSettings(saved); setApiKey(''); setDirty(false); setNotice('模型设置已保存；尚未发起模型调用。') } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}><fieldset disabled={busy}>
      <div className="form-row"><label className="field">接口协议<select value={settings.protocol} onChange={e => update({ protocol: e.target.value as AISettings['protocol'] })}><option value="responses">OpenAI Responses</option><option value="chat">Chat Completions 兼容接口</option></select></label><label className="field">模型 ID<input required maxLength={120} value={settings.model} onChange={e => update({ model: e.target.value })} placeholder="填写服务商提供的模型 ID" autoComplete="off" /></label></div>
      <label className="field">服务地址<input type="url" required maxLength={300} value={settings.baseUrl} onChange={e => update({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /><small>填写接口根地址，不包含 /responses 或 /chat/completions。仅支持公网 HTTPS。</small></label>
      <div className="form-row"><label className="field">API Key<input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setDirty(true) }} autoComplete="new-password" maxLength={4096} placeholder={settings.hasKey ? '已保存，留空保留' : '仅加密保存在服务器'} /><small>{settings.hasKey ? settings.keyReady ? '凭证已保存，不会回显。更换服务商需重新填写。' : '主密钥缺失，请重新填写凭证或恢复完整备份。' : '不会写入前端配置、浏览器缓存或日志。'}</small></label><label className="field">每日调用上限<input type="number" min={1} max={1000} required value={settings.maxDailyCalls} onChange={e => update({ maxDailyCalls: Number(e.target.value) })} /><small>今日 {settings.usedToday} 次；失败和取消也计入。按 UTC+8 重置。</small></label></div>
      <label className="check-label"><input type="checkbox" checked={settings.enabled} onChange={e => update({ enabled: e.target.checked })} />启用模型辅助</label>
      <div className="form-note">每次发送前确认当前问题和选定文件信息。正文默认不发送；助手中可另行授权发送已识别摘录。费用与数据保留方式取决于服务商；这里的次数上限不等于金额预算。</div>
      {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="success-text" role="status">{notice}</p>}
      <div className="button-row"><button className="button primary" type="submit"><Check size={15} />{busy ? '正在处理…' : '保存模型设置'}</button><button className="button" type="button" disabled={!settings.enabled || !settings.hasKey || !settings.keyReady || dirty} onClick={async () => {
        setBusy(true); setError(''); setNotice('')
        try { await api('/api/ai/test', 'POST', { consent: true, settingsRevision: settings.revision }); await load(); setNotice('模型连接测试通过。测试已计入今日次数。') } catch (e) { await load(); setError((e as Error).message) } finally { setBusy(false) }
      }}><FlaskConical size={15} />测试连接（调用一次模型）</button>{settings.hasKey && <button className="text-button" type="button" onClick={() => setRemove(!remove)}>移除已保存凭证</button>}</div>
      {dirty && <p className="field-hint">请先保存修改，再测试连接。</p>}
    </fieldset></form>
    {remove && <div className="rotate-confirm"><p>移除凭证会同时停用 AI；文件与历史命名操作保留。</p><button className="button" disabled={busy} onClick={() => setRemove(false)}>取消</button><button className="button" disabled={busy} onClick={async () => { setBusy(true); try { setSettings(await api<AISettings>('/api/ai/settings/key', 'DELETE')); setRemove(false); setApiKey(''); setDirty(false); setNotice('已移除凭证并停用 AI。') } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>确认移除凭证</button></div>}
    {!!history.length && <details className="ai-history"><summary>最近模型调用 · 只记录状态与用量</summary>{history.map(run => <div key={run.id}><span>{run.model}<small>{formatDate(run.createdAt)} · {run.fileCount} 个文件 · {run.tokens || '—'} tokens</small></span><em>{({ pending: '处理中', succeeded: '已生成建议', applied: '已确认应用', failed: '失败', cancelled: '已取消', interrupted: '重启中断' } as Record<string, string>)[run.status] || run.status}</em></div>)}</details>}
  </>}</section>
}
