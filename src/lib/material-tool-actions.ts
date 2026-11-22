import type { AtomicAction } from './material-atomic.ts'
export const MATERIAL_TOOL_PROTOCOL =
  '可自主调用规则 rules、版本 version、读取 read（ids 数组）、分行 parse（id）、定位 locate（id、quote）、计算 calc（operation、left、right）、澄清 clarify（questionId）；id 使用文件别名。只输出 JSON：{"actions":[{"type":"read","ids":["F1"]}]}，或最终输出 {"findings":[...]}。计算只接受当前材料中已有的整数；没有可用澄清事实时不能虚构答案。最多四轮，可批量读取。'
export function parseAtomicAction(
  raw: unknown,
  files: readonly { id: string; text: string }[],
  rules: unknown,
  allowedFacts: readonly string[] = [],
): AtomicAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('工具参数无效')
  const a = raw as Record<string, unknown>,
    type = a.type,
    keys = Object.keys(a).sort().join(',')
  if ((type === 'rules' || type === 'version') && keys === 'type') return { type }
  if (
    type === 'read' &&
    keys === 'ids,type' &&
    Array.isArray(a.ids) &&
    a.ids.length > 0 &&
    new Set(a.ids).size === a.ids.length &&
    a.ids.every((id) => typeof id === 'string' && files.some((f) => f.id === id))
  )
    return { type, ids: a.ids as string[] }
  if (
    type === 'parse' &&
    keys === 'id,type' &&
    typeof a.id === 'string' &&
    files.some((f) => f.id === a.id)
  )
    return { type, id: a.id }
  if (
    type === 'locate' &&
    keys === 'id,quote,type' &&
    typeof a.id === 'string' &&
    typeof a.quote === 'string' &&
    a.quote.length > 0 &&
    a.quote.length <= 300 &&
    files.some((f) => f.id === a.id && f.text.includes(String(a.quote)))
  )
    return { type, id: a.id, quote: a.quote }
  if (
    type === 'clarify' &&
    keys === 'questionId,type' &&
    typeof a.questionId === 'string' &&
    allowedFacts.includes(a.questionId)
  )
    return { type, questionId: a.questionId }
  if (
    type === 'calc' &&
    keys === 'left,operation,right,type' &&
    ['add', 'subtract', 'multiply', 'divide'].includes(String(a.operation)) &&
    Number.isSafeInteger(a.left) &&
    Number.isSafeInteger(a.right) &&
    Math.abs(Number(a.left)) <= 1000000 &&
    Math.abs(Number(a.right)) <= 1000000
  ) {
    const numbers = new Set(
      (JSON.stringify(rules) + ' ' + files.map((f) => f.text).join(' '))
        .match(/-?\d+/g)
        ?.map(Number) || [],
    )
    if (numbers.has(Number(a.left)) && numbers.has(Number(a.right)))
      return {
        type,
        operation: a.operation as 'add' | 'subtract' | 'multiply' | 'divide',
        left: Number(a.left),
        right: Number(a.right),
      }
  }
  throw Error('模型请求了范围外工具或参数')
}
