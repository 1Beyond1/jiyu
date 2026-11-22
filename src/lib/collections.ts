import type { Collection } from '../types'

export const defaultCollectionLimits = { maxFileSizeMB: 100, maxFilesPerSubmission: 20 }

export function effectiveFileLimit(
  collection: Pick<Collection, 'maxFileSizeMB' | 'requestLimitMB'>,
) {
  return Math.min(collection.maxFileSizeMB, collection.requestLimitMB ?? collection.maxFileSizeMB)
}

export function localDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Taipei',
  }).format(date)
}

export function nextWeek() {
  return localDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
}

export function fileExtensions(formats: string) {
  return [
    ...new Set(
      formats
        .split(/[,，、;；\s]+/)
        .map((s) => s.replace(/^\./, '').toLowerCase())
        .filter(Boolean),
    ),
  ]
}

export function fileExtension(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isExpired(collection: Collection, now = Date.now()) {
  return new Date(`${collection.deadline}T23:59:59.999+08:00`).getTime() < now
}

export function collectionState(collection: Collection) {
  return collection.status === 'active' && isExpired(collection) ? 'expired' : collection.status
}

export const collectionStateNames = {
  active: '收集中',
  paused: '已暂停',
  completed: '已完成',
  expired: '已截止',
}

// 选文件和提交前复用同一组规则；不读取文件内容。
export function submissionError(
  collection: Collection,
  files: { name: string; size: number }[],
  now = Date.now(),
) {
  if (collection.archivedAt) return '这项收集已归档，暂不接收新文件，请联系发起人。'
  if (collection.status !== 'active' || isExpired(collection, now))
    return '这项收集已暂停、结束或超过截止时间，请联系发起人。'
  if (!files.length) return '请先选择要提交的文件。'
  if (files.length > collection.maxFilesPerSubmission)
    return `每次最多提交 ${collection.maxFilesPerSubmission} 个文件，请减少文件数量。`
  const extensions = fileExtensions(collection.formats)
  for (const file of files) {
    if (file.size === 0) return `「${file.name}」是空文件，请重新选择`
    if (!extensions.includes(fileExtension(file.name)))
      return `「${file.name}」的格式不符合要求，请选择 ${collection.formats} 文件。`
    if (file.size > effectiveFileLimit(collection) * 1024 * 1024)
      return `「${file.name}」超过单文件 ${effectiveFileLimit(collection)} MB 上限。`
  }
  return ''
}

/** The deadline the person wrote: 2026-12-20, 2026年12月20日, or 12月20日 (the next such day). With several dates, only one marked as the deadline counts. */
export function deadlineFromText(text: string, today = localDate()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  const at = (y: number, m: number, d: number) => {
    const date = new Date(Date.UTC(y, m - 1, d))
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : ''
  }
  const year = +today.slice(0, 4)
  const dates = [...text.matchAll(/(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})[日号]?/g)]
    .map((m) => {
      let value = at(m[1] ? +m[1] : year, +m[2], +m[3])
      if (!m[1] && value && value < today) value = at(year + 1, +m[2], +m[3])
      const before = text.slice(Math.max(0, m.index! - 6), m.index),
        after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 6)
      return {
        value,
        marked:
          /截止|期限|deadline/i.test(before) || /^\s*(?:前|之前|以前|为止|截止|截至)/.test(after),
      }
    })
    .filter((d) => d.value && d.value >= today)
  const chosen = dates.length === 1 ? dates : dates.filter((d) => d.marked)
  return chosen.length === 1 ? chosen[0].value : ''
}
