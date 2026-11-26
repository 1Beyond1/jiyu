import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createApp } from './app.ts'
import { isPublicAddress } from './ai.ts'
import { createBackup, restoreBackup } from './backup.ts'
import type { Config } from './config.ts'
import type { RemoteHTTP, RemoteRequest } from './remote-http.ts'
import {
  buildWebhookRequest,
  maskWebhookUrl,
  sanitizeWebhookError,
  sanitizeWebhookMarkdown,
  sanitizeWebhookPlainText,
  validateWebhookUrl,
} from './webhooks.ts'
import { localDate } from '../src/lib/collections.ts'
import type { WebhookState } from '../src/types.ts'

async function* bufStream(text: string): AsyncIterable<Buffer> {
  yield Buffer.from(text, 'utf8')
}

test('Webhook 4 渠道签名/报文格式（飞书、钉钉 HMAC-SHA256、企业微信、通用 HMAC）与 SSRF/脱敏校验', () => {
  const nowMs = 1763800000123
  const payload = {
    deliveryId: 'del-001',
    event: 'submission.created' as const,
    collectionId: 'col-1',
    collectionTitle: '毕业设计材料',
    mergedCount: 2,
    summary: '收到 2 次提交',
    items: [{ actor: '张三', summary: '张三提交了 1 份文件', at: '2026-11-22T09:00:00.000Z' }],
  }

  // 1. 飞书签名（HMAC key = "${sec}\n${secret}", data = ""）
  const feishu = buildWebhookRequest(
    'feishu',
    'https://open.feishu.cn/open-apis/bot/v2/hook/secret-hook-token',
    'feishu-sec-123',
    payload,
    nowMs,
  )
  const feishuBody = JSON.parse(feishu.body.toString('utf8')) as Record<string, unknown>
  assert.equal(feishuBody.msg_type, 'text')
  const expectedFeishuTs = String(Math.floor(nowMs / 1000))
  assert.equal(feishuBody.timestamp, expectedFeishuTs)
  assert.equal(
    feishuBody.sign,
    createHmac('sha256', `${expectedFeishuTs}\nfeishu-sec-123`).digest('base64'),
  )

  // 2. 钉钉加签（query timestamp=ms, sign=base64(HMAC(secret, "${ms}\n${secret}"))）
  const ding = buildWebhookRequest(
    'dingtalk',
    'https://oapi.dingtalk.com/robot/send?access_token=ding-tok',
    'SECding123',
    payload,
    nowMs,
  )
  assert.equal(ding.url.searchParams.get('timestamp'), String(nowMs))
  assert.equal(
    ding.url.searchParams.get('sign'),
    createHmac('sha256', 'SECding123').update(`${nowMs}\nSECding123`).digest('base64'),
  )
  const dingBody = JSON.parse(ding.body.toString('utf8')) as {
    msgtype: string
    markdown: { title: string; text: string }
  }
  assert.equal(dingBody.msgtype, 'markdown')
  assert.ok(dingBody.markdown.text.includes('毕业设计材料'))

  // 3. 企业微信 markdown
  const wecom = buildWebhookRequest(
    'wecom',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-key',
    undefined,
    payload,
    nowMs,
  )
  const wecomBody = JSON.parse(wecom.body.toString('utf8')) as {
    msgtype: string
    markdown: { content: string }
  }
  assert.equal(wecomBody.msgtype, 'markdown')
  assert.ok(wecomBody.markdown.content.includes('收到 2 次提交'))

  // 4. 通用 HMAC Webhook（X-Jiyu-Signature: sha256=...）
  const generic = buildWebhookRequest(
    'generic',
    'https://hooks.example.com/jiyu',
    'generic-secret-xyz',
    payload,
    nowMs,
  )
  const genericRaw = generic.body.toString('utf8')
  const expectedSig = createHmac('sha256', 'generic-secret-xyz')
    .update(`${generic.headers['X-Jiyu-Timestamp']}.${genericRaw}`)
    .digest('hex')
  assert.equal(generic.headers['X-Jiyu-Event'], 'submission.created')
  assert.equal(generic.headers['X-Jiyu-Delivery'], 'del-001')
  assert.equal(generic.headers['X-Jiyu-Signature'], `sha256=${expectedSig}`)

  // 5. SSRF 拦截与 URL/报错脱敏
  assert.equal(
    maskWebhookUrl(new URL('https://open.feishu.cn/open-apis/bot/v2/hook/top-secret-token')),
    'https://open.feishu.cn/•••',
  )
  assert.throws(() => validateWebhookUrl('http://open.feishu.cn/hook/abc'), /HTTPS/)
  assert.throws(() => validateWebhookUrl('https://open.feishu.cn:8443/hook/abc'), /443/)
  assert.throws(() => validateWebhookUrl('https://user:pass@open.feishu.cn/hook/abc'), /HTTPS/)
  assert.throws(() => validateWebhookUrl('https://localhost/hook'), /本机或内网/)
  assert.throws(() => validateWebhookUrl('https://localhost./hook'), /本机或内网/)
  assert.throws(() => validateWebhookUrl('https://sub.localhost./hook'), /本机或内网/)
  assert.throws(() => validateWebhookUrl('https://127.0.0.1/hook'), /内网或保留/)
  assert.throws(() => validateWebhookUrl('https://10.0.0.5/hook'), /内网或保留/)
  assert.throws(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data'), /内网或保留/)
  assert.throws(() => validateWebhookUrl('https://[::1]/hook'), /内网或保留/)

  // P2 防御纵深：IPv6 全局单播必须精确匹配 2000::/3（拒绝 2::1 / 30::1 / 200::1 等非 0x2000..0x3fff 地址）
  assert.equal(isPublicAddress('2::1'), false)
  assert.equal(isPublicAddress('30::1'), false)
  assert.equal(isPublicAddress('200::1'), false)
  assert.equal(isPublicAddress('3ff::1'), false)
  assert.equal(isPublicAddress('2001:db8::1'), false)
  assert.equal(isPublicAddress('2001::1'), false)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  assert.equal(isPublicAddress('2400:3200::1'), true)

  const sanitized = sanitizeWebhookError(
    new Error(
      'failed https://oapi.dingtalk.com/robot/send?access_token=mySecret&sign=xyz api_key=abc123 bot_token=bot999 Authorization: Bearer eyJhbGciOi.secret',
    ),
  )
  assert.equal(sanitized.includes('mySecret'), false)
  assert.equal(sanitized.includes('oapi.dingtalk.com'), false)
  assert.equal(sanitized.includes('abc123'), false)
  assert.equal(sanitized.includes('bot999'), false)
  assert.equal(sanitized.includes('eyJhbGciOi'), false)

  // P1-2 注入防护：剥离/转义飞书 <at>、企微 <@all>、Markdown 钓鱼链接与换行控制符
  const maliciousPayload = {
    deliveryId: 'del-inject',
    event: 'submission.created' as const,
    collectionId: 'col-x',
    collectionTitle: '测试任务\r\n### 伪造公告',
    mergedCount: 1,
    summary:
      '<at user_id="all">所有人</at> <<at user_id="all">> <@all> [点我领奖](https://evil.test/p) 提交了文件',
    items: [
      {
        actor: '<@all>',
        summary: '![track](https://evil.test/px.png)\n> 伪造引用',
        detail: '备注：[立即登录](https://phish.test)',
        at: '2026-11-22T09:00:00.000Z',
      },
    ],
  }
  const feishuInject = JSON.parse(
    buildWebhookRequest(
      'feishu',
      'https://open.feishu.cn/hook/1',
      undefined,
      maliciousPayload,
      nowMs,
    ).body.toString('utf8'),
  ) as { content: { text: string } }
  assert.equal(feishuInject.content.text.includes('<at'), false, '飞书不得包含 <at 标签')
  assert.equal(feishuInject.content.text.includes('<@all'), false, '飞书不得包含 <@all')
  assert.equal(feishuInject.content.text.includes('[点我领奖]('), false)
  assert.equal(feishuInject.content.text.includes('\n### 伪造公告'), false)

  const dingInject = JSON.parse(
    buildWebhookRequest(
      'dingtalk',
      'https://oapi.dingtalk.com/robot/send?access_token=t',
      undefined,
      maliciousPayload,
      nowMs,
    ).body.toString('utf8'),
  ) as { markdown: { title: string; text: string } }
  assert.equal(dingInject.markdown.text.includes('<at'), false)
  assert.equal(dingInject.markdown.text.includes('<@all'), false)
  assert.equal(dingInject.markdown.text.includes('[点我领奖]('), false)
  assert.equal(dingInject.markdown.text.includes('![track]('), false)
  assert.equal(dingInject.markdown.text.includes('\n### 伪造公告'), false)

  const wecomInject = JSON.parse(
    buildWebhookRequest(
      'wecom',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      undefined,
      maliciousPayload,
      nowMs,
    ).body.toString('utf8'),
  ) as { markdown: { content: string } }
  assert.equal(wecomInject.markdown.content.includes('<@all'), false)
  assert.equal(wecomInject.markdown.content.includes('[立即登录]('), false)
  assert.equal(sanitizeWebhookPlainText('a\r\nb<@all>'), 'a b')
  assert.equal(sanitizeWebhookMarkdown('[x](y)'), 'x（y）')
})

test('Webhook 密文落库、角色隔离、同任务聚合防刷屏、异步重试、50 条脱敏日志上限、测试接口与临近截止推送', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'webhooks-e2e-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 20 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }

  const received: { url: string; headers: Record<string, string>; body: string }[] = []
  let failNextCount = 0
  const mockHttp: RemoteHTTP = async (req: RemoteRequest) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    received.push({
      url: req.url.toString(),
      headers: req.headers || {},
      body,
    })
    if (failNextCount > 0) {
      failNextCount--
      return {
        status: 503,
        headers: {},
        body: bufStream('{"error":"temporary"}'),
      }
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: bufStream('{"code":0,"errcode":0}'),
    }
  }

  const { app, store, webhooks } = await createApp(config, {
    serveFrontend: false,
    webhookPolicy: {
      http: mockHttp,
      debounceMs: 60,
      retryBaseMs: 15,
      maxAttempts: 3,
      deadlineIntervalMs: 60 * 60 * 1000,
    },
  })

  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: config.origin },
      payload: {
        setupToken: store.setupToken(),
        displayName: '通知管理员',
        password: 'AdminPassword123!',
      },
    })
    const adminCookie = String(setup.headers['set-cookie']).split(';')[0]
    const adminCsrf = setup.json().csrf as string
    const adminHeaders = { origin: config.origin, cookie: adminCookie, 'x-csrf-token': adminCsrf }

    // 创建编辑者账号确认非管理员无权访问 Webhook API
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: adminHeaders,
      payload: {
        username: 'editor1',
        displayName: '普通编辑',
        password: 'EditorPassword123!',
        role: 'editor',
      },
    })
    const edLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { username: 'editor1', password: 'EditorPassword123!' },
    })
    const editorCookie = String(edLogin.headers['set-cookie']).split(';')[0]
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/webhooks', headers: { cookie: editorCookie } }))
        .statusCode,
      403,
    )

    // 1. 新增通用 HMAC Webhook 渠道
    const secretUrl = 'https://hooks.example.com/super-secret-path-token-999'
    const secretKey = 'hmac-secret-value-888'
    const createdCh = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: adminHeaders,
      payload: {
        name: '教务告警群',
        type: 'generic',
        url: secretUrl,
        secret: secretKey,
        events: [
          'submission.created',
          'review.accepted',
          'review.needs_changes',
          'collection.deadline_soon',
        ],
        debounceSeconds: 60,
        enabled: true,
      },
    })
    assert.equal(createdCh.statusCode, 201, createdCh.body)
    const channelId = createdCh.json().channel.id as string

    // 校验数据库密文存储 & API 绝不回传明文 URL 或密钥
    const rawSetting = store.get('webhooks.config') || ''
    assert.equal(rawSetting.includes('super-secret-path-token-999'), false)
    assert.equal(rawSetting.includes(secretKey), false)

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/webhooks',
      headers: { cookie: adminCookie },
    })
    assert.equal(listRes.statusCode, 200)
    assert.equal(listRes.body.includes('super-secret-path-token-999'), false)
    assert.equal(listRes.body.includes(secretKey), false)
    const state = listRes.json() as WebhookState
    assert.equal(state.channels.length, 1)
    assert.equal(state.channels[0].urlHint, 'https://hooks.example.com/•••')
    assert.equal(state.channels[0].hasSecret, true)

    // 2. 管理员测试通知接口
    const testRes = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${channelId}/test`,
      headers: adminHeaders,
      payload: {},
    })
    assert.equal(testRes.statusCode, 200, testRes.body)
    assert.equal(testRes.json().ok, true)
    assert.equal(received.length, 1)
    assert.equal(received[0].headers['X-Jiyu-Event'], 'test')
    assert.ok(received[0].headers['X-Jiyu-Signature']?.startsWith('sha256='))

    // 3. 同任务聚合防刷屏：连续触发 3 次同任务新提交，仅发出 1 条合并消息（mergedCount=3）
    received.length = 0
    webhooks.emit({
      event: 'submission.created',
      collectionId: 'task-1',
      collectionTitle: '作业一',
      actor: '张三',
      fileCount: 1,
      summary: '张三提交了 1 份文件',
    })
    webhooks.emit({
      event: 'submission.created',
      collectionId: 'task-1',
      collectionTitle: '作业一',
      actor: '李四',
      fileCount: 2,
      summary: '李四提交了 2 份文件',
    })
    webhooks.emit({
      event: 'submission.created',
      collectionId: 'task-1',
      collectionTitle: '作业一',
      actor: '王五',
      fileCount: 1,
      summary: '王五提交了 1 份文件',
    })
    await webhooks.flushPending()
    assert.equal(received.length, 1, '同任务聚合窗口内 3 次事件应合并为 1 次推送')
    const mergedPayload = JSON.parse(received[0].body) as { mergedCount: number; summary: string }
    assert.equal(mergedPayload.mergedCount, 3)
    assert.match(mergedPayload.summary, /3 次提交/)

    // 4. 异步重试队列：前 2 次返回 HTTP 503，第 3 次成功
    received.length = 0
    failNextCount = 2
    webhooks.emit({
      event: 'review.needs_changes',
      collectionId: 'task-1',
      collectionTitle: '作业一',
      actor: '通知管理员',
      summary: '标记 1 份文件需补充',
    })
    await webhooks.flushPending()
    assert.equal(received.length, 3, '503 应自动重试并在第 3 次成功')
    const afterRetry = (
      await app.inject({ method: 'GET', url: '/api/webhooks', headers: { cookie: adminCookie } })
    ).json() as WebhookState
    assert.equal(afterRetry.logs[0].status, 'succeeded')
    assert.equal(afterRetry.logs[0].attempts, 3)

    // 5. 临近截止任务自动检测（今日截止）
    received.length = 0
    store.saveCollection({
      id: randomUUID(),
      title: '今日截止任务',
      description: '',
      category: 'document',
      received: 3,
      target: 10,
      deadline: localDate(),
      storage: 'local',
      status: 'active',
      formats: 'PDF',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 5,
    })
    const emittedDeadlines = webhooks.checkDeadlines(false)
    assert.equal(emittedDeadlines, 1)
    assert.equal(webhooks.checkDeadlines(false), 0, '同截止日不得重复提醒')
    await webhooks.flushPending()
    assert.equal(received.length, 1)
    assert.equal(received[0].headers['X-Jiyu-Event'], 'collection.deadline_soon')

    // 6. 日志上限 50 条截断验证
    for (let i = 0; i < 55; i++) {
      webhooks.emit({
        event: 'review.accepted',
        collectionId: `c-${i}`,
        collectionTitle: `任务${i}`,
        summary: `通过 #${i}`,
      })
      await webhooks.flushPending()
    }
    const capped = (
      await app.inject({ method: 'GET', url: '/api/webhooks', headers: { cookie: adminCookie } })
    ).json() as WebhookState
    assert.equal(capped.logs.length, 50, '投递日志应只保留最近 50 条')

    // 7. 备份恢复验证：含加密 Webhook 凭证时 secrets.key 随备份完整迁移
    await app.close()
    const backupDir = join(dir, 'bk')
    const restoredDir = join(dir, 'restored')
    await createBackup(config.dataDir, backupDir)
    await restoreBackup(backupDir, restoredDir)
    const reopened = await createApp(
      { ...config, dataDir: restoredDir },
      { serveFrontend: false, webhookPolicy: { http: mockHttp } },
    )
    try {
      const loginAgain = await reopened.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: config.origin },
        payload: { username: 'admin', password: 'AdminPassword123!' },
      })
      const restoredCookie = String(loginAgain.headers['set-cookie']).split(';')[0]
      const restoredCsrf = loginAgain.json().csrf as string
      const restoredTest = await reopened.app.inject({
        method: 'POST',
        url: `/api/webhooks/${channelId}/test`,
        headers: { origin: config.origin, cookie: restoredCookie, 'x-csrf-token': restoredCsrf },
        payload: {},
      })
      assert.equal(restoredTest.statusCode, 200, '备份恢复后加密的 Webhook 凭证应可正常解密投递')
    } finally {
      await reopened.app.close()
    }
  } finally {
    await app.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('Webhook 加固：PATCH 换 URL/类型清空旧密钥、逐渠道解密探测、渠道并发隔离、队列超限脱敏日志、退订清理与截止失败可重试', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'webhooks-hardening-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 20 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }

  let slowBlocked = true
  let releaseSlow: () => void = () => {}
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = () => {
      slowBlocked = false
      resolve()
    }
  })
  let onSlowStarted: (() => void) | null = null
  let failDeadlineEndpoint = false
  const hits: { url: string; headers: Record<string, string>; event: string }[] = []

  const mockHttp: RemoteHTTP = async (req: RemoteRequest) => {
    const urlStr = req.url.toString()
    const event = String(req.headers?.['X-Jiyu-Event'] || '')
    hits.push({ url: urlStr, headers: req.headers || {}, event })
    if (urlStr.includes('slow.example.com') && slowBlocked) {
      onSlowStarted?.()
      await Promise.race([
        slowGate,
        new Promise<void>((resolve) => {
          req.signal?.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
      return { status: 200, headers: {}, body: bufStream('{"ok":true}') }
    }
    if (failDeadlineEndpoint && event === 'collection.deadline_soon') {
      return { status: 500, headers: {}, body: bufStream('{"error":"down"}') }
    }
    return { status: 200, headers: {}, body: bufStream('{"code":0,"errcode":0}') }
  }

  const { app, store, webhooks } = await createApp(config, {
    serveFrontend: false,
    webhookPolicy: {
      http: mockHttp,
      debounceMs: 15,
      retryBaseMs: 10,
      maxAttempts: 2,
      maxQueuePerChannel: 2,
      deadlineIntervalMs: 60 * 60 * 1000,
    },
  })

  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: config.origin },
      payload: {
        setupToken: store.setupToken(),
        displayName: '安全管理员',
        password: 'AdminPassword123!',
      },
    })
    const adminCookie = String(setup.headers['set-cookie']).split(';')[0]
    const adminCsrf = setup.json().csrf as string
    const adminHeaders = { origin: config.origin, cookie: adminCookie, 'x-csrf-token': adminCsrf }

    // 1. P1-3: PATCH 更换 URL 或 type 未提供新 secret 时必须强制清空旧加签密钥
    const ch1Res = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: adminHeaders,
      payload: {
        name: '快速渠道',
        type: 'generic',
        url: 'https://fast.example.com/hook-1',
        secret: 'old-secret-must-not-leak',
        events: ['submission.created', 'review.accepted', 'collection.deadline_soon'],
      },
    })
    assert.equal(ch1Res.statusCode, 201, ch1Res.body)
    const ch1Id = ch1Res.json().channel.id as string
    assert.equal(ch1Res.json().channel.hasSecret, true)

    // 仅更换 URL 不传 secret -> hasSecret 必须变为 false 且请求不带签名头
    const patchUrl = await app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${ch1Id}`,
      headers: adminHeaders,
      payload: { url: 'https://fast.example.com/hook-2' },
    })
    assert.equal(patchUrl.statusCode, 200, patchUrl.body)
    assert.equal(patchUrl.json().channel.hasSecret, false, '换 URL 必须清空旧加签密钥')

    hits.length = 0
    await app.inject({
      method: 'POST',
      url: `/api/webhooks/${ch1Id}/test`,
      headers: adminHeaders,
      payload: {},
    })
    assert.equal(hits[0].headers['X-Jiyu-Signature'], undefined, '换 URL 后不得复用旧密钥签名')

    // 重新配置密钥后，更换平台类型 type -> hasSecret 也必须清空
    await app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${ch1Id}`,
      headers: adminHeaders,
      payload: { secret: 'secret-before-type-change' },
    })
    const patchType = await app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${ch1Id}`,
      headers: adminHeaders,
      payload: { type: 'feishu' },
    })
    assert.equal(patchType.statusCode, 200)
    assert.equal(patchType.json().channel.hasSecret, false, '换平台类型必须清空旧加签密钥')
    // 恢复回 generic 以便后续检验请求头
    await app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${ch1Id}`,
      headers: adminHeaders,
      payload: { type: 'generic' },
    })

    // 2. P1-4: PATCH 退订事件时清理 pending 且不投递已退订事件
    hits.length = 0
    webhooks.emit({
      event: 'review.accepted',
      collectionId: 'col-unsub',
      collectionTitle: '退订验证任务',
      summary: '审核通过 1 份',
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${ch1Id}`,
      headers: adminHeaders,
      payload: { events: ['submission.created', 'collection.deadline_soon'] },
    })
    await webhooks.flushPending()
    assert.equal(hits.length, 0, '退订 review.accepted 后待发队列不得继续投递')

    // 3. P1-4: checkDeadlines 失败时不持久化 deadlineNotified，恢复后允许重试且成功后去重
    store.saveCollection({
      id: randomUUID(),
      title: '截止重试任务',
      description: '',
      category: 'document',
      received: 1,
      target: 5,
      deadline: localDate(),
      storage: 'local',
      status: 'active',
      formats: 'PDF',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 5,
    })
    failDeadlineEndpoint = true
    assert.equal(webhooks.checkDeadlines(false), 1)
    assert.equal(webhooks.checkDeadlines(false), 0, '投递中不得重复入队')
    await webhooks.flushPending()
    assert.equal(store.get('webhooks.deadlineNotified'), undefined, '投递失败不得持久化已提醒标记')

    failDeadlineEndpoint = false
    hits.length = 0
    assert.equal(webhooks.checkDeadlines(false), 1, '失败后下轮扫描应允许重新提醒')
    await webhooks.flushPending()
    assert.equal(hits.filter((h) => h.event === 'collection.deadline_soon').length, 1)
    assert.equal(webhooks.checkDeadlines(false), 0, '投递成功后同截止日不得重复提醒')

    // 4. P1-4: 按渠道隔离队列（慢渠道绝不阻塞健康渠道）+ 单渠道超限丢弃记脱敏日志
    const slowChRes = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: adminHeaders,
      payload: {
        name: '慢速渠道',
        type: 'generic',
        url: 'https://slow.example.com/secret-slow-path',
        events: ['submission.created'],
      },
    })
    assert.equal(slowChRes.statusCode, 201)

    hits.length = 0
    const slowHitPromise = new Promise<void>((resolve) => {
      onSlowStarted = resolve
    })
    webhooks.emit({
      event: 'submission.created',
      collectionId: 'iso-1',
      collectionTitle: '隔离测试1',
      summary: '提交 #1',
    })
    // 立刻触发慢渠道进入投递态，同时让快速渠道独立完成
    await new Promise((r) => setTimeout(r, 40))
    await slowHitPromise
    assert.ok(
      hits.some((h) => h.url.includes('fast.example.com')),
      '健康渠道必须在慢渠道阻塞期间独立完成投递',
    )

    // 慢渠道仍在阻塞中，继续向慢渠道快速灌入 4 个不同任务触发 maxQueuePerChannel=2 溢出
    for (let i = 2; i <= 5; i++) {
      webhooks.emit({
        event: 'submission.created',
        collectionId: `iso-${i}`,
        collectionTitle: `隔离测试${i}`,
        summary: `提交 #${i}`,
      })
    }
    await new Promise((r) => setTimeout(r, 45))
    releaseSlow()
    await webhooks.flushPending()

    const afterOverflow = (
      await app.inject({ method: 'GET', url: '/api/webhooks', headers: { cookie: adminCookie } })
    ).json() as WebhookState
    const overflowLog = afterOverflow.logs.find(
      (l) => l.status === 'failed' && l.error?.includes('待投递队列已满'),
    )
    assert.ok(overflowLog, '队列超限丢弃须记录脱敏失败日志')
    assert.equal(overflowLog.targetHint.includes('secret-slow-path'), false)

    // 5. P1-3: secrets.key 替换（仍为 32 字节但无法解密旧密文）时逐条探测返回 keyReady=false
    await writeFile(join(config.dataDir, 'secrets.key'), randomBytes(32), { mode: 0o600 })
    const brokenState = (
      await app.inject({ method: 'GET', url: '/api/webhooks', headers: { cookie: adminCookie } })
    ).json() as WebhookState
    assert.equal(
      brokenState.channels.every((c) => c.keyReady === false),
      true,
      '密钥替换导致无法解密时，即使 secrets.key 仍为 32 字节也须返回 keyReady: false',
    )
    // 重新填写新地址后该渠道独立恢复为 keyReady: true，另一条损坏渠道仍为 false
    const repaired = await app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${ch1Id}`,
      headers: adminHeaders,
      payload: { url: 'https://fast.example.com/recovered-hook' },
    })
    assert.equal(repaired.statusCode, 200)
    assert.equal(repaired.json().channel.keyReady, true)
    const mixedState = (
      await app.inject({ method: 'GET', url: '/api/webhooks', headers: { cookie: adminCookie } })
    ).json() as WebhookState
    assert.equal(mixedState.channels.find((c) => c.id === ch1Id)?.keyReady, true)
    assert.equal(mixedState.channels.find((c) => c.id !== ch1Id)?.keyReady, false)
  } finally {
    await app.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('Webhook inFlightDeadlines 引用计数防过早清除 & deliverNow 透传注入时钟 nowFn()', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'webhooks-refcount-'))
  const fakeNow = Date.parse('2026-11-26T22:00:00+08:00') // 距今日 23:59 剩 2h
  let callIndex = 0
  let releaseFirstStarted!: () => void
  const firstStarted = new Promise<void>((r) => {
    releaseFirstStarted = r
  })
  let releaseFirstDone!: () => void
  const firstGate = new Promise<void>((r) => {
    releaseFirstDone = r
  })
  let releaseSecondStarted!: () => void
  const secondStarted = new Promise<void>((r) => {
    releaseSecondStarted = r
  })
  let releaseSecondDone!: () => void
  const secondGate = new Promise<void>((r) => {
    releaseSecondDone = r
  })
  const seenTimestamps: string[] = []
  const mockHttp: RemoteHTTP = async (req: RemoteRequest) => {
    seenTimestamps.push(String(req.headers?.['X-Jiyu-Timestamp'] || ''))
    const idx = ++callIndex
    if (idx === 1) {
      releaseFirstStarted()
      await firstGate
      return { status: 500, headers: {}, body: bufStream('{"error":"first-fail"}') }
    }
    if (idx === 2) {
      releaseSecondStarted()
      await secondGate
    }
    return { status: 200, headers: {}, body: bufStream('{"ok":true}') }
  }

  const { app, store, webhooks } = await createApp(
    {
      dataDir: join(dir, 'data'),
      origin: 'http://127.0.0.1:3000',
      host: '127.0.0.1',
      port: 0,
      quotaBytes: 8 * 1024 ** 2,
      requestBytes: 2 * 1024 ** 2,
      secureCookie: false,
    },
    {
      serveFrontend: false,
      webhookPolicy: {
        http: mockHttp,
        debounceMs: 5,
        retryBaseMs: 5,
        maxAttempts: 1,
        deadlineIntervalMs: 60 * 60 * 1000,
        now: () => fakeNow,
      },
    },
  )

  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        setupToken: store.setupToken(),
        displayName: '管理员',
        password: 'AdminPassword123!',
      },
    })
    const adminHeaders = {
      origin: 'http://127.0.0.1:3000',
      cookie: String(setup.headers['set-cookie']).split(';')[0],
      'x-csrf-token': setup.json().csrf as string,
    }
    await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: adminHeaders,
      payload: {
        name: '时钟测试渠道',
        type: 'generic',
        url: 'https://clock.example.com/hook',
        events: ['collection.deadline_soon'],
        enabled: true,
      },
    })
    store.saveCollection({
      id: randomUUID(),
      title: '引用计数任务',
      description: '',
      category: 'document',
      received: 0,
      target: 5,
      deadline: '2026-11-26',
      storage: 'local',
      status: 'active',
      formats: 'PDF',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 5,
      deadlineReminder: { enabled: true, hoursBefore: 6, desensitizeNames: true },
    })

    // 触发第 1 次投递并挂起在 HTTP 请求中
    assert.equal(webhooks.checkDeadlines(false), 1)
    await firstStarted

    // 期间手动强制触发第 2 次（force=true），进入 pending/queue，refcount 变为 2
    assert.equal(webhooks.checkDeadlines(true), 1)
    // 放行第 1 次（返回 500 失败）-> refcount 从 2 降为 1，第 2 次开始执行期间仍应阻塞非强制重复入队
    releaseFirstDone()
    await secondStarted
    assert.equal(
      webhooks.checkDeadlines(false),
      0,
      '第 1 次失败退出后第 2 次仍在途，引用计数 > 0 必须继续阻止重复入队',
    )
    releaseSecondDone()
    await webhooks.flushPending()

    // 验证 deliverNow 透传了 fakeNow 到 X-Jiyu-Timestamp 与日志 createdAt
    assert.ok(seenTimestamps.length >= 2)
    for (const ts of seenTimestamps) {
      assert.equal(ts, String(Math.floor(fakeNow / 1000)))
    }
    const state = (
      await app.inject({ method: 'GET', url: '/api/webhooks', headers: adminHeaders })
    ).json() as WebhookState
    assert.equal(state.logs[0].createdAt, new Date(fakeNow).toISOString())
  } finally {
    await app.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})
