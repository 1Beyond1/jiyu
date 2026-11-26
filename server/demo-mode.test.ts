import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createApp } from './app.ts'
import type { AITransport } from './ai.ts'
import type { Config } from './config.ts'
import type { RemoteHTTP, RemoteRequest } from './remote-http.ts'
import type { WebhookPolicy } from './webhooks.ts'
import { localDate } from '../src/lib/collections.ts'
import { materialStateVersion } from '../src/lib/materials.ts'
import type { CollectedFile } from '../src/types.ts'

async function* bufStream(text: string): AsyncIterable<Buffer> {
  yield Buffer.from(text, 'utf8')
}

async function bootDemoApp(
  demo?: Config['demo'],
  demoLoginPerMinute = 10,
  aiTransport?: AITransport,
  webhookPolicy?: WebhookPolicy,
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
  const { app, store, webhooks } = await createApp(config, {
    serveFrontend: false,
    aiTransport,
    webhookPolicy,
  })
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
    config,
    app,
    store,
    webhooks,
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

test('红队回归（公开体验模式）：3 条 Webhook 绕过路径全静音、关闭开关重启吊销旧会话、敏感数据与管理员任务严格隔离', async () => {
  const webhookHits: { url: string; event: string; body: string }[] = []
  const webhookHttp: RemoteHTTP = async (req: RemoteRequest) => {
    webhookHits.push({
      url: req.url.toString(),
      event: String(req.headers?.['X-Jiyu-Event'] || ''),
      body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '',
    })
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: bufStream('{"ok":true}'),
    }
  }

  const ctx = await bootDemoApp({ enabled: true, username: 'guest_editor' }, 20, undefined, {
    http: webhookHttp,
    debounceMs: 10,
    retryBaseMs: 10,
    deadlineIntervalMs: 60 * 60 * 1000,
  })

  try {
    // 1. 管理员配置一个订阅全部 4 类事件的真实 Webhook 渠道
    const hookRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: ctx.adminHeaders,
      payload: {
        name: '管理员生产告警群',
        type: 'generic',
        url: 'https://hooks.example.com/prod-admin-alert',
        events: [
          'submission.created',
          'review.accepted',
          'review.needs_changes',
          'collection.deadline_soon',
        ],
        debounceSeconds: 5,
        enabled: true,
      },
    })
    assert.equal(hookRes.statusCode, 201, hookRes.body)

    // 2. 管理员创建体验账号 + 另一位真实编辑者账号
    for (const u of [
      {
        username: 'guest_editor',
        displayName: '公开体验成员',
        role: 'editor',
        password: 'demo-only-strong-password-999',
      },
      {
        username: 'real_editor',
        displayName: '真实编辑成员',
        role: 'editor',
        password: 'real-editor-password-999',
      },
    ]) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/api/users',
        headers: ctx.adminHeaders,
        payload: u,
      })
      assert.equal(r.statusCode, 200, r.body)
    }

    // 3. 管理员创建包含敏感名单、材料清单与定时预警的私密任务
    const adminColRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: ctx.adminHeaders,
      payload: {
        title: '管理员私密收集',
        description: '仅管理员可见名单与令牌',
        category: 'document',
        formats: 'TXT, PDF',
        deadline: localDate(),
        target: 10,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
        expectedSubmitters: ['机密人员甲', '机密人员乙'],
        materials: [{ id: 'mat_1', name: '身份核验表', required: true, description: '' }],
        deadlineReminder: { enabled: true, hoursBefore: 24, desensitizeNames: false },
      },
    })
    assert.equal(adminColRes.statusCode, 200, adminColRes.body)
    const adminCol = adminColRes.json().collections[0] as {
      id: string
      uploadToken: string
      materialRevision: string
    }
    assert.ok(adminCol.uploadToken)

    // 4. 体验用户一键登录，校验短 TTL（2 小时 = 7200s）与 sessions.is_demo=1
    const demoLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: ctx.origin,
      payload: {},
    })
    assert.equal(demoLogin.statusCode, 200)
    const demoSetCookie = String(demoLogin.headers['set-cookie'] || '')
    assert.match(demoSetCookie, /Max-Age=7200/, '公开体验会话应签发 2 小时短 TTL')
    const demoSessionRows = ctx.store.db
      .prepare('SELECT is_demo FROM sessions WHERE is_demo=1')
      .all() as { is_demo: number }[]
    assert.equal(demoSessionRows.length, 1)
    const demoHeaders = ctx.headers(demoLogin)

    const realEdLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: ctx.origin,
      payload: { username: 'real_editor', password: 'real-editor-password-999' },
    })
    assert.equal(realEdLogin.statusCode, 200)
    const realEditorHeaders = ctx.headers(realEdLogin)

    // 5. Webhook 绕过路径 3：体验账号严禁创建或修改开启 deadlineReminder 的任务
    const badCreate = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: demoHeaders,
      payload: {
        title: '试图开启预警的体验任务',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: localDate(),
        target: 5,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 3,
        deadlineReminder: { enabled: true, hoursBefore: 24, desensitizeNames: true },
      },
    })
    assert.equal(badCreate.statusCode, 403)
    assert.match(badCreate.json().error, /定时截止/)

    // 正常创建体验任务（带材料清单与体验名单），应标 createdByDemo=true 并保留自身体验链路
    const demoColRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: demoHeaders,
      payload: {
        title: '访客体验任务',
        description: '用于公开演示全流程',
        category: 'document',
        formats: 'TXT',
        deadline: localDate(),
        target: 5,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 3,
        expectedSubmitters: ['体验提交人A'],
        materials: [{ id: 'mat_demo', name: '演示材料', required: true, description: '' }],
      },
    })
    assert.equal(demoColRes.statusCode, 200, demoColRes.body)
    const demoCol = demoColRes
      .json()
      .collections.find((c: { title: string }) => c.title === '访客体验任务') as {
      id: string
      uploadToken?: string
      expectedSubmitters?: string[]
      createdByDemo?: boolean
      materialRevision: string
    }
    assert.equal(demoCol.createdByDemo, true)
    assert.ok(demoCol.uploadToken, '体验账号应能获取自己新建任务的分享令牌以测试提交')
    assert.deepEqual(demoCol.expectedSubmitters, ['体验提交人A'])

    // 尝试 PATCH 开启体验任务的 deadlineReminder -> 403
    const badPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/collections/${demoCol.id}`,
      headers: demoHeaders,
      payload: {
        title: '访客体验任务',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: localDate(),
        target: 5,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 3,
        deadlineReminder: { enabled: true, hoursBefore: 24, desensitizeNames: true },
      },
    })
    assert.equal(badPatch.statusCode, 403)

    // 克隆管理员任务 -> 强制剥离管理员应交名单与 deadlineReminder 开关，且新副本标记为 createdByDemo
    const clonedRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${adminCol.id}/clone`,
      headers: demoHeaders,
      payload: { title: '克隆管理员任务副本', includeExpectedSubmitters: true },
    })
    assert.equal(clonedRes.statusCode, 201, clonedRes.body)
    const clonedCol = clonedRes.json().collection as {
      id: string
      createdByDemo?: boolean
      expectedSubmitters?: string[]
      deadlineReminder?: { enabled: boolean }
    }
    assert.equal(clonedCol.createdByDemo, true)
    assert.deepEqual(clonedCol.expectedSubmitters, [])
    assert.equal(clonedCol.deadlineReminder?.enabled, false)

    // 6. 后端敏感数据隔离校验：summary 剥离非体验任务敏感字段，full 剥离全部敏感字段，且独立 ETag 不串扰真实编辑者
    const demoSummaryRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace?mode=summary',
      headers: demoHeaders,
    })
    assert.equal(demoSummaryRes.statusCode, 200)
    const demoSummaryCols = demoSummaryRes.json().collections as {
      id: string
      uploadToken?: string
      expectedSubmitters?: string[]
    }[]
    const adminInDemoSummary = demoSummaryCols.find((c) => c.id === adminCol.id)!
    const demoInDemoSummary = demoSummaryCols.find((c) => c.id === demoCol.id)!
    assert.equal(
      adminInDemoSummary.uploadToken,
      undefined,
      '体验视图严禁泄露管理员任务 uploadToken',
    )
    assert.equal(
      adminInDemoSummary.expectedSubmitters,
      undefined,
      '体验视图严禁泄露管理员任务 expectedSubmitters',
    )
    assert.equal(demoInDemoSummary.uploadToken, demoCol.uploadToken)
    assert.deepEqual(demoInDemoSummary.expectedSubmitters, ['体验提交人A'])

    // ?mode=full 严格脱敏全部集合的 uploadToken 与 expectedSubmitters（与前端导出口径一致）
    const demoFullRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace?mode=full',
      headers: demoHeaders,
    })
    assert.equal(demoFullRes.statusCode, 200)
    assert.equal(demoFullRes.body.includes(adminCol.uploadToken), false)
    assert.equal(demoFullRes.body.includes(demoCol.uploadToken!), false)
    assert.equal(demoFullRes.body.includes('机密人员甲'), false)
    assert.equal(demoFullRes.body.includes('体验提交人A'), false)

    // 真实非体验 editor 请求同一接口 ETag 不同，仍能正常看到非体验任务的令牌与名单
    const realEdRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace?mode=summary',
      headers: {
        ...realEditorHeaders,
        'if-none-match': String(demoSummaryRes.headers.etag || ''),
      },
    })
    assert.equal(realEdRes.statusCode, 200, '真实编辑者不得命中体验用户的 ETag 缓存')
    const adminInRealEd = (
      realEdRes.json().collections as {
        id: string
        uploadToken?: string
        expectedSubmitters?: string[]
      }[]
    ).find((c) => c.id === adminCol.id)!
    assert.equal(adminInRealEd.uploadToken, adminCol.uploadToken)
    assert.deepEqual(adminInRealEd.expectedSubmitters, ['机密人员甲', '机密人员乙'])

    // 参与人、材料矩阵、材料台账导出接口对管理员任务均不得泄露 expectedSubmitters
    for (const url of [
      `/api/collections/${adminCol.id}/participants`,
      `/api/collections/${adminCol.id}/materials`,
      `/api/collections/${adminCol.id}/materials/export?revision=${encodeURIComponent(adminCol.materialRevision)}`,
    ]) {
      const r = await ctx.app.inject({ method: 'GET', url, headers: demoHeaders })
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`)
      assert.equal(r.body.includes('机密人员甲'), false, `${url} 不得泄露管理员应交名单`)
      assert.equal(r.body.includes('机密人员乙'), false, `${url} 不得泄露管理员应交名单`)
    }

    // 体验账号禁止修改、归档、改状态或轮换管理员任务的收集链接
    for (const call of [
      {
        method: 'PATCH' as const,
        url: `/api/collections/${adminCol.id}`,
        payload: {
          title: '篡改',
          description: '',
          category: 'document',
          formats: 'TXT',
          deadline: '2099-12-31',
          target: 1,
          maxFileSizeMB: 1,
          maxFilesPerSubmission: 1,
        },
      },
      {
        method: 'POST' as const,
        url: `/api/collections/${adminCol.id}/status`,
        payload: { status: 'paused' },
      },
      {
        method: 'POST' as const,
        url: `/api/collections/${adminCol.id}/archive`,
        payload: { archived: true },
      },
      {
        method: 'POST' as const,
        url: `/api/collections/${adminCol.id}/rotate-token`,
        payload: {},
      },
    ]) {
      const r = await ctx.app.inject({
        method: call.method,
        url: call.url,
        headers: demoHeaders,
        payload: call.payload,
      })
      assert.equal(r.statusCode, 403, `${call.method} ${call.url} 应拦截体验号篡改管理员任务`)
    }

    // 7. Webhook 绕过路径 2（submission.created）：公开分片上传到体验任务必须静音
    const uploadId = randomUUID()
    const uploadKey = 'a'.repeat(40)
    const fileBuf = Buffer.from('体验公开提交测试内容')
    const fileSha = createHash('sha256').update(fileBuf).digest('hex')
    const createUp = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/${demoCol.uploadToken}/uploads/${uploadId}`,
      headers: { ...ctx.origin, 'x-upload-key': uploadKey },
      payload: {
        owner: '访客提交者',
        files: [{ name: 'demo.txt', size: fileBuf.length, lastModified: Date.now() }],
        materialIds: ['mat_demo'],
      },
    })
    assert.equal(createUp.statusCode, 200, createUp.body)
    const putPart = await ctx.app.inject({
      method: 'PUT',
      url: `/api/public/${demoCol.uploadToken}/uploads/${uploadId}/0/0`,
      headers: {
        ...ctx.origin,
        'x-upload-key': uploadKey,
        'content-type': 'application/octet-stream',
        'x-chunk-sha256': fileSha,
      },
      payload: fileBuf,
    })
    assert.equal(putPart.statusCode, 200, putPart.body)
    const completeUp = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/${demoCol.uploadToken}/uploads/${uploadId}/complete`,
      headers: { ...ctx.origin, 'x-upload-key': uploadKey },
      payload: {},
    })
    assert.equal(completeUp.statusCode, 201, completeUp.body)
    await ctx.webhooks.flushPending()
    assert.equal(webhookHits.length, 0, '体验任务收到公开提交不得外发真实管理员 Webhook')

    // 8. Webhook 绕过路径 1（review.accepted / review.needs_changes）：体验用户审核材料必须静音
    const demoFiles = ctx.store.collectionFiles(demoCol.id, false)
    assert.equal(demoFiles.length, 1)
    const demoFile = demoFiles[0]
    const reviewDemo = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials/review',
      headers: demoHeaders,
      payload: {
        collectionId: demoCol.id,
        rulesRevision: demoCol.materialRevision,
        requestId: randomUUID(),
        files: [{ id: demoFile.id, expectedVersion: materialStateVersion(demoFile) }],
        decision: 'accepted',
        note: '体验审阅通过',
      },
    })
    assert.equal(reviewDemo.statusCode, 200, reviewDemo.body)
    // 同时校验体验号对管理员任务的材料审阅也会被静音且返回体不泄露管理员任务令牌
    const adminFileKey = randomUUID()
    const adminFileBuf = Buffer.from('admin-doc')
    await writeFile(join(ctx.config.dataDir, 'objects', adminFileKey), adminFileBuf)
    const adminFile: CollectedFile = {
      id: randomUUID(),
      name: 'admin.txt',
      size: adminFileBuf.length,
      collectionId: adminCol.id,
      owner: '甲',
      createdAt: new Date().toISOString(),
      storage: 'local',
      status: 'pending',
      sha256: createHash('sha256').update(adminFileBuf).digest('hex'),
      materialId: 'mat_1',
      materialVersion: 1,
    }
    ctx.store.addFile(adminFile, adminFileKey)
    const reviewAdminByDemo = await ctx.app.inject({
      method: 'POST',
      url: '/api/materials/review',
      headers: demoHeaders,
      payload: {
        collectionId: adminCol.id,
        rulesRevision: adminCol.materialRevision,
        requestId: randomUUID(),
        files: [{ id: adminFile.id, expectedVersion: materialStateVersion(adminFile) }],
        decision: 'needs_changes',
        note: '测试退回',
      },
    })
    assert.equal(reviewAdminByDemo.statusCode, 200, reviewAdminByDemo.body)
    assert.equal(
      reviewAdminByDemo.body.includes(adminCol.uploadToken),
      false,
      'materials/review 返回体不得向体验号泄露管理员任务 uploadToken',
    )
    await ctx.webhooks.flushPending()
    assert.equal(webhookHits.length, 0, '体验用户审核材料不得外发真实管理员 Webhook')

    // 9. Webhook 绕过路径 3 纵深防御：即使数据库中体验任务被强行标成开启预警，checkDeadlines 也一律跳过
    const rawDemo = ctx.store.collection(demoCol.id)!
    ctx.store.saveCollection({
      ...rawDemo,
      deadlineReminder: { enabled: true, hoursBefore: 24, desensitizeNames: true },
    })
    const emittedCount = ctx.webhooks.checkDeadlines(false)
    assert.equal(emittedCount, 1, '仅应触发 1 个管理员任务，体验任务必须被忽略')
    await ctx.webhooks.flushPending()
    assert.equal(webhookHits.length, 1)
    assert.equal(webhookHits[0].event, 'collection.deadline_soon')
    assert.ok(webhookHits[0].body.includes('管理员私密收集'))
    assert.equal(webhookHits[0].body.includes('访客体验任务'), false)

    // 10. 关闭 JIYU_DEMO_ENABLED 重启后：旧体验 Cookie 立即失效（401），管理员会话继续有效（200）
    await ctx.app.close()
    const restarted = await createApp({ ...ctx.config, demo: undefined }, { serveFrontend: false })
    try {
      const remainingDemoSessions = restarted.store.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE is_demo=1')
        .get() as { n: number }
      assert.equal(remainingDemoSessions.n, 0, '关闭体验模式重启后必须立即清理全部 is_demo=1 会话')

      const oldDemoStatus = await restarted.app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: { cookie: demoHeaders.cookie },
      })
      assert.equal(oldDemoStatus.statusCode, 200)
      assert.equal(oldDemoStatus.json().authenticated, false)
      assert.equal(oldDemoStatus.json().demoEnabled, false)

      const oldDemoWs = await restarted.app.inject({
        method: 'GET',
        url: '/api/workspace',
        headers: demoHeaders,
      })
      assert.equal(oldDemoWs.statusCode, 401, '关闭体验模式后旧体验 Cookie 必须立即失效')

      const adminStillValid = await restarted.app.inject({
        method: 'GET',
        url: '/api/workspace',
        headers: ctx.adminHeaders,
      })
      assert.equal(adminStillValid.statusCode, 200, '管理员正常会话不受体验会话吊销影响')
    } finally {
      await restarted.app.close()
    }
  } finally {
    await ctx.app.close().catch(() => {})
    if (!relative(ctx.root, ctx.dir).startsWith('..'))
      await rm(ctx.dir, { recursive: true, force: true })
  }
})
