import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUp, CornerDownLeft, Settings2, Sparkles, WandSparkles, X } from 'lucide-react'
import type { AIReply, AISettings, CollectedFile, Workspace } from '../types'
import { collectionState } from '../lib/collections'
import { api } from '../lib/api'

type Message = { id: string; role: 'user' | 'assistant'; text: string; action?: boolean; proposal?: AIReply; model?: string; error?: boolean }

export function Assistant({ workspace, initialFileIds, onClose, onRename, onConfigure, onProposal }: { workspace: Workspace; initialFileIds: string[]; onClose: () => void; onRename: (files: CollectedFile[]) => void; onConfigure: () => void; onProposal: (proposal: AIReply) => void }) {
  const [input, setInput] = useState(''), [messages, setMessages] = useState<Message[]>([]), [settings, setSettings] = useState<AISettings | null>(null)
  const [mode, setMode] = useState<'local' | 'model'>('local'), [selected, setSelected] = useState(initialFileIds.slice(0, 30)), [includeOwners, setIncludeOwners] = useState(false), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [loadError, setLoadError] = useState(''), [scopeFilter, setScopeFilter] = useState('')
  const list = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null)
  useEffect(() => {
    let alive = true
    void api<AISettings>('/api/ai/settings').then(value => { if (alive) { setSettings(value); if (value.enabled && value.keyReady) setMode('model') } }).catch(e => { if (alive) setLoadError(e.message) })
    return () => { alive = false; controller.current?.abort() }
  }, [])
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }, [messages, busy])
  useEffect(() => setConsent(false), [selected, includeOwners, mode])
  useEffect(() => { setSelected(initialFileIds.slice(0, 30)); setConsent(false) }, [initialFileIds])
  const files = workspace.files.filter(f => !scopeFilter || f.collectionId === scopeFilter)
  const chosen = workspace.files.filter(f => selected.includes(f.id))
  async function send(text: string) {
    if (!text.trim() || busy || (mode === 'model' && !consent)) return
    setMessages(old => [...old, { id: crypto.randomUUID(), role: 'user', text: text.trim() }]); setInput('')
    if (mode === 'model') {
      setBusy(true); controller.current = new AbortController()
      try {
        const reply = await api<AIReply>('/api/ai/chat', 'POST', { prompt: text.trim(), fileIds: selected, includeOwners, consent: true, settingsRevision: settings?.revision }, controller.current.signal)
        setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: reply.reply, proposal: reply.changes.length ? reply : undefined, model: settings?.model }])
      } catch (e) {
        const error = e as Error
        setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: error.name === 'AbortError' ? '请求已取消，文件没有修改。已经发送的请求仍可能由服务商计费。' : error.message, error: true }])
      } finally { setBusy(false); setConsent(false); void api<AISettings>('/api/ai/settings').then(setSettings).catch(() => {}) }
    } else {
      let response = '', action = false
      if (/命名|文件名|改名|整理/.test(text)) { response = '可以试试「{任务}_{提交人}_{序号}」，自动保留原扩展名。下面会打开现有命名规则预览，确认后才应用。'; action = true }
      else if (/进度|多少|情况|概览/.test(text)) {
        const active = workspace.collections.filter(c => collectionState(c) === 'active')
        response = `当前有 ${active.length} 项收集正在进行，累计收到 ${workspace.collections.reduce((sum, c) => sum + c.received, 0)} 份文件；${workspace.files.filter(f => f.status === 'pending').length} 份待整理。`
      } else if (/安全|隐私|存储/.test(text)) response = '文件保存在自己的服务器。内置规则不调用外部模型；模型模式需要你逐次确认发送范围，正文不会发送。请定期完成完整备份。'
      else response = '当前使用内置规则。可以查看收集进度或预览统一命名；配置模型后，可对选定文件提出更具体的整理建议。'
      setMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', text: response, action, model: '内置规则' }])
    }
    inputRef.current?.focus()
  }
  return <aside className="assistant-panel" aria-label="集屿 AI 助手"><header><span className="assistant-mark"><Sparkles size={19} /></span><div><h2>集屿 AI</h2><p><i />{mode === 'model' ? settings?.model : '内置规则 · 不调用外部服务'}</p></div><button className="icon-button" onClick={onConfigure} aria-label="配置 AI 模型"><Settings2 size={17} /></button><button className="icon-button" onClick={onClose} aria-label="关闭 AI 助手"><X size={18} /></button></header>
    <div className="assistant-mode"><button className={mode === 'local' ? 'active' : ''} disabled={busy} onClick={() => setMode('local')}>内置规则</button><button className={mode === 'model' ? 'active' : ''} disabled={busy || !settings?.enabled || !settings.keyReady} onClick={() => setMode('model')}>模型辅助</button><span>{settings ? `${settings.usedToday}/${settings.maxDailyCalls} 次今日调用` : loadError || '读取设置…'}</span></div>
    {mode === 'model' ? <details className="assistant-scope" open={initialFileIds.length ? true : undefined}><summary>本次文件范围<span>{chosen.length}/30</span></summary><label className="sr-only" htmlFor="ai-collection-filter">AI 文件任务筛选</label><select id="ai-collection-filter" value={scopeFilter} disabled={busy} onChange={e => setScopeFilter(e.target.value)}><option value="">全部任务</option>{workspace.collections.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select><div className="assistant-file-list">{files.length ? files.map(file => <label key={file.id}><input type="checkbox" disabled={busy || (!selected.includes(file.id) && chosen.length >= 30)} checked={selected.includes(file.id)} onChange={e => setSelected(e.target.checked ? [...selected, file.id] : selected.filter(id => id !== file.id))} /><span>{file.name}</span></label>) : <p>该范围暂无文件，可只询问工作台统计。</p>}</div><div className="assistant-scope-actions"><button type="button" disabled={busy} onClick={() => setSelected(files.slice(0, 30).map(f => f.id))}>选择本页前 30 个</button><button type="button" disabled={busy} onClick={() => setSelected([])}>清除选择</button></div><label className="check-label"><input type="checkbox" checked={includeOwners} disabled={busy} onChange={e => setIncludeOwners(e.target.checked)} />同时发送提交人姓名</label></details> : !settings?.enabled && <div className="assistant-config-note">模型服务尚未启用<button className="text-button" onClick={onConfigure}>去配置<ArrowRight size={13} /></button></div>}
    <div className="assistant-messages" ref={list}>{!messages.length ? <div className="assistant-welcome"><div className="assistant-orb"><Sparkles size={31} strokeWidth={1.3} /></div><p className="eyebrow">A LITTLE HELP, A LOT OF ORDER</p><h3>整理这件事，<br />我们一起轻松点。</h3><p>{mode === 'model' ? '选择本次范围，说明你的想法。\n先看建议，再决定是否应用。' : '查看进度、起个好名字，\n从你的一句话开始。'}</p><div className="assistant-suggestions">{['帮我统一文件名', '看看收集进度', '我的文件安全吗？'].map(q => <button disabled={busy} onClick={() => { if (mode === 'model') { setInput(q); inputRef.current?.focus() } else void send(q) }} key={q}>{q}<ArrowRight size={14} /></button>)}</div></div> : messages.map(m => <div className={`chat-message ${m.role} ${m.error ? 'chat-error' : ''}`} key={m.id}>{m.role === 'assistant' && <Sparkles size={14} />}<div>{m.model && <small className="chat-model">{m.model}</small>}<p>{m.text}</p>{m.action && <button className="chat-action" onClick={() => onRename(chosen)}><WandSparkles size={14} />预览命名规则<ArrowRight size={14} /></button>}{m.proposal && <button className="chat-action" onClick={() => onProposal(m.proposal!)}><WandSparkles size={14} />预览 {m.proposal.changes.length} 个改名建议<ArrowRight size={14} /></button>}</div></div>)}{busy && <div className="assistant-thinking" role="status"><Sparkles size={14} /><span>模型正在整理建议…</span><button className="text-button" onClick={() => controller.current?.abort()}>取消</button></div>}</div>
    <footer>{mode === 'model' && <label className="assistant-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>同意向 {settings ? new URL(settings.baseUrl).hostname : '模型服务'} 发送本次问题、工作台统计{chosen.length ? `和 ${chosen.length} 个文件的名称、大小、所属任务${includeOwners ? '、提交人' : ''}` : ''}；不含正文。</span></label>}<form onSubmit={e => { e.preventDefault(); void send(input) }}><input ref={inputRef} autoFocus value={input} disabled={busy} onChange={e => setInput(e.target.value)} placeholder="说说你想怎么整理…" aria-label="向 AI 提问" maxLength={1000} /><button disabled={!input.trim() || busy || (mode === 'model' && !consent)} aria-label="发送消息"><ArrowUp size={18} /></button></form><p><span>{mode === 'model' ? '当前问题独立发送 · 可能产生费用' : '内置规则 · 不发送文件信息'}</span><span><CornerDownLeft size={11} />发送</span></p></footer>
  </aside>
}
