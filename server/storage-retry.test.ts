import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { RemoteHTTP } from './remote-http.ts'
import { isRetryableTransferError } from './storage.ts'
import { HttpError } from './security.ts'
import type { TransferInfo } from '../src/types.ts'

async function createS3Fixture(
  http: RemoteHTTP,
  retry = { maxRetries: 3, baseDelayMs: 30, pollIntervalMs: 15 },
) {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'storage-retry-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    secureCookie: false,
    quotaBytes: 10 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
  }
  const { app, store } = await createApp(config, {
    serveFrontend: false,
    storageHTTP: http,
    storageRetry: retry,
  })
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin: config.origin },
    payload: {
      setupToken: store.setupToken(),
      displayName: '同步重试测试',
      password: 'Password123456!',
    },
  })
  const headers = {
    origin: config.origin,
    cookie: String(setup.headers['set-cookie']).split(';')[0],
    'x-csrf-token': (setup.json() as { csrf: string }).csrf,
  }
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/storage/connections/s3',
    headers,
    payload: {
      endpoint: 'https://s3.example.com',
      root: '/jiyu',
      bucket: 'jiyu-bucket',
      region: 'us-east-1',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
    },
  })
  assert.equal(saved.statusCode, 200)
  const tested = await app.inject({
    method: 'POST',
    url: '/api/storage/connections/s3/test',
    headers,
    payload: { revision: (saved.json() as { revision: string }).revision },
  })
  assert.equal(tested.statusCode, 200, tested.body)
  const col = await app.inject({
    method: 'POST',
    url: '/api/collections',
    headers,
    payload: {
      title: '云端任务',
      description: '',
      category: 'document',
      target: 10,
      deadline: '2099-12-31',
      formats: 'TXT',
      maxFileSizeMB: 2,
      maxFilesPerSubmission: 5,
      storage: 's3',
    },
  })
  assert.equal(col.statusCode, 200)
  const collectionId = (col.json() as { collections: { id: string }[] }).collections[0].id
  const enqueueFile = async (name: string, text: string) => {
    const id = randomUUID()
    const key = randomUUID()
    const bytes = Buffer.from(text)
    await writeFile(join(config.dataDir, 'objects', key), bytes)
    store.addFile(
      {
        id,
        collectionId,
        name,
        owner: '测试员',
        size: bytes.length,
        createdAt: new Date().toISOString(),
        storage: 's3',
        status: 'pending',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      key,
    )
    return { id, bytes }
  }
  const getTransfer = async (fileId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/storage/connections',
      headers,
    })
    return (res.json() as { transfers: TransferInfo[] }).transfers.find((t) => t.file_id === fileId)
  }
  return {
    app,
    store,
    headers,
    enqueueFile,
    getTransfer,
    cleanup: async () => {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('isRetryableTransferError 准确区分瞬态网络错误与不可重试错误', () => {
  assert.equal(isRetryableTransferError(new Error('ECONNRESET')), true)
  assert.equal(isRetryableTransferError(new HttpError(429, 'rate limit')), true)
  assert.equal(isRetryableTransferError(new HttpError(503, 'unavailable')), true)
  assert.equal(
    isRetryableTransferError(Object.assign(new HttpError(502, 'timeout'), { retryable: true })),
    true,
  )
  assert.equal(
    isRetryableTransferError(Object.assign(new HttpError(502, 'forbidden'), { retryable: false })),
    false,
  )
  assert.equal(isRetryableTransferError(new HttpError(401, 'unauthorized')), false)
  assert.equal(isRetryableTransferError(new HttpError(403, 'forbidden')), false)
  assert.equal(isRetryableTransferError(new HttpError(400, 'bad config')), false)
  assert.equal(isRetryableTransferError(new HttpError(502, '远端正文校验不通过')), false)
})

test('云同步遇到瞬态 503/网络错误按指数退避自动重试并恢复成功，状态记录 retryCount 与 nextRetryAt', async () => {
  let putAttempts = 0
  let testDone = false
  const timestamps: number[] = []
  const http: RemoteHTTP = async (req) => {
    if (!testDone) {
      if (req.method === 'DELETE') testDone = true
      const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const sha = createHash('sha256').update(bodyBuf).digest('base64')
      return {
        status: 200,
        headers: req.method === 'PUT' ? { 'x-amz-checksum-sha256': sha } : {},
        body: Readable.from([Buffer.alloc(0)]),
      }
    }
    if (req.method === 'PUT') {
      putAttempts++
      timestamps.push(Date.now())
      const chunks: Buffer[] = []
      if (Buffer.isBuffer(req.body)) chunks.push(req.body)
      else if (req.body) for await (const c of req.body) chunks.push(c)
      if (putAttempts === 1) {
        return { status: 503, headers: {}, body: Readable.from([Buffer.alloc(0)]) }
      }
      if (putAttempts === 2) {
        throw new Error('simulated ECONNRESET')
      }
      const sha = createHash('sha256').update(Buffer.concat(chunks)).digest('base64')
      return {
        status: 200,
        headers: { 'x-amz-checksum-sha256': sha },
        body: Readable.from([Buffer.alloc(0)]),
      }
    }
    return { status: 200, headers: {}, body: Readable.from([Buffer.alloc(0)]) }
  }
  const ctx = await createS3Fixture(http, { maxRetries: 3, baseDelayMs: 60, pollIntervalMs: 15 })
  try {
    const { id } = await ctx.enqueueFile('transient.txt', '瞬态恢复正文')
    let sawScheduledRetry = false
    for (let i = 0; i < 120; i++) {
      const info = await ctx.getTransfer(id)
      if (info && info.state === 'queued' && (info.retryCount || 0) >= 1 && info.nextRetryAt) {
        sawScheduledRetry = true
      }
      if (info?.state === 'ready') break
      await new Promise((r) => setTimeout(r, 20))
    }
    const finalInfo = await ctx.getTransfer(id)
    assert.equal(sawScheduledRetry, true, '应在自动退避期间观察到 retryCount 与 nextRetryAt')
    assert.equal(finalInfo?.state, 'ready')
    assert.equal(finalInfo?.attempts, 3)
    assert.equal(finalInfo?.retryCount, 0)
    assert.equal(finalInfo?.nextRetryAt, undefined)
    // 验证指数退避：第 2 次退避间隔（~120ms）大于第 1 次退避间隔（~60ms）
    assert.equal(timestamps.length, 3)
    assert.ok(timestamps[1] - timestamps[0] >= 45)
    assert.ok(timestamps[2] - timestamps[1] >= 90)
  } finally {
    await ctx.cleanup()
  }
})

test('云同步超过自动重试上限后转入 failed 并支持手动重试，401/403 授权错误不自动重试', async () => {
  let mode: 'test' | 'fail503' | 'fail403' | 'ok' = 'test'
  const http: RemoteHTTP = async (req) => {
    const chunks: Buffer[] = []
    if (Buffer.isBuffer(req.body)) chunks.push(req.body)
    else if (req.body) for await (const c of req.body) chunks.push(c)
    const body = Buffer.concat(chunks)
    if (mode === 'test') {
      if (req.method === 'DELETE') mode = 'fail503'
      return {
        status: 200,
        headers:
          req.method === 'PUT'
            ? { 'x-amz-checksum-sha256': createHash('sha256').update(body).digest('base64') }
            : {},
        body: Readable.from([Buffer.alloc(0)]),
      }
    }
    if (mode === 'fail503') {
      return { status: 503, headers: {}, body: Readable.from([Buffer.alloc(0)]) }
    }
    if (mode === 'fail403') {
      return { status: 403, headers: {}, body: Readable.from([Buffer.alloc(0)]) }
    }
    return {
      status: 200,
      headers:
        req.method === 'PUT'
          ? { 'x-amz-checksum-sha256': createHash('sha256').update(body).digest('base64') }
          : {},
      body: Readable.from([Buffer.alloc(0)]),
    }
  }
  const ctx = await createS3Fixture(http, { maxRetries: 3, baseDelayMs: 25, pollIntervalMs: 10 })
  try {
    // 1. 持续 503 -> 初始 1 次 + 自动重试 3 次 = attempts 4，最终 failed
    const { id: exhaustedId } = await ctx.enqueueFile('exhausted.txt', '持续失败测试')
    for (let i = 0; i < 150; i++) {
      if ((await ctx.getTransfer(exhaustedId))?.state === 'failed') break
      await new Promise((r) => setTimeout(r, 15))
    }
    const exhausted = await ctx.getTransfer(exhaustedId)
    assert.equal(exhausted?.state, 'failed')
    assert.equal(exhausted?.attempts, 4)
    assert.equal(exhausted?.retryCount, 3)
    assert.equal(exhausted?.nextRetryAt, undefined)

    // 2. 403 权限拒绝 -> 不自动重试，attempts=1 立即 failed
    mode = 'fail403'
    const { id: authErrId } = await ctx.enqueueFile('forbidden.txt', '鉴权拒绝测试')
    for (let i = 0; i < 100; i++) {
      if ((await ctx.getTransfer(authErrId))?.state === 'failed') break
      await new Promise((r) => setTimeout(r, 15))
    }
    const authErr = await ctx.getTransfer(authErrId)
    assert.equal(authErr?.state, 'failed')
    assert.equal(authErr?.attempts, 1)
    assert.equal(authErr?.retryCount, 0)

    // 3. 恢复后手动批量重试两个失败任务，均同步成功
    mode = 'ok'
    const retryRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/storage/transfers/retry',
      headers: ctx.headers,
      payload: { ids: [exhaustedId, authErrId] },
    })
    assert.equal(retryRes.statusCode, 200)
    assert.equal((retryRes.json() as { retried: number }).retried, 2)
    for (let i = 0; i < 100; i++) {
      const a = await ctx.getTransfer(exhaustedId)
      const b = await ctx.getTransfer(authErrId)
      if (a?.state === 'ready' && b?.state === 'ready') break
      await new Promise((r) => setTimeout(r, 15))
    }
    assert.equal((await ctx.getTransfer(exhaustedId))?.state, 'ready')
    assert.equal((await ctx.getTransfer(authErrId))?.state, 'ready')
  } finally {
    await ctx.cleanup()
  }
})
