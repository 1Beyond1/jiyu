export type ReviewShortcutAction = 'next' | 'prev' | 'approve' | 'reject' | 'submit'

export interface ShortcutKeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
}

export interface EditableTargetLike {
  tagName?: string
  isContentEditable?: boolean
}

export function isEditableTarget(target: EditableTargetLike | null | undefined): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = (target.tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function resolveReviewShortcut(
  event: ShortcutKeyLike,
  editable: boolean,
): ReviewShortcutAction | null {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === 'Enter') {
    return 'submit'
  }
  if (editable) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const lower = event.key.toLowerCase()
  if (lower === 'j') return 'next'
  if (lower === 'k') return 'prev'
  if (lower === 'a' && !event.repeat) return 'approve'
  if (lower === 'r' && !event.repeat) return 'reject'
  return null
}

export function stepFileIndex(
  currentIndex: number,
  total: number,
  direction: 'next' | 'prev',
): number {
  if (total <= 0) return -1
  if (total === 1) return 0
  const base = currentIndex >= 0 && currentIndex < total ? currentIndex : 0
  return direction === 'next' ? (base + 1) % total : (base - 1 + total) % total
}
