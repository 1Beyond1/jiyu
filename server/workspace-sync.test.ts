import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { PaginatedFiles, Workspace } from '../src/types.ts'

async function setupApp() {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'workspace-sync-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 20 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  const setupRes = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin: config.origin },
    payload: {
      setupToken: store.setupToken(),
      displayName: '测试管理员',
      password: 'Password123456!',
    },
  })
  assert.equal(setupRes.statusCode, 200)
  const adminCookie = setupRes.headers['set-cookie']
    ? String(
        Array.isArray(setupRes.headers['set-cookie'])
          ? setupRes.headers['set-cookie'][0]
          : setupRes.headers['set-cookie'],
      ).split(';')[0]
    : ''
  const adminCsrf = (setupRes.json() as { csrf: string }).csrf
  return {
    dir,
    config,
    app,
    store,
    adminCookie,
    adminCsrf,
    cleanup: async () => {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('GET /api/workspace 支持强一致 ETag、If-None-Match 304 与角色隔离', async () => {
  const ctx = await setupApp()
  try {
    const first = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace',
      headers: { cookie: ctx.adminCookie },
    })
    assert.equal(first.statusCode, 200)
    assert.equal(first.headers['cache-control'], 'no-cache')
    const etag1 = String(first.headers.etag || '')
    assert.ok(etag1.startsWith('"') && etag1.endsWith('"'))

    // 精确匹配返回 304 且无响应体
    const hit = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace',
      headers: { cookie: ctx.adminCookie, 'if-none-match': etag1 },
    })
    assert.equal(hit.statusCode, 304)
    assert.equal(hit.body, '')
    assert.equal(hit.headers.etag, etag1)
    assert.equal(hit.headers['cache-control'], 'no-cache')

    // 支持弱前缀与逗号列表匹配
    const weakHit = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace',
      headers: { cookie: ctx.adminCookie, 'if-none-match': `"other", W/${etag1}` },
    })
    assert.equal(weakHit.statusCode, 304)

    // 写入后 ETag 变化，不再命中 304
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: {
        cookie: ctx.adminCookie,
        origin: ctx.config.origin,
        'x-csrf-token': ctx.adminCsrf,
      },
      payload: {
        title: '设计稿收集',
        description: '',
        category: 'design',
        target: 10,
        deadline: '2099-12-31',
        formats: 'PDF, PNG',
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
      },
    })
    assert.equal(created.statusCode, 200)

    const afterWrite = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace',
      headers: { cookie: ctx.adminCookie, 'if-none-match': etag1 },
    })
    assert.equal(afterWrite.statusCode, 200)
    const etag2 = String(afterWrite.headers.etag || '')
    assert.notEqual(etag2, etag1)
    assert.equal((afterWrite.json() as Workspace).collections.length, 1)

    // 创建只读成员并验证同库下不同角色 ETag 独立，避免误用管理员 ETag 缓存
    const createViewer = await ctx.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: {
        cookie: ctx.adminCookie,
        origin: ctx.config.origin,
        'x-csrf-token': ctx.adminCsrf,
      },
      payload: {
        username: 'viewer1',
        displayName: '只读同事',
        password: 'ViewerPassword123!',
        role: 'viewer',
      },
    })
    assert.equal(createViewer.statusCode, 200)
    const loginViewer = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ctx.config.origin },
      payload: { username: 'viewer1', password: 'ViewerPassword123!' },
    })
    assert.equal(loginViewer.statusCode, 200)
    const viewerCookie = String(
      Array.isArray(loginViewer.headers['set-cookie'])
        ? loginViewer.headers['set-cookie'][0]
        : loginViewer.headers['set-cookie'],
    ).split(';')[0]

    const adminLatest = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace',
      headers: { cookie: ctx.adminCookie },
    })
    const viewerRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/workspace',
      headers: { cookie: viewerCookie, 'if-none-match': String(adminLatest.headers.etag) },
    })
    assert.equal(viewerRes.statusCode, 200)
    assert.notEqual(viewerRes.headers.etag, adminLatest.headers.etag)
    assert.equal((viewerRes.json() as Workspace).collections[0].uploadToken, undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('GET /api/files 与 GET /api/collections/:id/files 支持分页、筛选、搜索、排序与 ETag 304', async () => {
  const ctx = await setupApp()
  try {
    const colA = {
      id: randomUUID(),
      title: '作业一',
      description: '',
      category: 'document' as const,
      received: 4,
      target: 10,
      deadline: '2099-12-31',
      storage: 'local' as const,
      status: 'active' as const,
      formats: 'PDF, PNG',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 5,
      uploadToken: 'token-col-a-123456',
    }
    const colB = { ...colA, id: randomUUID(), title: '海报征集', uploadToken: 'token-col-b-123456' }
    ctx.store.saveCollection(colA)
    ctx.store.saveCollection(colB)

    const base = Date.parse('2026-11-01T00:00:00.000Z')
    const seed = [
      {
        id: randomUUID(),
        name: 'alpha.pdf',
        size: 300,
        collectionId: colA.id,
        owner: '张三',
        createdAt: new Date(base + 1000).toISOString(),
        status: 'pending' as const,
        tags: ['报告'],
      },
      {
        id: randomUUID(),
        name: 'beta.png',
        size: 100,
        collectionId: colA.id,
        owner: '李四',
        createdAt: new Date(base + 2000).toISOString(),
        status: 'ready' as const,
        tags: ['海报'],
      },
      {
        id: randomUUID(),
        name: 'gamma.pdf',
        size: 500,
        collectionId: colA.id,
        owner: '王五',
        createdAt: new Date(base + 3000).toISOString(),
        status: 'pending' as const,
      },
      {
        id: randomUUID(),
        name: 'trashed.pdf',
        size: 200,
        collectionId: colA.id,
        owner: '赵六',
        createdAt: new Date(base + 4000).toISOString(),
        status: 'pending' as const,
        deletedAt: new Date(base + 5000).toISOString(),
      },
      {
        id: randomUUID(),
        name: 'poster.png',
        size: 900,
        collectionId: colB.id,
        owner: '张三',
        createdAt: new Date(base + 6000).toISOString(),
        status: 'ready' as const,
      },
    ]
    for (const f of seed) {
      ctx.store.addFile({ ...f, storage: 'local' }, randomUUID())
    }

    // 默认查询：仅有效文件、最新在前、分页正确
    const page1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/files?page=1&pageSize=2',
      headers: { cookie: ctx.adminCookie },
    })
    assert.equal(page1.statusCode, 200)
    assert.equal(page1.headers['cache-control'], 'no-cache')
    const body1 = page1.json() as PaginatedFiles
    assert.equal(body1.total, 4)
    assert.equal(body1.page, 1)
    assert.equal(body1.pageSize, 2)
    assert.equal(body1.hasMore, true)
    assert.deepEqual(
      body1.items.map((f) => f.name),
      ['poster.png', 'gamma.pdf'],
    )

    // 同查询携带 ETag 返回 304
    const page1NotModified = await ctx.app.inject({
      method: 'GET',
      url: '/api/files?page=1&pageSize=2',
      headers: { cookie: ctx.adminCookie, 'if-none-match': String(page1.headers.etag) },
    })
    assert.equal(page1NotModified.statusCode, 304)

    // 第 2 页
    const page2 = await ctx.app.inject({
      method: 'GET',
      url: '/api/files?page=2&pageSize=2',
      headers: { cookie: ctx.adminCookie },
    })
    const body2 = page2.json() as PaginatedFiles
    assert.equal(body2.hasMore, false)
    assert.deepEqual(
      body2.items.map((f) => f.name),
      ['beta.png', 'alpha.pdf'],
    )

    // 筛选：collectionId + status + sort
    const colAPending = await ctx.app.inject({
      method: 'GET',
      url: `/api/collections/${colA.id}/files?status=pending&sort=size_desc`,
      headers: { cookie: ctx.adminCookie },
    })
    assert.equal(colAPending.statusCode, 200)
    assert.deepEqual(
      (colAPending.json() as PaginatedFiles).items.map((f) => f.name),
      ['gamma.pdf', 'alpha.pdf'],
    )

    // 筛选：trashed=true
    const trashed = await ctx.app.inject({
      method: 'GET',
      url: '/api/files?trashed=true',
      headers: { cookie: ctx.adminCookie },
    })
    assert.equal(trashed.statusCode, 200)
    assert.deepEqual(
      (trashed.json() as PaginatedFiles).items.map((f) => f.name),
      ['trashed.pdf'],
    )

    // 筛选：kind=image + 搜索 q（标签/提交人）
    const byTag = await ctx.app.inject({
      method: 'GET',
      url: '/api/files?kind=image&q=%E6%B5%B7%E6%8A%A5',
      headers: { cookie: ctx.adminCookie },
    })
    assert.equal(byTag.statusCode, 200)
    assert.deepEqual(
      (byTag.json() as PaginatedFiles).items.map((f) => f.name),
      ['beta.png'],
    )

    // 参数校验 & 404
    const badPage = await ctx.app.inject({
      method: 'GET',
      url: '/api/files?page=0',
      headers: { cookie: ctx.adminCookie },
    })
    assert.equal(badPage.statusCode, 400)
    const missingCol = await ctx.app.inject({
      method: 'GET',
      url: `/api/collections/${randomUUID()}/files`,
      headers: { cookie: ctx.adminCookie },
    })
    assert.equal(missingCol.statusCode, 404)

    // 公开接口区分当前有效份数 activeFiles 与历史累计提交数 received
    const pubRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/public/${colA.uploadToken}`,
    })
    assert.equal(pubRes.statusCode, 200)
    const pubBody = pubRes.json() as {
      collection: { received: number; activeFiles: number; uploadToken?: string }
    }
    assert.equal(pubBody.collection.received, 4)
    assert.equal(pubBody.collection.activeFiles, 3)
    assert.equal(pubBody.collection.uploadToken, undefined)
  } finally {
    await ctx.cleanup()
  }
})
