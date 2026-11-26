import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createApp } from './app.ts'
import type { AITransport } from './ai.ts'
import type { Config } from './config.ts'

async function bootDemoApp(
  demo?: Config['demo'],
  demoLoginPerMinute = 10,
  aiTransport?: AITransport,
) {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'demo-mode-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 32 * 1024 * 1024,
    requestBytes: 8 * 1024 * 1024,
    secureCookie: false,
    rateLimits: {
      globalPerMinute: 1000,
    },
    demo: demo ? { ...demo, loginPerMinute: demo.loginPerMinute ?? demoLoginPerMinute } : undefined,
  }
  const { app, store } = await createApp(config, { serveFrontend: false, aiTransport })
  const origin = { origin: config.origin }
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: origin,
    payload: {
      setupToken: store.setupToken(),
      displayName: '站长',
      password: 'admin-very-strong-password-123',
    },
  })
  assert.equal(setup.statusCode, 200)
  const headers = (r: typeof setup) => ({
    ...origin,
    cookie: String(r.headers['set-cookie'] || '').split(';')[0],
    'x-csrf-token': r.json().csrf as string,
  })
  const adminHeaders = headers(setup)
  return {
    dir,
    root,
    app,
    store,
    origin,
    adminHeaders,
    headers,
    close: async () => {
      await app.close()
      if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
    },
  }
}

test('公开体验模式默认关闭且接口返回 404', async () => {
  const ctx = await bootDemoApp(undefined)
  try {
    const status = await ctx.app.inject({ method: 'GET', url: '/api/auth/status' })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().demoEnabled, false)

    const demo = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: ctx.origin,
      payload: {},
    })
    assert.equal(demo.statusCode, 404)
  } finally {
    await ctx.close()
  }
})

test('公开体验模式拒绝签发管理员账号，且仅允许 editor 体验角色', async () => {
  const ctx = await bootDemoApp({ enabled: true, username: 'admin' })
  try {
    const status = await ctx.app.inject({ method: 'GET', url: '/api/auth/status' })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().demoEnabled, false)

    const demo = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: ctx.origin,
      payload: {},
    })
    assert.equal(demo.statusCode, 503)
  } finally {
    await ctx.close()
  }
})

test('公开体验模式（editor）：允许创建任务、拦截全部高危管理/改密/Webhook 接口并执行限流', async () => {
  const ctx = await bootDemoApp({ enabled: true, username: 'guest_editor' }, 2)
  try {
    // 尚未建体验账号前 demoEnabled 为 false
    const before = await ctx.app.inject({ method: 'GET', url: '/api/auth/status' })
    assert.equal(before.json().demoEnabled, false)

    // 管理员创建专用 editor 体验账号
    const addUser = await ctx.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: ctx.adminHeaders,
      payload: {
        username: 'guest_editor',
        displayName: '公开体验成员',
        role: 'editor',
        password: 'demo-random-server-only-password-999',
      },
    })
    assert.equal(addUser.statusCode, 200)

    const status = await ctx.app.inject({ method: 'GET', url: '/api/auth/status' })
    assert.equal(status.json().demoEnabled, true)

    // 跨站 Origin 被拦截
    const badOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin: 'https://evil.example' },
      payload: {},
    })
    assert.equal(badOrigin.statusCode, 403)

    // 一键访客体验成功签发 editor 会话（HttpOnly + SameSite=Strict）
    const demoLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: ctx.origin,
      payload: {},
    })
    assert.equal(demoLogin.statusCode, 200)
    const demoBody = demoLogin.json()
    assert.equal(demoBody.authenticated, true)
    assert.equal(demoBody.user.username, 'guest_editor')
    assert.equal(demoBody.user.role, 'editor')
    assert.equal(demoBody.user.demo, true)
    const setCookie = String(demoLogin.headers['set-cookie'] || '')
    assert.ok(setCookie.includes('HttpOnly'))
    assert.ok(setCookie.includes('SameSite=Strict'))
    const demoHeaders = ctx.headers(demoLogin)

    // 限流生效：demoLoginPerMinute=2，第 2 次 200，第 3 次 429
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: ctx.origin,
      payload: {},
    })
    assert.equal(second.statusCode, 200)
    const third = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: ctx.origin,
      payload: {},
    })
    assert.equal(third.statusCode, 429)

    // 体验会话可以创建收集任务
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: demoHeaders,
      payload: {
        title: '体验新建收集任务',
        description: '验证编辑者能力',
        category: 'document',
        formats: 'PDF, TXT',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
      },
    })
    assert.equal(created.statusCode, 200, created.body)
    const collectionId = created.json().collections[0].id as string

    // 体验账号严禁修改自身密码
    const changePwd = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: demoHeaders,
      payload: {
        currentPassword: 'demo-random-server-only-password-999',
        password: 'hijacked-password-123456',
      },
    })
    assert.equal(changePwd.statusCode, 403)
    assert.match(changePwd.json().error, /公开体验账号不允许修改密码/)

    // 所有管理员及高危接口全部被服务端 403 拦截
    const forbiddenCalls: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      url: string
      payload?: Record<string, unknown>
    }[] = [
      { method: 'GET', url: '/api/users' },
      {
        method: 'POST',
        url: '/api/users',
        payload: {
          username: 'hacker',
          displayName: 'x',
          role: 'admin',
          password: 'password123456',
        },
      },
      { method: 'PATCH', url: '/api/users/primary', payload: { displayName: 'pwned' } },
      { method: 'PATCH', url: '/api/settings', payload: { displayName: 'pwned' } },
      { method: 'POST', url: '/api/settings/diagnostics', payload: {} },
      { method: 'GET', url: '/api/backups' },
      { method: 'POST', url: '/api/backups/run', payload: {} },
      { method: 'PATCH', url: '/api/backups/settings', payload: { enabled: true } },
      { method: 'GET', url: '/api/webhooks' },
      { method: 'POST', url: '/api/webhooks', payload: {} },
      { method: 'POST', url: `/api/collections/${collectionId}/remind-webhook`, payload: {} },
      {
        method: 'POST',
        url: '/api/files/purge',
        payload: { ids: ['fake'], confirm: 'PERMANENT_DELETE' },
      },
      { method: 'POST', url: `/api/collections/${collectionId}/offline-upload`, payload: {} },
      { method: 'PATCH', url: '/api/ai/settings', payload: { enabled: false } },
      { method: 'DELETE', url: '/api/ai/settings/key' },
      { method: 'POST', url: '/api/ai/test', payload: {} },
      { method: 'PUT', url: '/api/storage/connections/s3', payload: {} },
      { method: 'POST', url: '/api/storage/oauth/onedrive/authorize', payload: {} },
    ]
    for (const call of forbiddenCalls) {
      const res = await ctx.app.inject({
        method: call.method,
        url: call.url,
        headers: demoHeaders,
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
      })
      assert.equal(
        res.statusCode,
        403,
        `${call.method} ${call.url} 应返回 403，实际 ${res.statusCode}`,
      )
    }

    // 云存储只读列表也已脱敏
    const storageList = await ctx.app.inject({
      method: 'GET',
      url: '/api/storage/connections',
      headers: demoHeaders,
    })
    assert.equal(storageList.statusCode, 200)
    assert.deepEqual(storageList.json().callbackUrls, {})
  } finally {
    await ctx.close()
  }
})

test('预置模型支持可选 JIYU_AI_REASONING_EFFORT 参数且非法值被忽略', async () => {
  const keys = [
    'JIYU_AI_BASE_URL',
    'JIYU_AI_MODEL',
    'JIYU_AI_KEY',
    'JIYU_AI_PROTOCOL',
    'JIYU_AI_DAILY_CALLS',
    'JIYU_AI_REASONING_EFFORT',
  ] as const
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  const seenBodies: Record<string, unknown>[] = []
  const transport: AITransport = async (req) => {
    seenBodies.push(req.body)
    return {
      choices: [
        { finish_reason: 'stop', message: { content: '{"reply":"连接成功","renames":[]}' } },
      ],
    }
  }
  const ctx = await bootDemoApp(undefined, 10, transport)
  try {
    process.env.JIYU_AI_BASE_URL = 'https://token.moi.matrixorigin.cn/v1'
    process.env.JIYU_AI_MODEL = 'glm-5.3-flash'
    process.env.JIYU_AI_KEY = 'fixture-managed-key'
    process.env.JIYU_AI_PROTOCOL = 'chat'
    process.env.JIYU_AI_DAILY_CALLS = '10'
    process.env.JIYU_AI_REASONING_EFFORT = 'low'

    const aiStatus = (
      await ctx.app.inject({ method: 'GET', url: '/api/ai/settings', headers: ctx.adminHeaders })
    ).json()
    assert.equal(aiStatus.enabled, true)
    assert.equal(aiStatus.model, 'glm-5.3-flash')

    const res1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/ai/test',
      headers: ctx.adminHeaders,
      payload: { consent: true, settingsRevision: aiStatus.revision },
    })
    assert.equal(res1.statusCode, 200, res1.body)
    assert.equal(seenBodies[0].reasoning_effort, 'low')

    // 非法值被安全忽略，不传入请求体
    process.env.JIYU_AI_REASONING_EFFORT = 'turbo-invalid'
    const res2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/ai/test',
      headers: ctx.adminHeaders,
      payload: { consent: true, settingsRevision: aiStatus.revision },
    })
    assert.equal(res2.statusCode, 200, res2.body)
    assert.equal('reasoning_effort' in seenBodies[1], false)
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await ctx.close()
  }
})
