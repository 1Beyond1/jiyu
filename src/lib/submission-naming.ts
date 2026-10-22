import type { Collection } from '../types.ts'

export const fileNameKey = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase('en-US')
const segment = (value: string) => value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 45) || '未填写'

// The example and server use the same rules; actual names are decided at commit.
export function submissionFileName(c: Pick<Collection, 'title' | 'naming'>, name: string, owner: string, fields: Record<string, string>, sequence: number, at: string, occupied = new Set<string>()) {
  if (!c.naming?.parts.length) return name
  const dot = name.lastIndexOf('.'), ext = dot > 0 ? name.slice(dot) : '', original = dot > 0 ? name.slice(0, dot) : name
  const values: Record<string, string> = { ...fields, owner, collection: c.title, date: new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).replaceAll('-', ''), sequence: String(sequence).padStart(3, '0'), original }
  let base = c.naming.parts.map(p => segment(values[p] || '')).join(c.naming.separator).slice(0, 150)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `_${base}`
  let result = base + ext, n = 2
  while (occupied.has(fileNameKey(result))) result = `${base}_${n++}${ext}`
  occupied.add(fileNameKey(result))
  return result
}
