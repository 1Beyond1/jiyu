import { useCallback, useEffect, useRef, useState } from 'react'
import type { Workspace } from '../types'
import { api } from './api'

const empty: Workspace = { version: 1, displayName: '', collections: [], files: [], activities: [], trash: [] }
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>(empty)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false), [updatedAt, setUpdatedAt] = useState('')
  const sequence = useRef(0)
  const inFlight = useRef(0)
  const reading = useRef(false)
  const refresh = useCallback(async () => {
    if (inFlight.current || reading.current) return
    reading.current = true; setRefreshing(true)
    const current = ++sequence.current
    try { const data = await api<Workspace>('/api/workspace'); if (current === sequence.current) { setWorkspace(data); setUpdatedAt(new Date().toISOString()); setError('') } }
    catch (e) { if (current === sequence.current) setError((e as Error).message) }
    finally { reading.current = false; setRefreshing(false); setLoading(false) }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 15000)
    const focus = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [refresh])
  const mutate = async (path: string, body: unknown, method = 'POST') => {
    inFlight.current++
    const current = ++sequence.current
    try {
      const result = await api<Workspace | { workspace: Workspace; operationId: string }>(path, method, body)
      if (current === sequence.current) { setWorkspace('workspace' in result ? result.workspace : result); setUpdatedAt(new Date().toISOString()); setError('') }
      return result
    } finally { inFlight.current-- }
  }
  return { workspace, loading, error, refresh, refreshing, updatedAt, mutate }
}
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
export function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }).format(new Date(value)) }
export function downloadText(name: string, body: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([body], { type })), link = document.createElement('a')
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function csvCell(value: string) { const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"` }
