import { useEffect, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import type { BackupStatus, Workspace } from '../types'
import { api } from '../lib/api'
import { shareAddress } from '../lib/share-address'

export function StartChecklist({ workspace, onCreate, onSettings, onFiles }: { workspace: Workspace; onCreate: () => void; onSettings: () => void; onFiles: () => void }) {
  const [backup, setBackup] = useState<BackupStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const address = shareAddress(location.origin)
  async function load() {
    setBusy(true); setError('')
    try { setBackup(await api<BackupStatus>('/api/backups')) } catch { setBackup(null); setError('备份状态暂时无法读取，请重试。') } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])
  const hasFiles = !!workspace.files.length
  const hasBackup = !!backup?.backups.length, scheduled = !!backup?.settings.enabled
  const items = [
    { title: '确认参与者能打开链接', state: address.label, done: false, text: address.detail, action: '检查部署环境', run: onSettings },
    { title: '试交一份文件，再下载核对', state: hasFiles ? '已有接收记录' : '尚未收到文件', done: hasFiles, text: hasFiles ? '已收到文件。请下载一份，确认正文完整；接收记录不代表下载已验证。' : '创建任务后，预览提交页并上传一份小文件，确认能收到和下载。', action: hasFiles ? '查看并下载文件' : '创建第一项收集', run: hasFiles ? onFiles : onCreate },
    { title: '安排完整备份', state: backup ? backup.lastRun?.status === 'failed' ? '最近备份失败，请检查' : backup.lastRun?.status === 'running' ? '正在生成备份' : hasBackup && scheduled ? '已有快照 · 计划已开启' : hasBackup ? '已有快照 · 未开启计划' : '尚未查到完整备份' : '状态未确认', done: hasBackup && scheduled && backup?.lastRun?.status === 'succeeded', text: '保存一次完整备份并开启计划，再将副本转存到另一台设备。外部手工备份请自行核对。', action: '设置与备份', run: onSettings },
  ]
  return <section className="start-checklist" aria-label="首次使用清单"><div className="section-heading"><div><h2>开始真实收集前</h2><p>先把链接、试交和备份安排妥当。网盘与 AI 可稍后配置。</p></div><button className="text-button" disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : '更新状态'}</button></div><div className="start-checklist-items">{items.map((item, i) => <div key={item.title}><span className={`checklist-number ${item.done ? 'done' : ''}`} aria-hidden="true">{item.done ? <Check size={16} /> : i + 1}</span><div><h3>{item.title}</h3><small>{item.state}</small><p>{item.text}</p><button className="text-button" onClick={item.run}>{item.action}<ArrowRight size={14} /></button></div></div>)}</div>{error && <p className="error-text" role="alert">{error}</p>}<p className="checklist-footnote">这份清单显示当前记录，不代表已验证公网访问、异地备份或完成 VPS 上线。</p></section>
}
