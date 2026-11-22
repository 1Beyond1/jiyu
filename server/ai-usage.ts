export interface TokenUsage {
  rawUsage: Record<string, unknown> | null
  tokens: number | null
  knownLowerBound: number | null
  basis: 'reported_total' | 'conservative_counters' | 'partial' | 'unknown'
  reportedTotal: number | null
}

// Top-level reasoning may be additional on compatible gateways. Nested reasoning
// details are already part of normal completion/output counts and are not added.
export function tokenUsage(value: unknown, secret = ''): TokenUsage {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const rawUsage = raw
    ? (JSON.parse(
        secret ? JSON.stringify(raw).replaceAll(secret, '[已隐藏]') : JSON.stringify(raw),
      ) as Record<string, unknown>)
    : null
  const counter = (name: string) =>
    typeof raw?.[name] === 'number' && Number.isSafeInteger(raw[name]) && Number(raw[name]) >= 0
      ? Number(raw[name])
      : null
  const total = counter('total_tokens'),
    prompt = counter('prompt_tokens'),
    completion = counter('completion_tokens'),
    reasoning = counter('reasoning_tokens'),
    input = counter('input_tokens'),
    output = counter('output_tokens')
  const safeSum = (values: number[]) => {
    const n = values.reduce((a, b) => a + b, 0)
    return Number.isSafeInteger(n) ? n : null
  }
  const complete = [
    prompt !== null && completion !== null
      ? safeSum([prompt, completion, ...(reasoning === null ? [] : [reasoning])])
      : null,
    input !== null && output !== null
      ? safeSum([input, output, ...(reasoning === null ? [] : [reasoning])])
      : null,
  ].filter((v): v is number => v !== null)
  const lower = [total, prompt, completion, reasoning, input, output, ...complete].filter(
    (v): v is number => v !== null,
  )
  const tokens =
    total !== null || complete.length
      ? Math.max(...[total, ...complete].filter((v): v is number => v !== null))
      : null
  return {
    rawUsage,
    tokens,
    knownLowerBound: lower.length ? Math.max(...lower) : null,
    basis:
      tokens === null
        ? lower.length
          ? 'partial'
          : 'unknown'
        : total !== null && tokens === total
          ? 'reported_total'
          : 'conservative_counters',
    reportedTotal: total,
  }
}
