import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './store.ts'
import { HttpError } from './security.ts'

function masterKey(store: Store, create = false) {
  const path = join(store.dataDir, 'secrets.key')
  if (!existsSync(path) && create) writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 })
  if (!existsSync(path)) throw new HttpError(400, '凭证主密钥缺失，请从完整备份恢复或重新填写凭证')
  const key = readFileSync(path)
  if (key.length !== 32) throw new HttpError(400, '凭证主密钥无效，请从完整备份恢复')
  return key
}
export function encrypt(store: Store, value: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', masterKey(store, true), iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.')
}
export function decrypt(store: Store, value: string) {
  try { const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64')); const cipher = createDecipheriv('aes-256-gcm', masterKey(store), iv); cipher.setAuthTag(tag); return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8') }
  catch { throw new HttpError(400, '凭证无法解密，请从完整备份恢复或重新填写') }
}
