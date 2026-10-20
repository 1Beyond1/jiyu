import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
export const token = () => randomBytes(32).toString('base64url')
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const key = await scrypt(password, salt, 64) as Buffer
  return `${salt}:${key.toString('hex')}`
}

export async function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  const key = await scrypt(password, salt, 64) as Buffer
  const expected = Buffer.from(hash, 'hex')
  return expected.length === key.length && timingSafeEqual(expected, key)
}

export function equalToken(value: string, expected: string) {
  const a = Buffer.from(digest(value)), b = Buffer.from(digest(expected))
  return timingSafeEqual(a, b)
}

export class HttpError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode }
}

export function text(value: unknown, label: string, max: number, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new HttpError(400, `${label}需填写 ${min}–${max} 个字符`)
  return value.trim()
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求格式无效')
  return value as Record<string, unknown>
}

export function safeName(value: unknown) {
  const name = text(value, '文件名', 200)
  if (/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) throw new HttpError(400, '文件名包含不支持的字符')
  return name
}

export function passwordInput(value: unknown, min = 12) {
  if (typeof value !== 'string' || value.length < min || value.length > 128 || !value.trim()) throw new HttpError(400, `密码需填写 ${min}–128 个字符`)
  return value
}
