import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Cloud, HardDrive, Plus, RefreshCw } from 'lucide-react'
import { Modal } from '../components/ui'
import { api } from '../lib/api'
import { formatDate, formatSize } from '../lib/workspace'
import type { StorageId, StorageProfile, StorageSpace, TransferInfo, Workspace } from '../types'
import { storageNames } from '../types'
import { useAccount } from './auth'
import { ConnectionWizard, storageChoices } from './storage-connection'

export interface StorageState { profiles: StorageProfile[]; callbackUrls: Record<string, string>; transfers: TransferInfo[] }
const transferLabels: Record<string, string> = { queued: '等待同步', transferring: '正在同步并校验', ready: '云端已保存', failed: '同步失败 · 本机原件保留' }

export function StoragePage({ workspace, onCreate }: { workspace: Workspace; onCreate: (storage: StorageId) => void }) {
  const { isAdmin } = useAccount()
  const [state, setState] = useState<StorageState | null>(null), [space, setSpace] = useState<StorageSpace | null>(null)
  const [choosing, setChoosing] = useState(false), [editing, setEditing] = useState<StorageProfile | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [diskError, setDiskError] = useState(''), [notice, setNotice] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const load = useCallback(async (manual = false) => {
    if (manual) setLoading(true)
    await Promise.all([
      api<StorageState>('/api/storage/connections').then(s => { setState(s); setError('') }).catch(e => setError((e as Error).message)),
      api<StorageSpace>('/api/storage').then(s => { setSpace(s); setDiskError(s.diskError || '') }).catch(e => { setSpace(null); setDiskError(`容量读取失败：${(e as Error).message}`) }),
    ])
    if (manual) setLoading(false)
  }, [])
  useEffect(() => { void load(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 10000); return () => clearInterval(timer) }, [load])
  const configured = state?.profiles.filter(p => p.hasCredentials || p.revision) || []
  const used = space?.usedBytes ?? workspace.storage?.usedBytes ?? 0, quota = space?.quotaBytes ?? workspace.storage?.quotaBytes ?? 0
  const open = (profile: StorageProfile) => { setChoosing(false); setNotice(''); setEditing(profile) }
  return <>
    <div className="page-title"><div><p className="eyebrow">STORAGE</p><h1>文件存在哪里，一目了然。</h1><p>本机直接可用，需要时再连接云端。</p></div><button className="button" disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} />{loading ? '正在刷新…' : '刷新容量与连接'}</button></div>
    <section className="storage-local" aria-labelledby="local-storage-title">
      <div className="storage-local-heading"><span className="storage-big-icon"><HardDrive size={24} /></span><div><h2 id="local-storage-title">服务器本机</h2><p>无需配置，收到的文件会先保存在这里。</p></div><span className="status active"><i />已启用</span></div>
      <div className="capacity-grid">
        <div><span>文件已用</span><strong>{formatSize(used)}</strong><small>包含回收站，不含系统和其他应用</small></div>
        <div><span>收集配额</span><strong>{formatSize(quota)}</strong><small>集屿允许接收的上限，并非磁盘总容量</small></div>
        <div><span>数据磁盘剩余</span><strong>{space?.availableBytes != null ? formatSize(space.availableBytes) : '暂不可用'}</strong><small>{space?.totalBytes != null ? `所在磁盘总容量 ${formatSize(space.totalBytes)}` : '由服务器实时读取，不使用预设值'}</small></div>
      </div>
      <div className="progress" aria-label="文件占收集配额" role="progressbar" aria-valuenow={Math.round(quota ? Math.min(100, used / quota * 100) : 0)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${quota ? Math.min(100, used / quota * 100) : 0}%` }} /></div>
      <div className="capacity-footer"><p>{space?.receiveRemainingBytes != null ? <>当前最多还可收集 <b>{formatSize(space.receiveRemainingBytes)}</b>，取配额余额与磁盘剩余的较小值。</> : '容量正在读取或暂不可用，请刷新后确认。'}{space && space.reservedBytes > 0 && <> 上传批次已预留 {formatSize(space.reservedBytes)}。</>}</p>{space && <small>读取于 {new Date(space.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 每 10 秒刷新</small>}</div>
      {diskError && <p className="error-text" role="alert">{diskError}</p>}
      <details className="storage-help"><summary>为什么配额和磁盘容量不同？</summary><p>配额只限制集屿收集的文件，默认 10 GB；服务器上的系统、其他应用、备份和上传分片也会占用磁盘。部署管理员可用 <code>JIYU_QUOTA_MB</code> 调整收集配额，修改后重启服务。回收站仍计入文件已用。</p></details>
    </section>
    <section className="storage-connections" aria-labelledby="cloud-storage-title">
      <div className="section-heading"><div><h2 id="cloud-storage-title">云端连接</h2><p>连接成功后，在收集任务中选择使用。</p></div>{isAdmin && <button className="button primary" onClick={() => setChoosing(true)}><Plus size={15} />添加存储</button>}</div>
      {!state && !error && <p className="muted" role="status">正在读取连接…</p>}
      {error && <div className="error-banner" role="alert">连接列表读取失败：{error}<button className="text-button" onClick={() => void load(true)}>重试</button></div>}
      {state && !configured.length && <div className="storage-empty"><Cloud size={29} strokeWidth={1.4} /><div><h3>现在用本机就能开始收集</h3><p>已有 WebDAV 账号或 S3 存储桶，可直接填写连接。百度、OneDrive 和 Google Drive 需要先配置自己的开放平台应用。</p></div>{isAdmin && <button className="text-button" onClick={() => setChoosing(true)}>选择存储方式<ArrowRight size={15} /></button>}</div>}
      {!!configured.length && <div className="connection-list">{configured.map(p => <article key={p.id}><span className="connection-icon"><Cloud size={22} /></span><div><h3>{storageNames[p.id]}<span className={`status ${p.enabled ? 'active' : 'neutral'}`}><i />{p.enabled ? '可用于收集' : p.authorized ? '已授权，待检查' : '尚未连接'}</span></h3><p>{p.root} {p.verifiedAt && `· 最近检查 ${formatDate(p.verifiedAt)}`}</p></div>{isAdmin && <div className="button-row">{p.enabled && <button className="button" onClick={() => onCreate(p.id)}>用它创建收集</button>}<button className="text-button" onClick={() => open(p)}>{p.enabled ? '管理连接' : '继续连接'}<ArrowRight size={14} /></button></div>}</article>)}</div>}
      <p className="field-hint">云端同步后仍保留本机完整副本，当前不会释放 VPS 空间。同步失败时，已收到的文件仍可从本机下载。</p>
    </section>
    {state && !!state.transfers.length && <section className="settings-panel transfer-panel"><div className="section-heading"><div><h2>云端同步记录</h2><p>提交回执表示本机已接收，云端保存结果以这里为准。显示最近 100 项。</p></div></div><div className="transfer-list">{state.transfers.map(t => <div key={t.file_id}><div><strong>{workspace.files.find(f => f.id === t.file_id)?.name || workspace.trash?.find(f => f.id === t.file_id)?.name || '文件记录'}</strong><small>{storageNames[t.provider as StorageProfile['id']] || '已停用的旧连接'} · {transferLabels[t.state] || t.state} · {formatDate(t.updated_at)}</small>{t.error && <p className="error-text">{t.error}</p>}</div>{isAdmin && t.state === 'failed' && state.profiles.some(p => p.id === t.provider && p.enabled) && <button className="button" disabled={retrying !== null} onClick={async () => { setRetrying(t.file_id); setNotice(''); try { await api('/api/storage/transfers/retry', 'POST', { ids: [t.file_id] }); setNotice('已重新安排同步'); await load() } catch (e) { setNotice((e as Error).message) } finally { setRetrying(null) } }}>{retrying === t.file_id ? '正在重试…' : '重试'}</button>}</div>)}</div></section>}
    {notice && <p role="status" className="field-hint">{notice}</p>}
    {choosing && <Modal title="添加存储" subtitle="先看看需要准备什么，再选择适合你的方式。" onClose={() => setChoosing(false)}><div className="storage-picker">{storageChoices.map(choice => <button key={choice.id} onClick={() => { const p = state?.profiles.find(p => p.id === choice.id); if (p) open(p) }} disabled={!state}><span><strong>{choice.name}</strong><small>{choice.requirement}</small></span><em>{choice.level}</em><ArrowRight size={16} /></button>)}</div><p className="field-hint">本机已经可用，无需添加。连接仅由管理员配置，不会要求你把网盘账号密码填进集屿。</p></Modal>}
    {editing && <ConnectionWizard key={editing.id} profile={editing} callbackUrl={state?.callbackUrls[editing.id]} onClose={() => setEditing(null)} onChanged={() => void load()} onCreate={id => { setEditing(null); onCreate(id) }} />}
  </>
}
