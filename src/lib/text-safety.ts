const UNSAFE_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
const UNSAFE_STORAGE_ROOT_CHARS = new Set(['<', '>', '?', '|', '#', '%'])

export function isControlCode(code: number, includeDel = true): boolean {
  return code <= 0x1f || (includeDel && code === 0x7f)
}

export function isBidiControlCode(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

export function hasControlChar(value: string, includeDel = true): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCode(value.charCodeAt(i), includeDel)) return true
  }
  return false
}

export function hasAsciiWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

export function hasUnsafeFilenameChars(value: string, includeDel = true): boolean {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const code = value.charCodeAt(i)
    if (isControlCode(code, includeDel) || UNSAFE_FILENAME_CHARS.has(ch)) return true
  }
  return false
}

export function hasUnsafeTagChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const code = value.charCodeAt(i)
    if (code <= 0x1f || ch === '<' || ch === '>') return true
  }
  return false
}

export function hasUnsafeStorageRootChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const code = value.charCodeAt(i)
    if (code <= 0x1f || UNSAFE_STORAGE_ROOT_CHARS.has(ch)) return true
  }
  return false
}

export function sanitizeFilenameChars(
  value: string,
  replacement = '-',
  options: { stripBidi?: boolean } = {},
): string {
  const stripBidi = options.stripBidi === true
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const code = value.charCodeAt(i)
    if (
      isControlCode(code, true) ||
      UNSAFE_FILENAME_CHARS.has(ch) ||
      (stripBidi && isBidiControlCode(code))
    ) {
      out += replacement
    } else {
      out += ch
    }
  }
  return out
}

export function stripNonWhitespaceControlChars(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f)) continue
    out += value[i]
  }
  return out
}
