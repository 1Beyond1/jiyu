import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import { resolveRateLimits } from './config.ts'
import type { Config } from './config.ts'

const KEYS = ['JIYU_RATE_LIMIT_GLOBAL', 'JIYU_RATE_LIMIT_UPLOAD_MULTIPART', 'JIYU_RATE_LIMIT_UPLOAD_CREATE', 'JIYU_RATE_LIMIT_UPLOAD_CHUNK'] as const

function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  const prev = KEYS.map(k => [k, process.env[k]] as const)
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, values)
  return () => { for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('限流配置保留原默认值，支持通过环境变量覆盖并拦截非法值', () => {
  const restoreDefault = withEnv({})
  try {
    assert.deepEqual(resolveRateLimits(), { globalPerMinute: 180, multipartPerHour: 30, uploadCreatePerHour: 60, uploadChunkPerMinute: 180 })
  } finally { restoreDefault() }

  const restoreCustom = withEnv({ JIYU_RATE_LIMIT_GLOBAL: '250', JIYU_RATE_LIMIT_UPLOAD_MULTIPART: '12', JIYU_RATE_LIMIT_UPLOAD_CREATE: '25', JIYU_RATE_LIMIT_UPLOAD_CHUNK: '90' })
  try {
    assert.deepEqual(resolveRateLimits(), { globalPerMinute: 250, multipartPerHour: 12, uploadCreatePerHour: 25, uploadChunkPerMinute: 90 })
  } finally { restoreCustom() }

  const restoreBad = withEnv({ JIYU_RATE_LIMIT_GLOBAL: '0' })
  try {
    assert.throws(() => resolveRateLimits(), /JIYU_RATE_LIMIT_GLOBAL/)
  } finally { restoreBad() }
})

test('自定义限流阈值在全局、multipart、分片创建和分片 PUT 接口真实生效', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'rate-limit-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000,
    quotaBytes: 4 * 1024 ** 2, requestBytes: 2 * 1024 ** 2, secureCookie: false,
    rateLimits: { globalPerMinute: 100, multipartPerHour: 1, uploadCreatePerHour: 1, uploadChunkPerMinute: 1 },
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: store.setupToken(), displayName: '限流', password: 'rate-limit-password' } })
    const headers = { origin: config.origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const created = await app.inject({ method: 'POST', url: '/api/collections', headers, payload: { title: '限流测试', description: '', category: 'document', target: 10, deadline: '2099-12-31', formats: 'TXT', maxFileSizeMB: 1, maxFilesPerSubmission: 5 } })
    const token = created.json().collections[0].uploadToken as string

    // Multipart limit = 1/hour
    const boundary = 'rl-bound'
    const mpPayload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="owner"\r\n\r\n测试\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n\r\nhi\r\n--${boundary}--\r\n`)
    const mp1 = await app.inject({ method: 'POST', url: `/api/public/${token}/upload`, headers: { origin: config.origin, 'idempotency-key': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: mpPayload })
    assert.equal(mp1.statusCode, 201, mp1.body)
    const mp2 = await app.inject({ method: 'POST', url: `/api/public/${token}/upload`, headers: { origin: config.origin, 'idempotency-key': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: mpPayload })
    assert.equal(mp2.statusCode, 429)

    // Upload create limit = 1/hour
    const keyHeader = { origin: config.origin, 'x-upload-key': 'a'.repeat(64) }
    const batchId = randomUUID()
    const u1 = await app.inject({ method: 'POST', url: `/api/public/${token}/uploads/${batchId}`, headers: keyHeader, payload: { owner: '测试', files: [{ name: 'b.txt', size: 2, lastModified: 1 }] } })
    assert.equal(u1.statusCode, 200, u1.body)
    const u2 = await app.inject({ method: 'POST', url: `/api/public/${token}/uploads/${randomUUID()}`, headers: keyHeader, payload: { owner: '测试', files: [{ name: 'c.txt', size: 2, lastModified: 1 }] } })
    assert.equal(u2.statusCode, 429)

    // Upload chunk PUT limit = 1/minute
    const bytes = Buffer.from('ok'), hash = createHash('sha256').update(bytes).digest('hex')
    const p1 = await app.inject({ method: 'PUT', url: `/api/public/${token}/uploads/${batchId}/0/0`, headers: { ...keyHeader, 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash }, payload: bytes })
    assert.equal(p1.statusCode, 200, p1.body)
    const p2 = await app.inject({ method: 'PUT', url: `/api/public/${token}/uploads/${batchId}/0/0`, headers: { ...keyHeader, 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash }, payload: bytes })
    assert.equal(p2.statusCode, 429)
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})
