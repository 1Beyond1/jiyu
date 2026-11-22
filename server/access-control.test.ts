import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import type { Config } from './config.ts'

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

async function bootApp(
  unlockPerMinute = 5,
  extraRateLimits?: Partial<NonNullable<Config['rateLimits']>>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'jiyu-access-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 64 * 1024 * 1024,
    requestBytes: 16 * 1024 * 1024,
    secureCookie: false,
    rateLimits: {
      globalPerMinute: 1000,
      unlockPerMinute,
      ...extraRateLimits,
    },
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  const origin = { origin: config.origin }
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: origin,
    payload: {
      setupToken: store.setupToken(),
      password: 'admin-strong-password',
      displayName: '测试发起人',
    },
  })
  assert.equal(setup.statusCode, 200)
  const adminHeaders = {
    ...origin,
    cookie: setup.headers['set-cookie']!.toString().split(';')[0],
    'x-csrf-token': setup.json().csrf as string,
  }
  return { dir, app, store, origin, adminHeaders }
}

test('访问提取码：不升 schema 6、解锁前零泄露、防爆破限流、改码失效与清除恢复', async () => {
  const { dir, app, store, origin, adminHeaders } = await bootApp(3)
  try {
    // 确认 schema 版本仍为 5
    const schema = store.db.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.equal(schema.user_version, 5)

    // 校验短于 4 位或超长提取码被拒绝
    const badCode = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: adminHeaders,
      payload: {
        title: '机密材料收集',
        description: '仅内部人员可见说明',
        category: 'document',
        formats: 'TXT, PDF',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
        accessCode: '123',
      },
    })
    assert.equal(badCode.statusCode, 400)

    // 创建启用提取码 + 材料清单的收集
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: adminHeaders,
      payload: {
        title: '机密材料收集',
        description: '仅内部人员可见说明',
        category: 'document',
        formats: 'TXT, PDF',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
        accessCode: 'Xy98z',
        materials: [
          { id: 'mat_secret', name: '内部审批表', required: true, description: '核心材料说明' },
        ],
      },
    })
    assert.equal(created.statusCode, 200, created.body)
    const c = created.json().collections[0]
    assert.equal(c.hasAccessCode, true)
    assert.equal(c.accessCodeHash, undefined)
    assert.equal(c.accessCodeVersion, undefined)

    // 解锁前 GET /api/public/:token 不泄露任务名称、说明、材料清单或统计数据
    const lockedRes = await app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}` })
    assert.equal(lockedRes.statusCode, 200)
    const lockedJson = lockedRes.json()
    assert.deepEqual(lockedJson, { locked: true })
    assert.ok(!lockedRes.body.includes('机密材料收集'))
    assert.ok(!lockedRes.body.includes('内部审批表'))

    // 未解锁时拒绝分片上传与回执查询
    const blockedUpload = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`,
      headers: { ...origin, 'x-upload-key': 'a'.repeat(48) },
      payload: { owner: '张三', files: [{ name: 'a.txt', size: 4, lastModified: 1 }] },
    })
    assert.equal(blockedUpload.statusCode, 403)

    const blockedReceipt = await app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${randomUUID()}`,
      headers: { 'x-receipt-key': 'a'.repeat(48) },
    })
    assert.equal(blockedReceipt.statusCode, 403)

    // 防爆破限流：连续错误 3 次后第 4 次触发 429
    for (let i = 0; i < 3; i++) {
      const wrong = await app.inject({
        method: 'POST',
        url: `/api/public/${c.uploadToken}/unlock`,
        headers: origin,
        payload: { accessCode: `bad${i}0` },
      })
      assert.equal(wrong.statusCode, 403)
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      headers: origin,
      payload: { accessCode: 'Xy98z' },
    })
    assert.equal(limited.statusCode, 429)

    // 换源 IP 使用正确提取码解锁，返回 Cookie 与完整规则，但仍不暴露敏感字段
    const unlocked = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      remoteAddress: '10.0.0.2',
      headers: origin,
      payload: { accessCode: 'Xy98z' },
    })
    assert.equal(unlocked.statusCode, 200, unlocked.body)
    const unlockBody = unlocked.json()
    assert.equal(unlockBody.unlocked, true)
    assert.equal(unlockBody.accessToken, undefined, '响应体不得返回冗余明文 accessToken')
    assert.equal(unlockBody.collection.title, '机密材料收集')
    assert.equal(unlockBody.collection.materials.length, 1)
    assert.equal(unlockBody.collection.accessCodeHash, undefined)
    const rawSetCookie = unlocked.headers['set-cookie']!.toString()
    assert.ok(rawSetCookie.includes('HttpOnly'), '解锁 Cookie 必须携带 HttpOnly')
    assert.ok(
      rawSetCookie.includes(`Path=/api/public/${encodeURIComponent(c.uploadToken)}`),
      `Cookie Path 应严格收紧至当前任务路径，实际：${rawSetCookie}`,
    )
    const unlockCookie = rawSetCookie.split(';')[0]

    // 携带解锁 Cookie 访问公开详情可正常读取
    const opened = await app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}`,
      headers: { cookie: unlockCookie },
    })
    assert.equal(opened.statusCode, 200)
    assert.equal(opened.json().collection.title, '机密材料收集')

    // 管理员更换提取码后，旧 Cookie 立即失效
    const rotated = await app.inject({
      method: 'PATCH',
      url: `/api/collections/${c.id}`,
      headers: adminHeaders,
      payload: {
        title: c.title,
        description: c.description,
        category: c.category,
        formats: c.formats,
        deadline: c.deadline,
        target: c.target,
        maxFileSizeMB: c.maxFileSizeMB,
        maxFilesPerSubmission: c.maxFilesPerSubmission,
        materials: c.materials,
        accessCode: 'New2026',
      },
    })
    assert.equal(rotated.statusCode, 200)
    const staleCheck = await app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}`,
      headers: { cookie: unlockCookie },
    })
    assert.deepEqual(staleCheck.json(), { locked: true })

    // 清除提取码后恢复直接访问
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/collections/${c.id}`,
      headers: adminHeaders,
      payload: {
        title: c.title,
        description: c.description,
        category: c.category,
        formats: c.formats,
        deadline: c.deadline,
        target: c.target,
        maxFileSizeMB: c.maxFileSizeMB,
        maxFilesPerSubmission: c.maxFilesPerSubmission,
        materials: c.materials,
        clearAccessCode: true,
      },
    })
    assert.equal(cleared.statusCode, 200)
    assert.equal(cleared.json().collections[0].hasAccessCode, false)
    const openAgain = await app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}` })
    assert.equal(openAgain.json().collection.title, '机密材料收集')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('访问提取码防爆破加固：单 IP 指数退避 + 单任务跨 IP 全局失败上限与换码解封', async () => {
  const { dir, app, origin, adminHeaders } = await bootApp(100, {
    unlockGlobalMaxFailures: 5,
    unlockBackoffBaseMs: 80,
  })
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: adminHeaders,
      payload: {
        title: '短码分布式防爆破测试',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 5,
        accessCode: 'Jiyu8294',
      },
    })
    assert.equal(created.statusCode, 200)
    const c = created.json().collections[0]

    // 1. 单 IP 连续错误 3 次后触发指数退避（第 4 次在退避期内返回 429 + Retry-After）
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/public/${c.uploadToken}/unlock`,
        remoteAddress: '10.10.0.1',
        headers: origin,
        payload: { accessCode: `wrong${i}` },
      })
      assert.equal(res.statusCode, 403)
    }
    const backedOff = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      remoteAddress: '10.10.0.1',
      headers: origin,
      payload: { accessCode: 'Jiyu8294' },
    })
    assert.equal(backedOff.statusCode, 429)
    assert.ok(Number(backedOff.headers['retry-after']) >= 1)

    // 退避期满后再输错一次（第 4 次失败），退避时长翻倍为 160ms
    await new Promise((r) => setTimeout(r, 100))
    const fourthWrong = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      remoteAddress: '10.10.0.1',
      headers: origin,
      payload: { accessCode: 'wrong3' },
    })
    assert.equal(fourthWrong.statusCode, 403)
    await new Promise((r) => setTimeout(r, 90))
    const stillBackedOff = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      remoteAddress: '10.10.0.1',
      headers: origin,
      payload: { accessCode: 'Jiyu8294' },
    })
    assert.equal(stillBackedOff.statusCode, 429, '第 4 次失败后指数退避窗口应翻倍至 >= 160ms')

    // 2. 跨 IP 再错 1 次达到单任务全局上限 5 次，全新 IP 也被全局保护锁定 429
    const fifthWrong = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      remoteAddress: '10.10.0.2',
      headers: origin,
      payload: { accessCode: 'wrong4' },
    })
    assert.equal(fifthWrong.statusCode, 403)

    const blockedFreshIp = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      remoteAddress: '10.10.0.99',
      headers: origin,
      payload: { accessCode: 'Jiyu8294' },
    })
    assert.equal(blockedFreshIp.statusCode, 429)
    assert.match(blockedFreshIp.json().error, /临时保护锁定/)

    // 3. 管理员更换新提取码后，新版本自动解除旧版本全局锁定
    const rotated = await app.inject({
      method: 'PATCH',
      url: `/api/collections/${c.id}`,
      headers: adminHeaders,
      payload: {
        title: c.title,
        description: c.description,
        category: c.category,
        formats: c.formats,
        deadline: c.deadline,
        target: c.target,
        maxFileSizeMB: c.maxFileSizeMB,
        maxFilesPerSubmission: c.maxFilesPerSubmission,
        accessCode: 'Xk7mP9',
      },
    })
    assert.equal(rotated.statusCode, 200)
    const recovered = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      remoteAddress: '10.10.0.99',
      headers: origin,
      payload: { accessCode: 'Xk7mP9' },
    })
    assert.equal(recovered.statusCode, 200)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('名单准入开关：禁止空名单开启、防枚举通用报错、兼容旧任务与旧回执', async () => {
  const { dir, app, origin, adminHeaders } = await bootApp(10)
  try {
    // 无名单时不能开启仅允许名单内提交
    const invalidToggle = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: adminHeaders,
      payload: {
        title: '名单准入测试',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 5,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 5,
        restrictToExpectedSubmitters: true,
      },
    })
    assert.equal(invalidToggle.statusCode, 400)

    // 创建启用名单准入的收集（按学号识别）
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: adminHeaders,
      payload: {
        title: '名单准入测试',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 5,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 5,
        fields: [{ id: 'field_sid', label: '学号', required: true }],
        identityField: 'field_sid',
        expectedSubmitters: ['S2026001', 'S2026002'],
        restrictToExpectedSubmitters: true,
        submissionMode: 'single',
      },
    })
    assert.equal(created.statusCode, 200, created.body)
    const c = created.json().collections[0]
    assert.equal(c.restrictToExpectedSubmitters, true)

    // 公开接口不泄露名单与准入开关
    const pub = await app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}` })
    assert.equal(pub.statusCode, 200)
    assert.equal(pub.json().collection.expectedSubmitters, undefined)
    assert.equal(pub.json().collection.restrictToExpectedSubmitters, undefined)

    // 名单外标识尝试提交返回通用 403，不泄露名单内容或是否已提交
    const outsider = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`,
      headers: { ...origin, 'x-upload-key': 'b'.repeat(48) },
      payload: {
        owner: '路人甲',
        fields: { field_sid: 'S9999999' },
        files: [{ name: 'test.txt', size: 5, lastModified: 1 }],
      },
    })
    assert.equal(outsider.statusCode, 403)
    const msg = outsider.json().error as string
    assert.ok(msg.includes('未通过准入校验'))
    assert.ok(!msg.includes('S2026001') && !msg.includes('应交名单'))

    // 名单内标识（大小写规范化匹配 s2026001）可完整上传并取得回执
    const batchId = randomUUID()
    const uploadKey = 'c'.repeat(48)
    const payloadBuf = Buffer.from('hello')
    const init = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${batchId}`,
      headers: { ...origin, 'x-upload-key': uploadKey },
      payload: {
        owner: '张同学',
        fields: { field_sid: 's2026001' },
        files: [{ name: 'test.txt', size: payloadBuf.length, lastModified: 1 }],
      },
    })
    assert.equal(init.statusCode, 200, init.body)
    const put = await app.inject({
      method: 'PUT',
      url: `/api/public/${c.uploadToken}/uploads/${batchId}/0/0`,
      headers: {
        ...origin,
        'x-upload-key': uploadKey,
        'content-type': 'application/octet-stream',
        'x-chunk-sha256': sha256(payloadBuf),
      },
      payload: payloadBuf,
    })
    assert.equal(put.statusCode, 200)
    const done = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${batchId}/complete`,
      headers: { ...origin, 'x-upload-key': uploadKey },
      payload: {},
    })
    assert.equal(done.statusCode, 201, done.body)
    const receiptId = done.json().receiptId as string

    // 本人回执查询正常
    const receiptRes = await app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${receiptId}`,
      headers: { 'x-receipt-key': uploadKey },
    })
    assert.equal(receiptRes.statusCode, 200)
    assert.equal(receiptRes.json().owner, '张同学')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
