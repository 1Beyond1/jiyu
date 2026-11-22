import { resolve } from 'node:path'

export interface RateLimitConfig {
  globalPerMinute?: number
  multipartPerHour?: number
  uploadCreatePerHour?: number
  uploadChunkPerMinute?: number
  unlockPerMinute?: number
  unlockGlobalMaxFailures?: number
  unlockBackoffBaseMs?: number
}

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
  rateLimits?: RateLimitConfig
}

function envPositiveInt(key: string, fallback: number, max: number) {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} 配置无效`)
  return value
}

export function resolveRateLimits(overrides?: RateLimitConfig) {
  return {
    globalPerMinute:
      overrides?.globalPerMinute ?? envPositiveInt('JIYU_RATE_LIMIT_GLOBAL', 180, 100000),
    multipartPerHour:
      overrides?.multipartPerHour ?? envPositiveInt('JIYU_RATE_LIMIT_UPLOAD_MULTIPART', 30, 100000),
    uploadCreatePerHour:
      overrides?.uploadCreatePerHour ?? envPositiveInt('JIYU_RATE_LIMIT_UPLOAD_CREATE', 60, 100000),
    uploadChunkPerMinute:
      overrides?.uploadChunkPerMinute ??
      envPositiveInt('JIYU_RATE_LIMIT_UPLOAD_CHUNK', 180, 100000),
    unlockPerMinute:
      overrides?.unlockPerMinute ?? envPositiveInt('JIYU_RATE_LIMIT_UNLOCK', 6, 100000),
    unlockGlobalMaxFailures:
      overrides?.unlockGlobalMaxFailures ??
      envPositiveInt('JIYU_RATE_LIMIT_UNLOCK_GLOBAL', 30, 100000),
    unlockBackoffBaseMs: overrides?.unlockBackoffBaseMs ?? 2000,
  }
}

export function configFromEnv(): Config {
  const origin = new URL(process.env.JIYU_ORIGIN || 'http://127.0.0.1:3000').origin
  return {
    dataDir: resolve(process.env.JIYU_DATA_DIR || 'data'),
    origin,
    host: process.env.JIYU_HOST || '127.0.0.1',
    port: envPositiveInt('JIYU_PORT', 3000, 65535),
    quotaBytes: envPositiveInt('JIYU_QUOTA_MB', 10240, 10485760) * 1024 * 1024,
    requestBytes: envPositiveInt('JIYU_REQUEST_MB', 512, 2048) * 1024 * 1024,
    secureCookie: origin.startsWith('https:'),
    trustProxy: process.env.JIYU_TRUST_PROXY === 'true',
    backupDir: process.env.JIYU_BACKUP_DIR ? resolve(process.env.JIYU_BACKUP_DIR) : undefined,
    rateLimits: resolveRateLimits(),
  }
}
