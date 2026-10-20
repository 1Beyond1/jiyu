import { resolve } from 'node:path'

export interface Config {
  dataDir: string
  origin: string
  host: string
  port: number
  quotaBytes: number
  requestBytes: number
  secureCookie: boolean
  trustProxy?: boolean
  backupDir?: string
}

export function configFromEnv(): Config {
  const origin = new URL(process.env.JIYU_ORIGIN || 'http://127.0.0.1:3000').origin
  const number = (key: string, fallback: number, max: number) => {
    const value = Number(process.env[key] || fallback)
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} 配置无效`)
    return value
  }
  return {
    dataDir: resolve(process.env.JIYU_DATA_DIR || 'data'), origin,
    host: process.env.JIYU_HOST || '127.0.0.1', port: number('JIYU_PORT', 3000, 65535),
    quotaBytes: number('JIYU_QUOTA_MB', 10240, 10485760) * 1024 * 1024,
    requestBytes: number('JIYU_REQUEST_MB', 512, 2048) * 1024 * 1024,
    secureCookie: origin.startsWith('https:'),
    trustProxy: process.env.JIYU_TRUST_PROXY === 'true',
    backupDir: process.env.JIYU_BACKUP_DIR ? resolve(process.env.JIYU_BACKUP_DIR) : undefined,
  }
}
