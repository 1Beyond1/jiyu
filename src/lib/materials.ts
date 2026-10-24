import type { Collection, CollectedFile, MaterialParticipant, MaterialReviewState } from '../types.ts'

export const normalizeParticipant = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
export const descriptorKey = (f: { name: string; size: number; lastModified: number }) => JSON.stringify([f.name, f.size, f.lastModified])
export const materialFileVersion = (f: CollectedFile) => JSON.stringify([f.id, f.sha256 || '', f.size, f.name, f.materialId || '', f.materialVersion || 0])
export const materialStateVersion = (f: CollectedFile) => JSON.stringify([materialFileVersion(f), f.materialReview?.operationId || ''])
export function materialReviewState(c: Collection, f: CollectedFile): MaterialReviewState {
  if (!f.materialId || !c.materials?.some(m => m.id === f.materialId)) return 'unclassified'
  if (!f.materialReview) return 'pending'
  if (!c.materialRevision || f.materialReview.rulesRevision !== c.materialRevision || f.materialReview.fileVersion !== materialFileVersion(f)) return 'stale'
  return f.materialReview.decision
}

// Different required items must be covered by different contents, not copies of the same file.
function distinctCoverage(slots: CollectedFile[][]) {
  const assigned = new Map<string, number>()
  const visit = (index: number, seen: Set<string>): boolean => {
    for (const f of slots[index]) {
      const key = f.sha256 || `file:${f.id}`
      if (seen.has(key)) continue
      seen.add(key)
      const previous = assigned.get(key)
      if (previous === undefined || visit(previous, seen)) { assigned.set(key, index); return true }
    }
    return false
  }
  return slots.every((_, i) => visit(i, new Set()))
}

export function materialParticipants(c: Collection, files: CollectedFile[]): MaterialParticipant[] {
  const groups = new Map<string, { identity: string; owner: string; expected: boolean; files: CollectedFile[] }>()
  for (const identity of c.expectedSubmitters || []) groups.set(normalizeParticipant(identity), { identity, owner: '', expected: true, files: [] })
  for (const f of files.filter(f => f.collectionId === c.id && !f.deletedAt)) {
    const identity = f.participant || f.owner, key = normalizeParticipant(identity)
    const person = groups.get(key) || { identity, owner: f.owner, expected: false, files: [] }
    person.owner = f.owner; person.files.push(f); groups.set(key, person)
  }
  return [...groups.values()].map(person => {
    const counts = new Map<string, number>()
    for (const f of person.files) if (f.sha256) counts.set(f.sha256, (counts.get(f.sha256) || 0) + 1)
    const duplicateCount = [...counts.values()].reduce((n, count) => n + Math.max(0, count - 1), 0)
    const slots = (c.materials || []).map(requirement => {
      const list = person.files.filter(f => f.materialId === requirement.id)
      const states = list.map(f => materialReviewState(c, f))
      const duplicate = list.some(f => !!f.sha256 && (counts.get(f.sha256) || 0) > 1)
      const state = !list.length ? 'missing' : states.includes('needs_changes') ? 'needs_changes' : states.includes('stale') ? 'stale' : states.some(s => s !== 'accepted') ? 'pending' : 'accepted'
      return { requirement, files: list, state, duplicate } as MaterialParticipant['slots'][number]
    })
    const unclassified = person.files.filter(f => !c.materials?.some(m => m.id === f.materialId))
    const required = slots.filter(s => s.requirement.required)
    const receivedComplete = required.length > 0 && distinctCoverage(required.map(s => s.files))
    const reviewComplete = receivedComplete && !unclassified.length && slots.every(s => !s.files.length || s.state === 'accepted') && distinctCoverage(required.map(s => s.files.filter(f => materialReviewState(c, f) === 'accepted')))
    const status = reviewComplete ? 'accepted' : slots.some(s => s.state === 'needs_changes') ? 'needs_changes' : !receivedComplete ? 'missing' : unclassified.length ? 'unclassified' : 'pending'
    return { ...person, slots, unclassified, receivedComplete, reviewComplete, status, duplicateCount }
  })
}

export const materialStateLabels = { missing: '缺项', duplicate: '内容重复', unclassified: '未分类', pending: '待人工核对', accepted: '核对通过', needs_changes: '需补充', stale: '旧核对已过期' }

export function materialReportCsv(c: Collection, files: CollectedFile[]) {
  const cell = (value: string | number) => `"${String(value).replace(/^(?=\s*[=+@\-])|^(?=[\t\r\n])/, "'").replaceAll('"', '""')}"`
  const rows: (string | number)[][] = [['任务', '规则版本', '参与标识', '姓名', '名单内', '必需项收齐', '人工核对通过', '材料项', '必需', '当前状态', '文件名', '文件版本', '核对说明']]
  for (const p of materialParticipants(c, files)) {
    const base = [c.title, c.materialRevision || '', p.identity, p.owner, p.expected ? '是' : '否', p.receivedComplete ? '是' : '否', p.reviewComplete ? '是' : '否']
    for (const slot of p.slots) {
      const state = !slot.files.length && !slot.requirement.required ? '选填未交' : materialStateLabels[slot.state]
      if (!slot.files.length) rows.push([...base, slot.requirement.name, slot.requirement.required ? '是' : '否', state, '', '', ''])
      for (const f of slot.files) rows.push([...base, slot.requirement.name, slot.requirement.required ? '是' : '否', `${materialStateLabels[materialReviewState(c, f)]}${slot.duplicate ? ' · 内容重复' : ''}`, f.name, materialFileVersion(f), f.materialReview?.note || ''])
    }
    for (const f of p.unclassified) rows.push([...base, '未分类', '', '未分类', f.name, materialFileVersion(f), f.materialReview?.note || ''])
  }
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')
}
