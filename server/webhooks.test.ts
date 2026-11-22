import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createApp } from './app.ts'
import { createBackup, restoreBackup } from './backup.ts'
import type { Config } from './config.ts'
import type { RemoteHTTP, RemoteRequest } from './remote-http.ts'
import {
  buildWebhookRequest,
  maskWebhookUrl,
  sanitizeWebhookError,
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
  assert.throws(() => validateWebhookUrl('https://127.0.0.1/hook'), /内网或保留/)
  assert.throws(() => validateWebhookUrl('https://10.0.0.5/hook'), /内网或保留/)
  assert.throws(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data'), /内网或保留/)
  assert.throws(() => validateWebhookUrl('https://[::1]/hook'), /内网或保留/)

  const sanitized = sanitizeWebhookError(
    new Error('failed https://oapi.dingtalk.com/robot/send?access_token=mySecret&sign=xyz'),
  )
  assert.equal(sanitized.includes('mySecret'), false)
  assert.equal(sanitized.includes('oapi.dingtalk.com'), false)
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
