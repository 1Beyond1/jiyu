import { useEffect, useRef, useState } from 'react'
import { Download, FolderArchive, RefreshCw, X } from 'lucide-react'
import { Modal } from '../components/ui'
import { api } from '../lib/api'
import { formatSize } from '../lib/workspace'
import type { ArchiveLayout, ArchivePlan, ArchiveStatus, CollectedFile } from '../types'

export function ArchiveModal({ files, onClose }: { files: CollectedFile[]; onClose: () => void }) {
  const [layout, setLayout] = useState<ArchiveLayout>('collection-owner'), [plan, setPlan] = useState<ArchivePlan | null>(null)
  const [busy, setBusy] = useState(false), [started, setStarted] = useState(false), [error, setError] = useState('')
  const current = useRef(plan)
  current.current = plan
  useEffect(() => () => { const plan = current.current; if (plan?.status === 'ready') void api(`/api/archives/${plan.id}`, 'DELETE').catch(() => {}) }, [])
  useEffect(() => {
    if (!started || !plan || !['ready', 'streaming'].includes(plan.status)) return
    let stopped = false, timer: ReturnType<typeof setTimeout>, attempts = 0
    const poll = async () => {
      try {
        const status = await api<{ status: ArchiveStatus; error?: string }>(`/api/archives/${plan.id}`)
        if (stopped) return
        setPlan(old => old?.id === plan.id ? { ...old, ...status } : old)
        if (status.status === 'ready' && ++attempts >= 8) { setError('浏览器尚未开始接收，请重新生成预览后重试。'); setStarted(false); return }
        if (['ready', 'streaming'].includes(status.status)) timer = setTimeout(() => void poll(), 2500)
      } catch (e) { if (!stopped) { setError((e as Error).message); setStarted(false) } }
    }
    timer = setTimeout(() => void poll(), 600)
    return () => { stopped = true; clearTimeout(timer) }
  }, [started, plan?.id, plan?.status])
  async function discard() { const old = plan; setPlan(null); setStarted(false); setError(''); if (old) await api(`/api/archives/${old.id}`, 'DELETE').catch(() => {}) }
  async function prepare() {
    setBusy(true); await discard()
    try { setPlan(await api<ArchivePlan>('/api/archives', 'POST', { ids: files.map(f => f.id), layout })) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const transferring = started && (!plan || ['ready', 'streaming'].includes(plan.status))
  return <Modal title="把文件，整理成一份交付。" subtitle="打包下载 · ZIP 归档" onClose={onClose} wide>
    <div className="archive-summary"><span className="assistant-mark"><FolderArchive size={22} /></span><div><strong>{files.length} 个文件</strong><p>原始内容共 {formatSize(files.reduce((sum, f) => sum + f.size, 0))}</p></div><span>每次最多 500 个 · 10 GiB</span></div>
    <label className="field">文件夹结构<select value={layout} disabled={busy || transferring} onChange={e => { void discard(); setLayout(e.target.value as ArchiveLayout) }}><option value="collection-owner">按任务 / 提交人</option><option value="collection">按收集任务</option><option value="owner">按提交人</option><option value="flat">全部放在同一层</option></select><small>{layout.includes('owner') ? '相同的提交人名称归入同一文件夹。' : '选择适合这次交付的目录层级。'}</small></label>
    {plan && <><div className="archive-preview-heading"><h3>ZIP 内的文件路径</h3><span>共 {plan.entries.length} 个</span></div><div className="archive-preview"><div className="archive-preview-labels"><span>当前文件名</span><span>归档路径</span></div>{plan.entries.slice(0, 50).map(entry => <div key={entry.id}><span>{entry.name}</span><code>{entry.path}</code></div>)}{plan.entries.length > 50 && <p>预览前 50 个，下载包含全部 {plan.entries.length} 个文件。</p>}</div></>}
    <div className="form-note">文件夹名和重名仅在 ZIP 内调整，原文件保持当前名称。预览生成后 10 分钟内可开始下载；不生成服务器磁盘副本。</div>
    {plan && plan.status !== 'ready' && <p className={plan.status === 'failed' || plan.status === 'cancelled' ? 'error-text' : 'success-text'} role="status">{plan.status === 'streaming' ? '正在向浏览器传输，请在下载列表查看保存进度。' : plan.status === 'completed' ? '完整 ZIP 已发送至浏览器，请在下载列表确认保存结果。' : plan.error}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {transferring && <p className="field-hint">关闭此窗口不会停止已开始的下载。</p>}
    <footer className="modal-footer"><button className="button" onClick={onClose}>关闭</button>{transferring ? <button className="button" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/api/archives/${plan!.id}`, 'DELETE'); setPlan(old => old ? { ...old, status: 'cancelled', error: '已停止服务器传输，可重新生成预览。' } : old); setStarted(false) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}><X size={15} />停止传输</button> : plan?.status === 'ready' && !error ? <a className="button primary" href={`/api/archives/${plan.id}/download`} target="_blank" rel="noreferrer" onClick={() => setStarted(true)}><Download size={16} />开始下载 ZIP</a> : <button className="button primary" disabled={busy} onClick={() => void prepare()}>{plan || error ? <RefreshCw size={15} /> : <FolderArchive size={15} />}{busy ? '正在生成预览…' : plan || error ? '重新生成预览' : '生成归档预览'}</button>}</footer>
  </Modal>
}
