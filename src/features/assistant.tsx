import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUp, CornerDownLeft, Sparkles, WandSparkles, X } from 'lucide-react'
import type { Workspace } from '../types'

type Message = { id: number; role: 'user' | 'assistant'; text: string; action?: boolean }

export function Assistant({ workspace, onClose, onRename }: { workspace: Workspace; onClose: () => void; onRename: () => void }) {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const list = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }) }, [messages])
  function send(text: string) {
    if (!text.trim()) return
    let response = ''
    let action = false
    if (/命名|文件名|改名|整理/.test(text)) {
      response = '可以试试「{任务}_{提交人}_{序号}」，自动保留原扩展名。我会先展示命名预览，你确认后再应用。'
      action = true
    } else if (/进度|多少|情况|概览/.test(text)) {
      const active = workspace.collections.filter(c => c.status === 'active')
      response = `演示工作台有 ${active.length} 项正在收集的任务，累计收到 ${workspace.collections.reduce((sum, c) => sum + c.received, 0)} 份提交。当前展示的文件中有 ${workspace.files.filter(f => f.status === 'pending').length} 份待整理。${active.length ? `「${active[0].title}」已收到 ${active[0].received}/${active[0].target} 份。` : ''}`
    } else if (/安全|隐私|存储/.test(text)) {
      response = '这版界面只保存浏览器内的演示记录，不读取文件正文，也不会向模型发送内容。真实存储、账号授权与服务端加密将在后续实现。'
    } else {
      response = '当前是交互演示助手，还没有连接真实模型。你可以试试「查看收集进度」或「帮我统一文件名」，体验辅助整理流程。'
    }
    setMessages(old => [...old, { id: Date.now(), role: 'user', text }, { id: Date.now() + 1, role: 'assistant', text: response, action }])
    setInput('')
    inputRef.current?.focus()
  }
  return <aside className="assistant-panel" aria-label="集屿 AI 助手"><header><span className="assistant-mark"><Sparkles size={19} /></span><div><h2>集屿 AI</h2><p><i />随时在这里，帮你理清头绪</p></div><button className="icon-button" onClick={onClose} aria-label="关闭 AI 助手"><X size={18} /></button></header>
    <div className="assistant-messages" ref={list}>{!messages.length ? <div className="assistant-welcome"><div className="assistant-orb"><Sparkles size={31} strokeWidth={1.3} /></div><p className="eyebrow">A LITTLE HELP, A LOT OF ORDER</p><h3>整理这件事，<br />我们一起轻松点。</h3><p>查看进度、起个好名字，<br />从你的一句话开始。</p><div className="assistant-suggestions">{['帮我统一文件名', '看看收集进度', '我的文件安全吗？'].map(q => <button onClick={() => send(q)} key={q}>{q}<ArrowRight size={14} /></button>)}</div></div> : messages.map(m => <div className={`chat-message ${m.role}`} key={m.id}>{m.role === 'assistant' && <Sparkles size={14} />}<div><p>{m.text}</p>{m.action && <button className="chat-action" onClick={onRename}><WandSparkles size={14} />预览命名方案<ArrowRight size={14} /></button>}</div></div>)}</div>
    <footer><form onSubmit={e => { e.preventDefault(); send(input) }}><input ref={inputRef} autoFocus value={input} onChange={e => setInput(e.target.value)} placeholder="说说你想怎么整理…" aria-label="向 AI 提问" maxLength={500} /><button disabled={!input.trim()} aria-label="发送消息"><ArrowUp size={18} /></button></form><p><span>交互演示 · 未连接模型</span><span><CornerDownLeft size={11} />发送</span></p></footer>
  </aside>
}
