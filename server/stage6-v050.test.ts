import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { RemoteHTTP, RemoteRequest } from './remote-http.ts'
import { encrypt } from './secrets.ts'
import type { ExportedCollectionTemplate, WebhookRemindResult } from '../src/types.ts'

async function* bufStream(text: string): AsyncIterable<Buffer> {
  yield Buffer.from(text, 'utf8')
}

async function setupAdmin(
  app: Awaited<ReturnType<typeof createApp>>['app'],
  store: Awaited<ReturnType<typeof createApp>>['store'],
  origin: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin },
    payload: {
      setupToken: store.setupToken(),
      displayName: '测试管理员',
      password: 'AdminStrongPassword123!',
    },
  })
  assert.equal(res.statusCode, 200, res.body)
  return {
    origin,
    cookie: String(res.headers['set-cookie']).split(';')[0],
    'x-csrf-token': res.json().csrf as string,
  }
}

async function createAndLoginUser(
  app: Awaited<ReturnType<typeof createApp>>['app'],
  adminHeaders: Record<string, string>,
  origin: string,
  username: string,
  role: 'admin' | 'editor' | 'viewer',
  password = 'MemberStrongPassword123!',
) {
  const added = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: adminHeaders,
    payload: { username, displayName: username, role, password },
  })
  assert.equal(added.statusCode, 200, added.body)
  const user = (added.json() as { id: string; username: string }[]).find(
    (u) => u.username === username,
  )!
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username, password },
  })
  assert.equal(login.statusCode, 200, login.body)
  return {
    id: user.id,
    headers: {
      origin,
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-csrf-token': login.json().csrf as string,
    },
  }
}

test('P1-1 提取码防爆破并发竞态：失败计数跨 await 不丢更新 + 单任务并发在途上限防突发绕过', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'p1-unlock-race-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 16 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
    rateLimits: { globalPerMinute: 1000, unlockPerMinute: 100 },
  }
  const { app, store } = await createApp(config, {
    serveFrontend: false,
    unlockPolicy: {
      globalMaxFailures: 3,
      backoffBaseMs: 500,
      maxInFlightPerCollection: 2,
    },
  })
  try {
    const admin = await setupAdmin(app, store, config.origin)
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: admin,
      payload: {
        title: '提取码并发压测',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 5,
        accessCode: 'K9mP4x',
      },
    })
    assert.equal(created.statusCode, 200, created.body)
    const token = created.json().collections[0].uploadToken as string

    // 1. 同一瞬间并发 6 次错误解锁：最多 2 个进入 scrypt 返回 403，其余立即 429 截流
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/api/public/${token}/unlock`,
          remoteAddress: '10.20.0.1',
          headers: { origin: config.origin },
          payload: { accessCode: `bad0${i}` },
        }),
      ),
    )
    const statuses = burst.map((r) => r.statusCode)
    const count403 = statuses.filter((s) => s === 403).length
    const count429 = statuses.filter((s) => s === 429).length
    assert.ok(count403 >= 1 && count403 <= 2, `同时在途校验上限应为 2，实际 403=${count403}`)
    assert.equal(count403 + count429, 6, `所有突发请求应返回 403 或 429，实际=${statuses}`)
    assert.ok(count429 >= 4, `超出在途并发的突发请求应立即被 429 拦截，实际 429=${count429}`)

    // 2. 跨 await 累加不丢失更新：若上一轮累计了 count403 次（例如 2 次），再补 (3 - count403) 次即触发全局锁定
    const remainingToGlobalLock = 3 - count403
    for (let i = 0; i < remainingToGlobalLock; i++) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/public/${token}/unlock`,
        remoteAddress: `10.20.1.${i + 1}`,
        headers: { origin: config.origin },
        payload: { accessCode: `miss${i}` },
      })
      assert.equal(r.statusCode, 403)
    }

    // 此时已达到 globalMaxFailures=3，全新 IP 即使提交正确提取码也必须被全局保护 429 拒绝
    const lockedFreshIp = await app.inject({
      method: 'POST',
      url: `/api/public/${token}/unlock`,
      remoteAddress: '10.20.9.99',
      headers: { origin: config.origin },
      payload: { accessCode: 'K9mP4x' },
    })
    assert.equal(lockedFreshIp.statusCode, 429)
    assert.match(lockedFreshIp.json().error, /临时保护锁定/)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1-2 分片清理 TOCTOU 修复：活跃批次、宽限期内孤立分片受保护，过宽限孤立分片正确清理', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'p1-uploads-toctou-'))
  let fakeNow = Date.now()
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 16 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store, uploads } = await createApp(config, {
    serveFrontend: false,
    uploadCleanup: {
      orphanGraceMs: 60_000,
      now: () => fakeNow,
      cleanupIntervalMs: 60 * 60 * 1000,
    },
  })
  try {
    const admin = await setupAdmin(app, store, config.origin)
    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: admin,
      payload: {
        title: '分片清理保护测试',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 5,
      },
    })
    const token = created.json().collections[0].uploadToken as string
    const chunksDir = join(config.dataDir, 'chunks')

    // 1. 活跃批次分片即使 mtime 已超过宽限期，也不得被 cleanup() 误删
    const activeBatchId = randomUUID()
    const keyHeader = { origin: config.origin, 'x-upload-key': 'k'.repeat(64) }
    const initRes = await app.inject({
      method: 'POST',
      url: `/api/public/${token}/uploads/${activeBatchId}`,
      headers: keyHeader,
      payload: { owner: '活跃提交者', files: [{ name: 'a.txt', size: 4, lastModified: 1 }] },
    })
    assert.equal(initRes.statusCode, 200, initRes.body)
    const payload = Buffer.from('test')
    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/public/${token}/uploads/${activeBatchId}/0/0`,
      headers: {
        ...keyHeader,
        'content-type': 'application/octet-stream',
        'x-chunk-sha256': createHash('sha256').update(payload).digest('hex'),
      },
      payload,
    })
    assert.equal(putRes.statusCode, 200)
    const activeChunkPath = join(chunksDir, `${activeBatchId}.0.0`)
    const oldDate = new Date(fakeNow - 120_000)
    await utimes(activeChunkPath, oldDate, oldDate)

    // 2. 刚落盘的孤立分片（无 DB 行，但在 60 秒宽限期内）受宽限期保护，不得立即删除
    const freshOrphanId = randomUUID()
    const freshOrphanName = `${freshOrphanId}.0.0.tmp`
    const freshOrphanPath = join(chunksDir, freshOrphanName)
    await writeFile(freshOrphanPath, 'fresh-orphan')
    const recentDate = new Date(fakeNow - 10_000)
    await utimes(freshOrphanPath, recentDate, recentDate)

    // 3. 超过宽限期的孤立分片应当被清理
    const staleOrphanId = randomUUID()
    const staleOrphanName = `${staleOrphanId}.0.0`
    const staleOrphanPath = join(chunksDir, staleOrphanName)
    await writeFile(staleOrphanPath, 'stale-orphan')
    await utimes(staleOrphanPath, oldDate, oldDate)

    await uploads.cleanup()
    const afterFirst = await readdir(chunksDir)
    assert.ok(afterFirst.includes(`${activeBatchId}.0.0`), '活跃上传分片不得被清理')
    assert.ok(afterFirst.includes(freshOrphanName), '宽限期内的新分片文件不得被清理')
    assert.ok(!afterFirst.includes(staleOrphanName), '超过宽限期的孤立分片应被清理')

    // 4. 推进时钟超过宽限期，freshOrphanName 随后被清理，但活跃批次分片仍安全保留
    fakeNow += 65_000
    await uploads.cleanup()
    const afterSecond = await readdir(chunksDir)
    assert.ok(afterSecond.includes(`${activeBatchId}.0.0`), '推进时钟后活跃批次分片仍应保留')
    assert.ok(!afterSecond.includes(freshOrphanName), '超过宽限期的孤立分片应被清理')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P1-3 OAuth Token 刷新并发单飞锁：严格 Refresh Token 轮换下并发刷新仅发起一次且连接不误停用', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'p1-oauth-singleflight-'))
  let activeRefreshToken = 'refresh-gen-1'
  let refreshCalls = 0
  let tokenVersion = 1
  const uploadedPaths: string[] = []

  const mockHttp: RemoteHTTP = async (req: RemoteRequest) => {
    const urlStr = req.url.toString()
    if (urlStr.includes('/oauth2/v2.0/token')) {
      refreshCalls++
      const form = new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '')
      const suppliedRefresh = form.get('refresh_token')
      // 模拟真实云盘延迟，放大并发冲突窗口
      await new Promise((r) => setTimeout(r, 60))
      if (suppliedRefresh !== activeRefreshToken) {
        return {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: bufStream(
            '{"error":"invalid_grant","error_description":"refresh token already rotated"}',
          ),
        }
      }
      tokenVersion++
      activeRefreshToken = `refresh-gen-${tokenVersion}`
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(
          JSON.stringify({
            access_token: `access-gen-${tokenVersion}`,
            refresh_token: activeRefreshToken,
            expires_in: 3600,
          }),
        ),
      }
    }
    if (req.url.hostname === 'upload.up.1drv.com') {
      const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      uploadedPaths.push(req.url.pathname)
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(
          JSON.stringify({
            id: 'item-1',
            size: bodyBuf.length,
            file: {
              hashes: {
                sha256Hash: createHash('sha256').update(bodyBuf).digest('hex').toUpperCase(),
              },
            },
          }),
        ),
      }
    }
    // 校验 Graph API 请求必须携带最新刷新出的 access token
    assert.equal(req.headers?.authorization, `Bearer access-gen-${tokenVersion}`)
    if (req.url.pathname.endsWith('/createUploadSession')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(JSON.stringify({ uploadUrl: 'https://upload.up.1drv.com/session' })),
      }
    }
    if (req.method === 'DELETE') {
      return { status: 204, headers: {}, body: bufStream('') }
    }
    if (req.url.pathname.endsWith('/content')) {
      return { status: 200, headers: {}, body: bufStream('sync-body') }
    }
    if (req.url.pathname.includes('file_doc.txt') || req.url.pathname.includes('.jiyu-check-')) {
      return { status: 404, headers: {}, body: bufStream('{}') }
    }
    if (req.url.pathname.includes(':/')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(JSON.stringify({ id: 'folder-1', folder: {} })),
      }
    }
    return { status: 200, headers: {}, body: bufStream(JSON.stringify({ id: 'drive-root' })) }
  }

  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 16 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store } = await createApp(config, {
    serveFrontend: false,
    storageHTTP: mockHttp,
    storageRetry: { pollIntervalMs: 15, maxRetries: 0 },
  })
  try {
    const admin = await setupAdmin(app, store, config.origin)
    const revision = randomUUID()
    // 预置一个已启用但 accessToken 已过期的 OneDrive 连接
    store.set(
      'storage.onedrive',
      JSON.stringify({
        id: 'onedrive',
        endpoint: 'https://graph.microsoft.com',
        root: '/集屿',
        clientId: 'client-1',
        enabled: true,
        verifiedAt: new Date().toISOString(),
        revision,
        encryptedCredentials: encrypt(
          store,
          JSON.stringify({
            clientSecret: 'secret-1',
            accessToken: 'expired-access-token',
            refreshToken: 'refresh-gen-1',
            expiresAt: Date.now() - 60_000,
          }),
        ),
      }),
    )

    // 创建任务并写入一条待同步的远程传输记录，让后台 worker 与手动 /test 接口同时触发 refresh()
    const colId = randomUUID()
    store.saveCollection({
      id: colId,
      title: 'OneDrive 并发刷新测试',
      description: '',
      category: 'document',
      received: 1,
      target: 10,
      deadline: '2099-12-31',
      storage: 'onedrive',
      status: 'active',
      formats: 'TXT',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 5,
    })
    const fileId = randomUUID()
    const storageKey = randomUUID()
    const content = Buffer.from('sync-body')
    await writeFile(join(config.dataDir, 'objects', storageKey), content)
    store.addFile(
      {
        id: fileId,
        name: 'file_doc.txt',
        originalName: 'file_doc.txt',
        size: content.length,
        collectionId: colId,
        owner: '张三',
        createdAt: new Date().toISOString(),
        storage: 'onedrive',
        remoteStatus: 'queued',
        status: 'pending',
        sha256: createHash('sha256').update(content).digest('hex'),
      },
      storageKey,
    )

    // 紧接着立即并发触发 /test，使后台 work() 与 /test 撞在一起刷新 Token
    const testRes = await app.inject({
      method: 'POST',
      url: '/api/storage/connections/onedrive/test',
      headers: admin,
      payload: { revision },
    })
    assert.equal(testRes.statusCode, 200, testRes.body)
    assert.equal(testRes.json().enabled, true, '单飞刷新成功后连接应保持启用状态')

    // 等待后台传输完成
    const deadlineWait = Date.now() + 3000
    let transferState = ''
    while (Date.now() < deadlineWait) {
      const row = store.db
        .prepare('SELECT state, error FROM remote_transfers WHERE file_id=?')
        .get(fileId) as { state: string; error: string | null } | undefined
      transferState = row?.state || ''
      if (transferState === 'ready' || transferState === 'failed') break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(transferState, 'ready', '并发刷新期间云端同步应顺利完成')
    assert.equal(refreshCalls, 1, `单飞锁应确保仅发起 1 次 OAuth Token 刷新，实际=${refreshCalls}`)
    assert.ok(uploadedPaths.length >= 1)

    // 再次执行连接测试：应直接复用数据库最新未过期凭证，不再发起刷新请求
    const testAgain = await app.inject({
      method: 'POST',
      url: '/api/storage/connections/onedrive/test',
      headers: admin,
      payload: { revision },
    })
    assert.equal(testAgain.statusCode, 200, testAgain.body)
    assert.equal(refreshCalls, 1, '已刷新的有效凭证应直接复用，不应重复刷新')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('P2 PATCH /api/users/:id 并发原子合并：改密不覆盖并发的角色降权或禁用状态', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'p2-users-merge-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 8 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const admin = await setupAdmin(app, store, config.origin)
    const target = await createAndLoginUser(app, admin, config.origin, 'target_admin', 'admin')

    // 并发执行：请求 A 仅改密码（经历较慢的 scrypt），请求 B 立即降权为 viewer 并禁用
    const [patchPwd, patchDemote] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: admin,
        payload: { password: 'BrandNewStrongPassword999!' },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: admin,
        payload: { role: 'viewer', disabled: true },
      }),
    ])
    assert.equal(patchPwd.statusCode, 200, patchPwd.body)
    assert.equal(patchDemote.statusCode, 200, patchDemote.body)

    const usersRes = await app.inject({ method: 'GET', url: '/api/users', headers: admin })
    const finalUser = (usersRes.json() as { id: string; role: string; disabled: boolean }[]).find(
      (u) => u.id === target.id,
    )!
    assert.equal(finalUser.role, 'viewer', '并发改密不得覆盖角色降权')
    assert.equal(finalUser.disabled, true, '并发改密不得复活已禁用账号')

    // 重新启用该账号并验证新密码已生效（而非丢失）
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${target.id}`,
      headers: admin,
      payload: { disabled: false },
    })
    const loginNew = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { username: 'target_admin', password: 'BrandNewStrongPassword999!' },
    })
    assert.equal(loginNew.statusCode, 200, '新密码应已保留并可登录')
    assert.equal(loginNew.json().user.role, 'viewer')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('v0.5.0 定时截止预警幂等调度（跨重启不重发）、手动催交 Webhook API、标准模板 JSON 导入导出与部署加固校验', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'v050-features-'))
  // 2026-11-25 14:00 UTC+8 -> 距 2026-11-25 23:59:59.999+08:00 约 10 小时
  let fakeNow = Date.parse('2026-11-25T14:00:00+08:00')
  const webhookHits: { url: string; headers: Record<string, string>; body: string }[] = []

  const mockHttp: RemoteHTTP = async (req: RemoteRequest) => {
    webhookHits.push({
      url: req.url.toString(),
      headers: req.headers || {},
      body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '',
    })
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: bufStream('{"code":0,"errcode":0}'),
    }
  }

  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 16 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const makeService = () =>
    createApp(config, {
      serveFrontend: false,
      webhookPolicy: {
        http: mockHttp,
        debounceMs: 10,
        retryBaseMs: 10,
        deadlineIntervalMs: 60 * 60 * 1000,
        now: () => fakeNow,
      },
    })

  let svc = await makeService()
  try {
    // 1. 验证健康检查版本号为 0.5.0
    const health = await svc.app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { ok: true, version: '0.5.0' })

    const admin = await setupAdmin(svc.app, svc.store, config.origin)
    await createAndLoginUser(svc.app, admin, config.origin, 'ed_v05', 'editor')
    await createAndLoginUser(svc.app, admin, config.origin, 'vw_v05', 'viewer')

    // 配置一个通用 Webhook 渠道订阅 collection.deadline_soon
    const chRes = await svc.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: admin,
      payload: {
        name: '催交播报群',
        type: 'generic',
        url: 'https://hooks.example.com/v050-secret-hook',
        secret: 'v050-hmac-secret',
        events: ['collection.deadline_soon'],
        debounceSeconds: 10,
        enabled: true,
      },
    })
    assert.equal(chRes.statusCode, 201, chRes.body)

    // 2. 创建带定时截止预警（提前 6h + 脱敏）和敏感配置的收集任务
    const colPayload = {
      title: '期末项目材料收集',
      description: '请按材料槽位提交',
      category: 'document',
      formats: 'PDF, DOCX',
      deadline: '2026-11-25',
      target: 3,
      maxFileSizeMB: 20,
      maxFilesPerSubmission: 5,
      fields: [{ id: 'field_sid', label: '学号', required: true }],
      identityField: 'field_sid',
      expectedSubmitters: ['S2026001', 'S2026002', 'S2026003'],
      restrictToExpectedSubmitters: true,
      accessCode: 'Code8899',
      naming: { parts: ['field_sid', 'owner', 'material'], separator: '_' },
      materials: [{ id: 'mat_report', name: '项目报告', required: true, description: 'PDF 格式' }],
      deadlineReminder: {
        enabled: true,
        hoursBefore: 6,
        desensitizeNames: true,
        // 恶意伪造 lastSentDeadline 应被服务端忽略
        lastSentDeadline: '2026-11-25',
      },
    }
    const created = await svc.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: admin,
      payload: colPayload,
    })
    assert.equal(created.statusCode, 200, created.body)
    const c = created.json().collections[0]
    assert.equal(c.deadlineReminder.enabled, true)
    assert.equal(c.deadlineReminder.hoursBefore, 6)
    assert.equal(c.deadlineReminder.desensitizeNames, true)
    assert.equal(
      c.deadlineReminder.lastSentDeadline,
      undefined,
      '服务端不得信任客户端传入的 lastSentDeadline',
    )

    // 创建一个显式关闭定时预警的任务，验证不会被定时扫描误触发
    const optOut = await svc.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: admin,
      payload: {
        title: '关闭预警任务',
        description: '',
        category: 'document',
        formats: 'PDF',
        deadline: '2026-11-25',
        target: 5,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
        deadlineReminder: { enabled: false, hoursBefore: 24, desensitizeNames: true },
      },
    })
    assert.equal(optOut.statusCode, 200)

    // 模拟 S2026001 已提交必需材料（S2026002、S2026003 缺交）
    const fileId = randomUUID()
    svc.store.addFile(
      {
        id: fileId,
        name: 'S2026001_张三_项目报告.pdf',
        originalName: 'report.pdf',
        size: 128,
        collectionId: c.id,
        owner: '张三',
        participant: 'S2026001',
        materialId: 'mat_report',
        createdAt: new Date(fakeNow).toISOString(),
        storage: 'local',
        status: 'pending',
        sha256: 'a'.repeat(64),
      },
      randomUUID(),
    )

    // 公开解锁后接口不得泄露 deadlineReminder 内部配置
    const unlock = await svc.app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/unlock`,
      headers: { origin: config.origin },
      payload: { accessCode: 'Code8899' },
    })
    assert.equal(unlock.statusCode, 200)
    assert.equal(unlock.json().collection.deadlineReminder, undefined)

    // 3. 定时调度窗口校验：当前距离截止 10 小时（> 6 小时）不应触发
    assert.equal(svc.webhooks.checkDeadlines(false), 0)
    await svc.webhooks.flushPending()
    assert.equal(webhookHits.length, 0)

    // 推进到距离截止 4 小时（20:00 UTC+8 < 6 小时）：应精确触发 1 次，且只触发启用预警的任务
    fakeNow = Date.parse('2026-11-25T20:00:00+08:00')
    assert.equal(svc.webhooks.checkDeadlines(false), 1)
    await svc.webhooks.flushPending()
    assert.equal(webhookHits.length, 1)
    assert.equal(webhookHits[0].headers['User-Agent'], 'Jiyu-Webhook/0.5.0')
    const sentBody = JSON.parse(webhookHits[0].body) as {
      summary: string
      items: { detail?: string }[]
    }
    assert.match(sentBody.summary, /已收齐 1\/3 人/)
    assert.match(sentBody.summary, /缺交 2 人/)
    const detailText = sentBody.items[0]?.detail || ''
    assert.ok(!detailText.includes('S2026002'), '开启脱敏时不得明文暴露缺交标识 S2026002')
    assert.ok(!detailText.includes('S2026003'), '开启脱敏时不得明文暴露缺交标识 S2026003')
    assert.ok(detailText.includes('S20***02'), `应包含脱敏标识，实际：${detailText}`)

    // 原子持久化 lastSentDeadline 校验
    const persisted = svc.store.collection(c.id)!
    assert.equal(persisted.deadlineReminder?.lastSentDeadline, '2026-11-25')
    assert.ok(persisted.deadlineReminder?.lastSentAt)

    // 重启服务后即使清空旧的 webhooks.deadlineNotified，仍因 lastSentDeadline 保持幂等不重发
    await svc.app.close()
    svc = await makeService()
    svc.store.db.prepare("DELETE FROM settings WHERE key='webhooks.deadlineNotified'").run()
    webhookHits.length = 0
    assert.equal(svc.webhooks.checkDeadlines(false), 0, '重启后同一 deadline 不得重复播报')
    await svc.webhooks.flushPending()
    assert.equal(webhookHits.length, 0)

    // 延长截止日期至 2026-11-26，并推进到新截止前 3 小时 -> 自动重新触发
    const adminLogin = await svc.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { username: 'admin', password: 'AdminStrongPassword123!' },
    })
    const admin2 = {
      origin: config.origin,
      cookie: String(adminLogin.headers['set-cookie']).split(';')[0],
      'x-csrf-token': adminLogin.json().csrf as string,
    }
    const edLogin2 = await svc.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { username: 'ed_v05', password: 'MemberStrongPassword123!' },
    })
    const editor2 = {
      origin: config.origin,
      cookie: String(edLogin2.headers['set-cookie']).split(';')[0],
      'x-csrf-token': edLogin2.json().csrf as string,
    }
    const vwLogin2 = await svc.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { username: 'vw_v05', password: 'MemberStrongPassword123!' },
    })
    const viewer2 = {
      origin: config.origin,
      cookie: String(vwLogin2.headers['set-cookie']).split(';')[0],
      'x-csrf-token': vwLogin2.json().csrf as string,
    }
    const extended = await svc.app.inject({
      method: 'PATCH',
      url: `/api/collections/${c.id}`,
      headers: admin2,
      payload: { ...colPayload, deadline: '2026-11-26', accessCode: undefined },
    })
    assert.equal(extended.statusCode, 200, extended.body)
    fakeNow = Date.parse('2026-11-26T21:00:00+08:00')
    assert.equal(svc.webhooks.checkDeadlines(false), 1, '新截止日期临近时应重新触发预警')
    await svc.webhooks.flushPending()
    assert.equal(webhookHits.length, 1)
    assert.equal(svc.store.collection(c.id)!.deadlineReminder?.lastSentDeadline, '2026-11-26')

    // 4. 手动立即推送催交摘要 API：鉴权与实时投递状态校验
    const viewerPush = await svc.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/remind-webhook`,
      headers: viewer2,
      payload: {},
    })
    assert.equal(viewerPush.statusCode, 403, '只读成员不得推送 Webhook 催交摘要')

    const noCsrfPush = await svc.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/remind-webhook`,
      headers: { origin: config.origin, cookie: editor2.cookie },
      payload: {},
    })
    assert.equal(noCsrfPush.statusCode, 403, '缺少 CSRF Token 必须拒绝')

    webhookHits.length = 0
    const editorPush = await svc.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/remind-webhook`,
      headers: editor2,
      payload: { desensitizeNames: false },
    })
    assert.equal(editorPush.statusCode, 200, editorPush.body)
    const pushResult = editorPush.json() as WebhookRemindResult
    assert.equal(pushResult.ok, true)
    assert.equal(pushResult.succeeded, 1)
    assert.equal(pushResult.totalChannels, 1)
    assert.equal(pushResult.stats.missingCount, 2)
    assert.equal(pushResult.deliveries[0].targetHint, 'https://hooks.example.com/•••')
    assert.ok(!editorPush.body.includes('v050-secret-hook'), '返回结果不得泄露原始 Webhook URL')
    assert.ok(!editorPush.body.includes('v050-hmac-secret'), '返回结果不得泄露加签密钥')
    assert.ok(webhookHits[0].body.includes('S2026002'), '显式关闭脱敏时应推送完整缺失标识')

    // 5. 收集模板标准 JSON 导入 / 导出（Template Portability）
    const savedTpl = await svc.app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: admin2,
      payload: { collectionId: c.id, name: '期末材料标准模板' },
    })
    assert.equal(savedTpl.statusCode, 200, savedTpl.body)
    const tplId = savedTpl.json().id as string

    const exportedRes = await svc.app.inject({
      method: 'GET',
      url: `/api/templates/${tplId}/export`,
      headers: { cookie: viewer2.cookie },
    })
    assert.equal(exportedRes.statusCode, 200, exportedRes.body)
    assert.match(String(exportedRes.headers['content-disposition']), /attachment;/)
    const exported = exportedRes.json() as ExportedCollectionTemplate
    assert.equal(exported.schema, 'jiyu-template-v1')
    assert.equal(exported.name, '期末材料标准模板')
    assert.equal(exported.rules.deadlineReminder?.hoursBefore, 6)
    assert.equal(
      exported.rules.deadlineReminder?.lastSentDeadline,
      undefined,
      '导出模板不得包含历史发送时间戳',
    )
    // 严格剔除敏感字段
    assert.ok(!exportedRes.body.includes('S2026001'), '导出模板不得包含应交名单')
    assert.ok(!exportedRes.body.includes('Code8899'), '导出模板不得包含提取码')
    assert.ok(!exportedRes.body.includes(c.uploadToken), '导出模板不得包含分享令牌')
    assert.equal(exported.rules.expectedSubmitters, undefined)
    assert.equal(exported.rules.deadline, undefined)
    assert.equal(exported.rules.accessCodeHash, undefined)
    assert.equal(exported.rules.storage, undefined)

    // 导入鉴权与强校验
    assert.equal(
      (
        await svc.app.inject({
          method: 'POST',
          url: '/api/templates/import',
          headers: viewer2,
          payload: exported,
        })
      ).statusCode,
      403,
      '只读成员不得导入模板',
    )
    assert.equal(
      (
        await svc.app.inject({
          method: 'POST',
          url: '/api/templates/import',
          headers: editor2,
          payload: { ...exported, schema: 'wrong-v2' },
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await svc.app.inject({
          method: 'POST',
          url: '/api/templates/import',
          headers: editor2,
          payload: { ...exported, name: '超'.repeat(45) },
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await svc.app.inject({
          method: 'POST',
          url: '/api/templates/import',
          headers: editor2,
          payload: {
            ...exported,
            rules: {
              ...exported.rules,
              fields: Array.from({ length: 9 }, (_, i) => ({
                id: `field_f${i}`,
                label: `字段${i}`,
                required: false,
              })),
            },
          },
        })
      ).statusCode,
      400,
      '超过 8 个自定义字段必须拒绝导入',
    )

    // 正常导入并自动剥离恶意夹带的敏感字段
    const importedRes = await svc.app.inject({
      method: 'POST',
      url: '/api/templates/import',
      headers: editor2,
      payload: {
        ...exported,
        name: '跨工作台导入模板',
        rules: {
          ...exported.rules,
          expectedSubmitters: ['偷偷夹带名单'],
          uploadToken: 'smuggled-token',
          accessCodeHash: 'smuggled-hash',
          storage: 's3',
        },
      },
    })
    assert.equal(importedRes.statusCode, 201, importedRes.body)
    const imported = importedRes.json()
    assert.equal(imported.name, '跨工作台导入模板')
    assert.equal(imported.rules.expectedSubmitters, undefined)
    assert.equal(imported.rules.uploadToken, undefined)
    assert.equal(imported.rules.accessCodeHash, undefined)
    assert.equal(imported.rules.storage, undefined)
    assert.equal(imported.rules.materials.length, 1)
    assert.equal(imported.rules.deadlineReminder.hoursBefore, 6)

    // 6. 验证 compose.yaml、.env.example 与 Caddyfile 安全加固配置一致（容器构建阶段仅复制源码，不包含宿主编排文件）
    if (existsSync(resolve('compose.yaml'))) {
      const composeText = await readFile(resolve('compose.yaml'), 'utf8')
      const envExampleText = await readFile(resolve('.env.example'), 'utf8')
      const caddyText = await readFile(resolve('Caddyfile'), 'utf8')
      assert.ok(composeText.includes('JIYU_RATE_LIMIT_UNLOCK'))
      assert.ok(composeText.includes('JIYU_STORAGE_STRICT_READBACK'))
      assert.ok(composeText.includes('JIYU_DEADLINE_CHECK_INTERVAL_SECONDS'))
      assert.ok(envExampleText.includes('JIYU_RATE_LIMIT_UNLOCK'))
      assert.ok(envExampleText.includes('JIYU_STORAGE_STRICT_READBACK'))
      assert.ok(envExampleText.includes('JIYU_DEADLINE_CHECK_INTERVAL_SECONDS'))
      assert.ok(composeText.includes('NET_BIND_SERVICE'))
      assert.ok(caddyText.includes('Strict-Transport-Security'))
      assert.ok(caddyText.includes('Permissions-Policy'))
    }
  } finally {
    await svc.app.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('红队回归：含标点模板名导出不报400、新建未勾选任务不误发24h预警、多渠道部分失败可重试且不重复、OAuth跨revision刷新失败不传染', async () => {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'rt6-regression-'))
  let fakeNow = Date.parse('2026-11-25T22:00:00+08:00') // 距 2026-11-25 截止仅 2 小时
  let failChannelB = true
  const webhookByUrl: Record<string, number> = {}

  const webhookHttp: RemoteHTTP = async (req: RemoteRequest) => {
    const key = req.url.hostname
    webhookByUrl[key] = (webhookByUrl[key] || 0) + 1
    if (key === 'chan-b.example.com' && failChannelB) {
      return { status: 503, headers: {}, body: bufStream('{"error":"temp"}') }
    }
    return { status: 200, headers: {}, body: bufStream('{"ok":true}') }
  }

  let r1RefreshStarted!: () => void
  const r1RefreshStartedPromise = new Promise<void>((r) => {
    r1RefreshStarted = r
  })
  let releaseR1Refresh!: () => void
  const r1RefreshGate = new Promise<void>((r) => {
    releaseR1Refresh = r
  })

  const storageHttp: RemoteHTTP = async (req: RemoteRequest) => {
    if (req.url.toString().includes('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '')
      const rt = form.get('refresh_token')
      if (rt === 'r1-broken-refresh') {
        r1RefreshStarted()
        await r1RefreshGate
        return {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: bufStream('{"error":"invalid_grant"}'),
        }
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(
          JSON.stringify({
            access_token: 'r2-fresh-access',
            refresh_token: 'r2-fresh-refresh',
            expires_in: 3600,
          }),
        ),
      }
    }
    if (req.url.hostname === 'upload.up.1drv.com') {
      const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(
          JSON.stringify({
            id: 'probe-1',
            size: bodyBuf.length,
            file: {
              hashes: {
                sha256Hash: createHash('sha256').update(bodyBuf).digest('hex').toUpperCase(),
              },
            },
          }),
        ),
      }
    }
    if (req.url.pathname.endsWith('/createUploadSession')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(JSON.stringify({ uploadUrl: 'https://upload.up.1drv.com/session' })),
      }
    }
    if (req.method === 'DELETE') return { status: 204, headers: {}, body: bufStream('') }
    if (req.url.pathname.includes('.jiyu-check-')) {
      return { status: 404, headers: {}, body: bufStream('{}') }
    }
    if (req.url.pathname.includes(':/')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: bufStream(JSON.stringify({ id: 'folder-1', folder: {} })),
      }
    }
    return { status: 200, headers: {}, body: bufStream(JSON.stringify({ id: 'drive-root' })) }
  }

  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 16 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store, webhooks } = await createApp(config, {
    serveFrontend: false,
    storageHTTP: storageHttp,
    storageRetry: { pollIntervalMs: 15, maxRetries: 0 },
    webhookPolicy: {
      http: webhookHttp,
      debounceMs: 10,
      retryBaseMs: 10,
      maxAttempts: 1,
      deadlineIntervalMs: 60 * 60 * 1000,
      now: () => fakeNow,
    },
  })
  try {
    const admin = await setupAdmin(app, store, config.origin)

    // 注册 A / B 两个订阅截止预警的渠道
    for (const [name, url] of [
      ['渠道A', 'https://chan-a.example.com/hook'],
      ['渠道B', 'https://chan-b.example.com/hook'],
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/webhooks',
        headers: admin,
        payload: {
          name,
          type: 'generic',
          url,
          events: ['collection.deadline_soon'],
          enabled: true,
        },
      })
      assert.equal(r.statusCode, 201, r.body)
    }

    // 1. P1-2：新建任务未勾选/未传 deadlineReminder 时显式落库 enabled:false，临近截止（2h）绝不误发群聊
    const silentColRes = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: admin,
      payload: {
        title: '机密敏感收集',
        description: '',
        category: 'document',
        formats: 'PDF',
        deadline: '2026-11-25',
        target: 5,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
      },
    })
    assert.equal(silentColRes.statusCode, 200, silentColRes.body)
    const silentCol = silentColRes.json().collections[0]
    assert.equal(silentCol.deadlineReminder?.enabled, false, '新建任务默认须显式关闭自动预警')
    assert.equal(webhooks.checkDeadlines(false), 0, '未开启定时预警的新任务不得在 24h 内自动推送')
    await webhooks.flushPending()
    assert.equal(Object.keys(webhookByUrl).length, 0)

    // 2. P1-1：模板名称含 / : ? * 等标点符号时，导出接口必须清洗下载名并返回 200（不可报 400）
    const punctTpl = await app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: admin,
      payload: { collectionId: silentCol.id, name: '2026/05 毕业材料:终稿?*' },
    })
    assert.equal(punctTpl.statusCode, 200, punctTpl.body)
    const exportPunct = await app.inject({
      method: 'GET',
      url: `/api/templates/${punctTpl.json().id}/export`,
      headers: { cookie: admin.cookie },
    })
    assert.equal(exportPunct.statusCode, 200, exportPunct.body)
    assert.equal(exportPunct.json().name, '2026/05 毕业材料:终稿?*')
    assert.match(String(exportPunct.headers['content-disposition']), /filename\*=UTF-8''/)

    // 3. P2-2：多渠道部分失败时 A 成功、B 503 失败 -> 不提前写死 lastSentDeadline；B 恢复后仅补发 B（A 不重复）且随后写 lastSentDeadline
    const alertColRes = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: admin,
      payload: {
        title: '多渠道预警任务',
        description: '',
        category: 'document',
        formats: 'PDF',
        deadline: '2026-11-25',
        target: 5,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
        deadlineReminder: { enabled: true, hoursBefore: 6, desensitizeNames: true },
      },
    })
    assert.equal(alertColRes.statusCode, 200, alertColRes.body)
    const alertCol = alertColRes
      .json()
      .collections.find((x: { title: string }) => x.title === '多渠道预警任务')

    assert.equal(webhooks.checkDeadlines(false), 1)
    await webhooks.flushPending()
    assert.equal(webhookByUrl['chan-a.example.com'], 1)
    assert.equal(webhookByUrl['chan-b.example.com'], 1)
    assert.equal(
      store.collection(alertCol.id)?.deadlineReminder?.lastSentDeadline,
      undefined,
      '存在失败渠道时不得提前写入任务级 lastSentDeadline',
    )

    // 渠道 B 恢复后再次巡检：A 不得重复发送，仅补发 B，成功后写入 lastSentDeadline
    failChannelB = false
    assert.equal(webhooks.checkDeadlines(false), 1)
    await webhooks.flushPending()
    assert.equal(webhookByUrl['chan-a.example.com'], 1, '已成功渠道 A 不得重复收到通知')
    assert.equal(webhookByUrl['chan-b.example.com'], 2, '上次失败的渠道 B 应获得补发')
    assert.equal(
      store.collection(alertCol.id)?.deadlineReminder?.lastSentDeadline,
      '2026-11-25',
      '全部渠道投递成功后应持久化 lastSentDeadline',
    )
    assert.equal(webhooks.checkDeadlines(false), 0)

    // 4. P2-1：OAuth 单飞锁按 provider:revision 隔离：旧 revision R1 失败 400 期间，新 revision R2 并发 /test 不受传染且启用成功
    const rev1 = randomUUID()
    store.set(
      'storage.onedrive',
      JSON.stringify({
        id: 'onedrive',
        endpoint: 'https://graph.microsoft.com',
        root: '/集屿',
        clientId: 'c1',
        enabled: true,
        verifiedAt: new Date().toISOString(),
        revision: rev1,
        encryptedCredentials: encrypt(
          store,
          JSON.stringify({
            clientSecret: 's1',
            accessToken: 'expired-r1',
            refreshToken: 'r1-broken-refresh',
            expiresAt: Date.now() - 60_000,
          }),
        ),
      }),
    )
    const colId = randomUUID()
    store.saveCollection({
      id: colId,
      title: 'R1传输',
      description: '',
      category: 'document',
      received: 1,
      target: 1,
      deadline: '2099-12-31',
      storage: 'onedrive',
      status: 'active',
      formats: 'TXT',
      maxFileSizeMB: 1,
      maxFilesPerSubmission: 1,
    })
    const key = randomUUID()
    const payload = Buffer.from('r1-file')
    await writeFile(join(config.dataDir, 'objects', key), payload)
    store.addFile(
      {
        id: randomUUID(),
        name: 'r1.txt',
        originalName: 'r1.txt',
        size: payload.length,
        collectionId: colId,
        owner: '张三',
        createdAt: new Date().toISOString(),
        storage: 'onedrive',
        remoteStatus: 'queued',
        status: 'pending',
        sha256: createHash('sha256').update(payload).digest('hex'),
      },
      key,
    )

    // 等待后台 work() 进入 R1 慢速刷新
    await r1RefreshStartedPromise

    // 此时管理员保存全新有效凭证 R2，并立即触发 /test，同时放行 R1 返回 HTTP 400
    const rev2 = randomUUID()
    store.set(
      'storage.onedrive',
      JSON.stringify({
        id: 'onedrive',
        endpoint: 'https://graph.microsoft.com',
        root: '/集屿',
        clientId: 'c2',
        enabled: false,
        revision: rev2,
        encryptedCredentials: encrypt(
          store,
          JSON.stringify({
            clientSecret: 's2',
            accessToken: 'expired-r2',
            refreshToken: 'r2-good-refresh',
            expiresAt: Date.now() - 60_000,
          }),
        ),
      }),
    )
    const testR2Promise = app.inject({
      method: 'POST',
      url: '/api/storage/connections/onedrive/test',
      headers: admin,
      payload: { revision: rev2 },
    })
    releaseR1Refresh()
    const testR2 = await testR2Promise
    assert.equal(testR2.statusCode, 200, `R1 刷新失败不得传染 R2 测试：${testR2.body}`)
    assert.equal(testR2.json().enabled, true, 'R2 连接测试通过后应启用，不得被 R1 错误停用')
  } finally {
    await app.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})
