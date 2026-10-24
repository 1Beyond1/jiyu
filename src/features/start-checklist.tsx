import { useEffect, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import type { BackupStatus, Workspace } from '../types'
import { api } from '../lib/api'
import { shareAddress } from '../lib/share-address'
import { useAccount } from './auth'

interface ChecklistPreferences { collapsed: boolean; download?: { id: string; size: number; sha256?: string } }
function readPreferences(key: string): ChecklistPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    const download = saved?.download
    return { collapsed: saved?.collapsed === true, ...(download && typeof download.id === 'string' && Number.isSafeInteger(download.size) && download.size >= 0 && (download.sha256 === undefined || typeof download.sha256 === 'string') ? { download } : {}) }
  } catch { return { collapsed: false } }
}

export function StartChecklist({ workspace, onCreate, onSettings, onFiles }: { workspace: Workspace; onCreate: () => void; onSettings: (section: 'diagnostics' | 'backups') => void; onFiles: () => void }) {
  const { user } = useAccount()
  const preferenceKey = `jiyu:start-checklist:${user?.id || 'primary'}`
  const [preferences, setPreferences] = useState(() => readPreferences(preferenceKey))
  const [selectedFileId, setSelectedFileId] = useState(preferences.download?.id || workspace.files[0]?.id || '')
  function savePreferences(next: ChecklistPreferences) {
    setPreferences(next)
    try { localStorage.setItem(preferenceKey, JSON.stringify(next)) } catch { /* Keep the current page usable when browser storage is unavailable. */ }
  }
  const [backup, setBackup] = useState<BackupStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const address = shareAddress(location.origin)
  async function load() {
    setBusy(true); setError('')
    try { setBackup(await api<BackupStatus>('/api/backups')) } catch { setBackup(null); setError('备份状态暂时无法读取，请重试。') } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])
  const hasFiles = !!workspace.files.length
  const selectedFile = workspace.files.find(f => f.id === selectedFileId) || workspace.files[0]
  const collectionNames = new Map(workspace.collections.map(c => [c.id, c.title]))
  const checked = !!selectedFile && preferences.download?.id === selectedFile.id && preferences.download.size === selectedFile.size && preferences.download.sha256 === selectedFile.sha256
  const hasBackup = !!backup?.backups.length, scheduled = !!backup?.settings.enabled
  const items = [
    { title: '确认参与者能打开链接', state: address.label, done: false, text: address.detail, action: '检查部署环境', run: () => onSettings('diagnostics') },
    { title: '试交一份文件，再下载核对', state: hasFiles ? `已接收 ${workspace.files.length} 份 · ${checked ? '你已确认下载核对' : '待下载核对'}` : '尚未收到文件', done: checked, text: hasFiles ? '选择一份文件，下载并打开确认内容完整后，再勾选下方确认。' : '创建任务后，预览提交页并上传一份小文件，确认能收到和下载。', action: hasFiles ? '查看并下载文件' : '创建第一项收集', run: hasFiles ? onFiles : onCreate },
    { title: '安排完整备份', state: backup ? backup.lastRun?.status === 'failed' ? '最近备份失败，请检查' : backup.lastRun?.status === 'running' ? '正在生成备份' : hasBackup && scheduled ? '已有快照 · 计划已开启' : hasBackup ? '已有快照 · 未开启计划' : '尚未查到完整备份' : '状态未确认', done: hasBackup && scheduled && backup?.lastRun?.status === 'succeeded', text: '保存一次完整备份并开启计划，再将副本转存到另一台设备。外部手工备份请自行核对。', action: '设置与备份', run: () => onSettings('backups') },
  ]
  return <section className={`start-checklist ${preferences.collapsed ? 'collapsed' : ''}`} aria-label="首次使用清单"><div className="section-heading"><div><h2>开始真实收集前</h2><p>{preferences.collapsed ? '清单已收起，需要时可随时展开。' : '先把链接、试交和备份安排妥当。网盘与 AI 可稍后配置。'}</p></div><div className="checklist-header-actions">{!preferences.collapsed && <button className="text-button" disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : '更新状态'}</button>}<button className="text-button" aria-expanded={!preferences.collapsed} aria-controls="start-checklist-content" onClick={() => savePreferences({ ...preferences, collapsed: !preferences.collapsed })}>{preferences.collapsed ? '展开清单' : '收起清单'}</button></div></div><div id="start-checklist-content" hidden={preferences.collapsed}><div className="start-checklist-items">{items.map((item, i) => <div key={item.title}><span className={`checklist-number ${item.done ? 'done' : ''}`} aria-hidden="true">{item.done ? <Check size={16} /> : i + 1}</span><div><h3>{item.title}</h3><small>{item.state}</small><p>{item.text}</p>{i === 1 && selectedFile && <div className="download-confirmation"><label className="field">核对文件<select value={selectedFile.id} onChange={e => { setSelectedFileId(e.target.value); savePreferences({ ...preferences, download: undefined }) }}>{workspace.files.map(f => <option value={f.id} key={f.id}>{f.name} · {collectionNames.get(f.collectionId) || '收集任务'}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={checked} onChange={e => savePreferences({ ...preferences, download: e.target.checked ? { id: selectedFile.id, size: selectedFile.size, sha256: selectedFile.sha256 } : undefined })} />我已下载所选文件并确认内容完整</label></div>}<button className="text-button" onClick={item.run}>{item.action}<ArrowRight size={14} /></button></div></div>)}</div>{error && <p className="error-text" role="alert">{error}</p>}<p className="checklist-footnote">收起状态和下载确认仅记在当前浏览器与账号，不代表已验证公网访问或异地备份。</p></div></section>
}
