import type { Collection, CollectedFile } from '../types.ts'
import { fileNameKey } from './submission-naming.ts'

export function checkCollection(c: Collection, files: CollectedFile[]) {
  const list = files.filter(f => f.collectionId === c.id && !f.deletedAt)
  const submitted = new Set(list.map(f => fileNameKey(f.participant || f.owner)))
  const missing = (c.expectedSubmitters || []).filter(v => !submitted.has(fileNameKey(v)))
  const duplicates = (key: (f: CollectedFile) => string | undefined) => {
    const groups = new Map<string, CollectedFile[]>()
    for (const f of list) { const value = key(f); if (value) { const group = groups.get(value) || []; group.push(f); groups.set(value, group) } }
    return [...groups.values()].filter(group => group.length > 1)
  }
  return { files: list.length, submitted: submitted.size, hasRoster: !!c.expectedSubmitters?.length, missing, contentGroups: duplicates(f => f.sha256), nameGroups: duplicates(f => fileNameKey(f.name)) }
}
