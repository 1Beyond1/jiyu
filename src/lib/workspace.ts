import { useEffect, useState } from 'react'
import type { Workspace } from '../types'

const KEY = 'guiji.workspace.v1'

export function createWorkspace(): Workspace {
  return {
    version: 1,
    displayName: '林予',
    collections: [
      { id: 'brand-autumn', title: '秋日品牌视觉素材', description: '收集这一季的灵感与好设计', category: 'design', received: 18, target: 24, deadline: '2026-10-25', storage: 'local', status: 'active', formats: 'PNG, JPG, SVG, FIG, PDF, ZIP' },
      { id: 'team-october', title: '十月团队周报', description: '每一份进展，都值得被看见', category: 'document', received: 8, target: 12, deadline: '2026-10-23', storage: 'local', status: 'active', formats: 'PDF, DOCX, XLSX' },
      { id: 'city-walk', title: '城市漫游 · 摄影征集', description: '把你眼中的城市，分享给我们', category: 'photo', received: 32, target: 50, deadline: '2026-10-31', storage: 'local', status: 'active', formats: 'JPG, PNG, HEIC, ZIP' },
      { id: 'september-archive', title: '九月项目交付归档', description: '一个阶段的结束，也是新的开始', category: 'document', received: 16, target: 16, deadline: '2026-09-30', storage: 'local', status: 'completed', formats: 'PDF, ZIP' },
    ],
    files: [
      { id: 'f1', name: '秋日品牌视觉提案.pdf', size: 2480000, collectionId: 'brand-autumn', owner: '陈念', createdAt: '2026-10-19T10:42:00+08:00', storage: 'local', status: 'ready' },
      { id: 'f2', name: '品牌辅助图形_v2.fig', size: 18600000, collectionId: 'brand-autumn', owner: '许知远', createdAt: '2026-10-19T10:28:00+08:00', storage: 'local', status: 'ready' },
      { id: 'f3', name: '产品组_第三周周报.docx', size: 856000, collectionId: 'team-october', owner: '李可', createdAt: '2026-10-19T09:56:00+08:00', storage: 'local', status: 'pending' },
      { id: 'f4', name: '午后街角.jpg', size: 6200000, collectionId: 'city-walk', owner: '周也', createdAt: '2026-10-19T09:35:00+08:00', storage: 'local', status: 'ready' },
      { id: 'f5', name: '十月项目进度表.xlsx', size: 324000, collectionId: 'team-october', owner: '林溪', createdAt: '2026-10-18T17:20:00+08:00', storage: 'local', status: 'ready' },
      { id: 'f6', name: '品牌字体与配色.zip', size: 42800000, collectionId: 'brand-autumn', owner: '陈念', createdAt: '2026-10-18T15:08:00+08:00', storage: 'local', status: 'pending' },
      { id: 'f7', name: '河岸散步.png', size: 8900000, collectionId: 'city-walk', owner: '周也', createdAt: '2026-10-18T14:32:00+08:00', storage: 'local', status: 'ready' },
      { id: 'f8', name: '九月项目结项.pdf', size: 1680000, collectionId: 'september-archive', owner: '林予', createdAt: '2026-09-30T16:00:00+08:00', storage: 'local', status: 'ready' },
    ],
    activities: [
      { id: 'a1', text: '陈念提交了「秋日品牌视觉提案.pdf」', time: '10:42' },
      { id: 'a2', text: '许知远提交了 1 份品牌视觉文件', time: '10:28' },
      { id: 'a3', text: '「十月团队周报」收到一份新提交', time: '09:56' },
    ],
  }
}

function readWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return createWorkspace()
    const data = JSON.parse(raw) as Workspace
    if (data.version !== 1 || !Array.isArray(data.collections) || !Array.isArray(data.files) || !Array.isArray(data.activities) || typeof data.displayName !== 'string') return createWorkspace()
    return data
  } catch { return createWorkspace() }
}

export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>(readWorkspace)
  const [saveError, setSaveError] = useState(false)
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === KEY) setWorkspace(readWorkspace()) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(workspace)); setSaveError(false) }
    catch { setSaveError(true) }
  }, [workspace])
  return { workspace, setWorkspace, saveError }
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }).format(new Date(value))
}

export function downloadText(name: string, body: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}
