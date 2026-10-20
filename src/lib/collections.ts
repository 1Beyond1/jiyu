import type { Collection } from '../types'

export const defaultCollectionLimits = { maxFileSizeMB: 100, maxFilesPerSubmission: 20 }

export function localDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' }).format(date)
}

export function nextWeek() {
  return localDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
}

export function fileExtensions(formats: string) {
  return [...new Set(formats.split(/[,，、;；\s]+/).map(s => s.replace(/^\./, '').toLowerCase()).filter(Boolean))]
}

export function isExpired(collection: Collection, now = Date.now()) {
  return new Date(`${collection.deadline}T23:59:59.999+08:00`).getTime() < now
}

export function collectionState(collection: Collection) {
  return collection.status === 'active' && isExpired(collection) ? 'expired' : collection.status
}

export const collectionStateNames = { active: '收集中', paused: '已暂停', completed: '已完成', expired: '已截止' }

// 选文件和提交前复用同一组规则；不读取文件内容。
export function submissionError(collection: Collection, files: { name: string; size: number }[], now = Date.now()) {
  if (collection.status !== 'active' || isExpired(collection, now)) return '这项收集已暂停、结束或超过截止时间，请联系发起人。'
  if (!files.length) return '请先选择要提交的文件。'
  if (files.length > collection.maxFilesPerSubmission) return `每次最多提交 ${collection.maxFilesPerSubmission} 个文件，请减少文件数量。`
  const extensions = fileExtensions(collection.formats)
  for (const file of files) {
    if (!extensions.includes(file.name.split('.').pop()?.toLowerCase() || '')) return `「${file.name}」的格式不符合要求，请选择 ${collection.formats} 文件。`
    if (file.size > collection.maxFileSizeMB * 1024 * 1024) return `「${file.name}」超过单文件 ${collection.maxFileSizeMB} MB 上限。`
  }
  return ''
}
