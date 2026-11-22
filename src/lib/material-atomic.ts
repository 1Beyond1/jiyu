import { sha256Hex } from './browser-crypto.ts'

export interface AtomicMaterialFile {
  id: string
  name: string
  sha256: string
  text: string
  version: string
}
export type AtomicAction =
  | { type: 'rules' }
  | { type: 'read'; ids: string[] }
  | { type: 'locate'; id: string; quote: string }
  | { type: 'parse'; id: string }
  | {
      type: 'calc'
      operation: 'add' | 'subtract' | 'multiply' | 'divide'
      left: number
      right: number
    }
  | { type: 'version' }
  | { type: 'clarify'; questionId: string }
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
// Both arms receive the same original IDs. Stable IDs break ties for identical files.
export function canonicalMaterialSources<T extends { id: string; name: string; sha256?: string }>(
  files: readonly T[],
): T[] {
  return [...files].sort(
    (a, b) =>
      cmp(a.name.normalize('NFC'), b.name.normalize('NFC')) ||
      cmp(a.sha256 || '', b.sha256 || '') ||
      cmp(a.id, b.id),
  )
}
export async function verifyAtomicMaterialFiles(files: AtomicMaterialFile[]) {
  for (const f of files) {
    const actual = await sha256Hex(f.text)
    if (actual !== f.sha256) throw Error('原文hash不一致')
  }
  return canonicalMaterialSources(files)
}
export class MaterialAtomicSession {
  private files: AtomicMaterialFile[]
  private started: number
  private facts: Record<string, string>
  private rules: unknown
  tools = 0
  calls = 0
  tokens = 0
  clarifications = 0
  private pending = false
  private terminalReason: string | null = null
  get blocked() {
    return this.pending || this.terminalReason !== null
  }
  private constructor(
    files: AtomicMaterialFile[],
    rules: unknown,
    facts: Record<string, string> = {},
    now = Date.now(),
  ) {
    if (new Set(files.map((f) => f.id)).size !== files.length) throw Error('重复文件ID')
    this.files = canonicalMaterialSources(files.map((f) => ({ ...f })))
    this.rules = structuredClone(rules)
    this.facts = { ...facts }
    this.started = now
  }
  static async create(
    files: AtomicMaterialFile[],
    rules: unknown,
    facts: Record<string, string> = {},
    now = Date.now(),
  ) {
    return new MaterialAtomicSession(await verifyAtomicMaterialFiles(files), rules, facts, now)
  }
  snapshotKey() {
    return JSON.stringify(this.files.map((f) => [f.id, f.name, f.sha256, f.version]))
  }
  assertSnapshot(key: string) {
    if (key !== this.snapshotKey()) throw Error('原文件版本已变化')
  }
  async replace(files: AtomicMaterialFile[], now = Date.now()) {
    this.limit(now)
    const verified = await verifyAtomicMaterialFiles(files)
    this.limit()
    if (new Set(verified.map((f) => f.id)).size !== verified.length) throw Error('重复文件ID')
    this.files = verified.map((f) => ({ ...f }))
  }
  private limit(now = Date.now()) {
    if (now - this.started > 180000) this.terminalReason ??= '任务超时'
    if (this.terminalReason || this.pending) throw Error('预算已停止或超时')
  }
  beginModelCall(now = Date.now()) {
    this.limit(now)
    if (this.calls >= 4 || this.tokens >= 24000) throw Error('模型调用预算已用完')
    this.calls++
    this.pending = true
  }
  finishModelCall(tokens: number | null, now = Date.now()) {
    if (!this.pending) throw Error('没有在途模型调用')
    this.pending = false
    if (now - this.started > 180000) this.terminalReason ??= '任务超时'
    if (tokens === null || !Number.isSafeInteger(tokens) || tokens < 0)
      this.terminalReason ??= '用量未知'
    else {
      this.tokens += tokens
      if (this.tokens > 24000) this.terminalReason ??= '模型token预算已超出'
    }
    if (this.terminalReason) throw Error(this.terminalReason)
  }
  invoke(action: AtomicAction, now = Date.now()) {
    this.limit(now)
    const cost = action.type === 'read' ? Math.max(1, action.ids.length) : 1
    if (this.tools + cost > 20) throw Error('原子工具预算已用完')
    this.tools += cost
    const done = (value: unknown) => {
      this.limit()
      return value
    }
    if (action.type === 'rules') return done(structuredClone(this.rules))
    if (action.type === 'version')
      return done(
        this.files.map((f, i) => ({
          alias: `F${i + 1}`,
          id: f.id,
          sha256: f.sha256,
          version: f.version,
        })),
      )
    if (action.type === 'read') {
      if (
        !action.ids.length ||
        new Set(action.ids).size !== action.ids.length ||
        action.ids.some((id) => !this.files.some((f) => f.id === id))
      )
        throw Error('文件不在授权范围')
      return done(
        action.ids.map((id) => {
          const i = this.files.findIndex((f) => f.id === id),
            f = this.files[i]
          return { alias: `F${i + 1}`, ...f }
        }),
      )
    }
    if (action.type === 'locate') {
      const i = this.files.findIndex((f) => f.id === action.id),
        f = this.files[i]
      if (!f || !action.quote || action.quote.length > 300) throw Error('引用不在授权范围')
      let pos = f.text.indexOf(action.quote),
        count = 0,
        first = -1
      while (pos >= 0) {
        if (!count) first = pos
        count++
        pos = f.text.indexOf(action.quote, pos + 1)
      }
      const start = count === 1 ? first : -1
      return done({
        alias: `F${i + 1}`,
        start,
        end: start < 0 ? -1 : start + action.quote.length,
        exact: count === 1,
        occurrences: count,
        ambiguous: count > 1,
      })
    }
    if (action.type === 'parse') {
      const i = this.files.findIndex((f) => f.id === action.id),
        f = this.files[i]
      if (!f) throw Error('文件不在授权范围')
      let start = 0
      return done({
        alias: `F${i + 1}`,
        lines: f.text.split('\n').map((line) => {
          const result = { start, end: start + line.length, text: line }
          start += line.length + 1
          return result
        }),
      })
    }
    if (action.type === 'calc') {
      const { left, right, operation } = action
      if (
        !Number.isSafeInteger(left) ||
        !Number.isSafeInteger(right) ||
        Math.abs(left) > 1000000 ||
        Math.abs(right) > 1000000
      )
        throw Error('计算参数无效')
      const value =
        operation === 'add'
          ? left + right
          : operation === 'subtract'
            ? left - right
            : operation === 'multiply'
              ? left * right
              : operation === 'divide' && right !== 0
                ? left / right
                : NaN
      if (!Number.isFinite(value)) throw Error('计算操作无效')
      return done({ value })
    }
    if (++this.clarifications > 2 || !Object.hasOwn(this.facts, action.questionId))
      throw Error('无可授权澄清或次数已用完')
    return done(this.facts[action.questionId])
  }
}
