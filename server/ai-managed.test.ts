import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createApp } from './app.ts'
import type { AIRequest, AITransport } from './ai.ts'

const origin = 'http://127.0.0.1:3000'

async function setup(transport: AITransport) {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'ai-managed-')), dataDir = join(dir, 'data')
  const config = { dataDir, origin, host: '127.0.0.1', port: 3000, quotaBytes: 1024 ** 3, requestBytes: 512 * 1024 ** 2, secureCookie: false }
  const service = await createApp(config, { serveFrontend: false, aiTransport: transport })
  const setupToken = await readFile(join(dataDir, 'setup-token'), 'utf8')
  const res = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin }, payload: { setupToken: setupToken.trim(), displayName: '测试', password: 'managed-test-password' } })
  assert.equal(res.statusCode, 200, res.body)
  const cookie = res.headers['set-cookie']!.toString().split(';')[0], csrf = res.json().csrf as string
  const headers = { origin, cookie, 'x-csrf-token': csrf }
  return { service, headers, dir, dataDir, close: async () => { await service.app.close(); await rm(dir, { recursive: true, force: true }) } }
}

const ENV = ['JIYU_AI_BASE_URL', 'JIYU_AI_MODEL', 'JIYU_AI_KEY', 'JIYU_AI_DAILY_CALLS'] as const
function withEnv(values: Partial<Record<(typeof ENV)[number], string>>) {
  const old = ENV.map(k => [k, process.env[k]] as const)
  for (const k of ENV) delete process.env[k]
  Object.assign(process.env, values)
  return () => { for (const [k, v] of old) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('服务器预置模型免配置可用，Key 不进响应和数据库', async () => {
  const key = 'managed-fixture-key-not-real'
  const restore = withEnv({ JIYU_AI_BASE_URL: 'https://provider.example/v1', JIYU_AI_MODEL: 'fixture-model', JIYU_AI_KEY: key, JIYU_AI_DAILY_CALLS: '1' })
  let captured: AIRequest | undefined
  const transport: AITransport = async req => {
    captured = req
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply: '好', renames: [] }) } }], usage: { total_tokens: 5 } }
  }
  const { service, headers, dataDir, close } = await setup(transport)
  try {
    const settings = (await service.app.inject({ method: 'GET', url: '/api/ai/settings', headers })).json()
    assert.equal(settings.enabled, true)
    assert.equal(settings.managed, true)
    assert.equal(settings.keyReady, true)
    assert.equal(settings.model, 'fixture-model')
    assert.ok(!JSON.stringify(settings).includes(key))
    const body = { prompt: '你好', fileIds: [], includeOwners: false, includeContent: false, contentConsent: false, consent: true, settingsRevision: settings.revision }
    const first = await service.app.inject({ method: 'POST', url: '/api/ai/chat', headers, payload: body })
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(captured?.apiKey, key)
    assert.equal(captured?.endpoint.href, 'https://provider.example/v1/chat/completions')
    const second = await service.app.inject({ method: 'POST', url: '/api/ai/chat', headers, payload: body })
    assert.equal(second.statusCode, 429)
    await service.app.close()
    assert.ok(!(await readFile(join(dataDir, 'jiyu.sqlite'))).includes(key))
  } finally { await close().catch(() => {}); restore() }
})

test('管理员可以关掉预置模型；缺配置时仍默认关闭', async () => {
  const restore = withEnv({ JIYU_AI_BASE_URL: 'https://provider.example/v1', JIYU_AI_MODEL: 'm', JIYU_AI_KEY: 'k' })
  const { service, headers, close } = await setup(async () => { throw new Error('should not call') })
  try {
    const off = await service.app.inject({ method: 'DELETE', url: '/api/ai/settings/key', headers })
    assert.equal(off.json().enabled, false)
    assert.equal(off.json().managed, undefined)
    assert.equal((await service.app.inject({ method: 'GET', url: '/api/ai/settings', headers })).json().enabled, false)
  } finally { await close(); restore() }
  const none = withEnv({ JIYU_AI_BASE_URL: 'https://provider.example/v1', JIYU_AI_MODEL: 'm' })
  const second = await setup(async () => { throw new Error('should not call') })
  try {
    const s = (await second.service.app.inject({ method: 'GET', url: '/api/ai/settings', headers: second.headers })).json()
    assert.equal(s.enabled, false)
    assert.equal(s.hasKey, false)
  } finally { await second.close(); none() }
})
