import { useEffect, useRef, useState } from 'react'
import type { Collection, CollectedFile, MaterialParticipant, MaterialStateReport } from '../types'
import { api } from '../lib/api'
import { materialSnapshotKey } from '../lib/materials'
import { MaterialSnapshotChanged, readMaterialRows } from '../lib/material-state'

export function useMaterialState(
  c: Collection,
  files: CollectedFile[],
  refreshKey: string,
  onSync: () => Promise<void>,
) {
  const binding = materialSnapshotKey(c, files) + JSON.stringify(c.materials)
  const latestBinding = useRef(binding)
  latestBinding.current = binding
  const sync = useRef(onSync)
  sync.current = onSync
  const generation = useRef(0),
    syncedBinding = useRef('')
  const [result, setResult] = useState<{
    binding: string
    report: MaterialStateReport
    rows: MaterialParticipant[]
  } | null>(null)
  const [reading, setReading] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0)
  useEffect(() => {
    const ticket = ++generation.current,
      controller = new AbortController()
    setReading(true)
    setError('')
    const current = () =>
      ticket === generation.current &&
      latestBinding.current === binding &&
      !controller.signal.aborted
    void (async () => {
      try {
        const report = await api<MaterialStateReport>(
          `/api/collections/${encodeURIComponent(c.id)}/materials?revision=${encodeURIComponent(c.materialRevision || '')}`,
          'GET',
          undefined,
          controller.signal,
        )
        const rows = await readMaterialRows(report, c, files)
        if (current()) {
          setResult({ binding, report, rows })
          syncedBinding.current = ''
        }
      } catch (e) {
        if (!current()) return
        setError((e as Error).message)
        if (e instanceof MaterialSnapshotChanged && syncedBinding.current !== binding) {
          syncedBinding.current = binding
          void sync.current()
        }
      } finally {
        if (current()) setReading(false)
      }
    })()
    return () => {
      generation.current++
      controller.abort()
    }
    // Binding includes rule token, roster, requirements and every active file's version.
    // Refresh time triggers revalidation even when a workspace read has identical records.
  }, [binding, refreshKey, retry, c.id, c.materialRevision])
  const visible = result?.binding === binding ? result : null
  return {
    report: visible?.report || null,
    rows: visible?.rows || [],
    ready: !!visible && !reading && !error,
    reading,
    error,
    retry: () => setRetry((n) => n + 1),
  }
}
