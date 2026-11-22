import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { apiCached, EtagCache, fetchAllPaginatedFiles } from './api.ts'
import type { CollectedFile, PaginatedFiles } from '../types.ts'

test('apiCached 携带 If-None-Match 正确处理 200 与 304 Not Modified', async () => {
  const originalFetch = globalThis.fetch
  const seenHeaders: (string | null)[] = []
  let calls = 0
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++
    const headers = new Headers(init?.headers)
    seenHeaders.push(headers.get('If-None-Match'))
    if (calls === 1) {
      return new Response(JSON.stringify({ ok: true, count: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"etag-v1"' },
      })
    }
    if (calls === 2) {
      return new Response(null, {
        status: 304,
        headers: { ETag: '"etag-v1"' },
      })
    }
    return new Response(JSON.stringify({ ok: true, count: 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"etag-v2"' },
    })
  }) as typeof fetch

  try {
    const r1 = await apiCached<{ ok: boolean; count: number }>('/api/workspace')
    assert.equal(r1.status, 200)
    assert.equal(r1.etag, '"etag-v1"')
    assert.deepEqual(r1.data, { ok: true, count: 1 })
    assert.equal(seenHeaders[0], null)

    const r2 = await apiCached<{ ok: boolean; count: number }>('/api/workspace', r1.etag)
    assert.equal(r2.status, 304)
    assert.equal(r2.etag, '"etag-v1"')
    assert.equal(seenHeaders[1], '"etag-v1"')

    const r3 = await apiCached<{ ok: boolean; count: number }>('/api/workspace', r2.etag)
    assert.equal(r3.status, 200)
    assert.equal(r3.etag, '"etag-v2"')
    assert.deepEqual(r3.data, { ok: true, count: 2 })
    assert.equal(seenHeaders[2], '"etag-v1"')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('EtagCache 按请求 endpoint 独立维护 If-None-Match 与 304 缓存命中，并在变更时刷新', async () => {
  const seen: { url: string; inm: string | null }[] = []
  let version = 1
  const fakeFetcher = async <T>(path: string, etag?: string) => {
    seen.push({ url: path, inm: etag ?? null })
    const serverEtag = `"${path}:v${version}"`
    if (etag && etag === serverEtag) return { status: 304 as const, etag: serverEtag }
    return {
      status: 200 as const,
      etag: serverEtag,
      data: { endpoint: path, version } as T,
    }
  }

  const cache = new EtagCache<{ endpoint: string; version: number }>(2)
  const a1 = await cache.fetch('/api/files?page=1', undefined, fakeFetcher)
  assert.equal(a1.status, 200)
  assert.equal(a1.data.endpoint, '/api/files?page=1')
  assert.equal(seen[0].inm, null)

  // 切换到第 2 页后切回第 1 页：两个 endpoint 各自保留 ETag，不互相覆盖
  const b1 = await cache.fetch('/api/files?page=2', undefined, fakeFetcher)
  assert.equal(b1.status, 200)
  assert.equal(seen[1].inm, null)

  const a2 = await cache.fetch('/api/files?page=1', undefined, fakeFetcher)
  assert.equal(a2.status, 304)
  assert.equal(a2.data.endpoint, '/api/files?page=1')
  assert.equal(seen[2].inm, '"/api/files?page=1:v1"')

  // 服务端发生写操作导致版本递增：仍发送上次 ETag，收到 200 后更新缓存
  version = 2
  const a3 = await cache.fetch('/api/files?page=1', undefined, fakeFetcher)
  assert.equal(a3.status, 200)
  assert.equal(a3.data.version, 2)
  assert.equal(seen[3].inm, '"/api/files?page=1:v1"')

  // LRU 上限为 2：写入第 3 个 endpoint 时淘汰最久未用的 page=2
  await cache.fetch('/api/files?page=3', undefined, fakeFetcher)
  const b2 = await cache.fetch('/api/files?page=2', undefined, fakeFetcher)
  assert.equal(b2.status, 200)
  assert.equal(seen[5].inm, null)
})

test('反向代理剥离 ETag 返回 200 且 etag 为空时，apiCached 与 EtagCache 立即清理陈旧缓存', async () => {
  const originalFetch = globalThis.fetch
  const seenHeaders: (string | null)[] = []
  let call = 0
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    call++
    seenHeaders.push(new Headers(init?.headers).get('If-None-Match'))
    if (call === 1) {
      return new Response(JSON.stringify({ v: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
      })
    }
    // 第二次响应被代理剥离 ETag 头
    return new Response(JSON.stringify({ v: call }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const cache = new EtagCache<{ v: number }>(10)
    const r1 = await cache.fetch('/api/files?q=hello')
    assert.equal(r1.status, 200)
    assert.equal(r1.etag, '"v1"')
    assert.equal(seenHeaders[0], null)

    const r2 = await cache.fetch('/api/files?q=hello')
    assert.equal(r2.status, 200)
    assert.equal(r2.etag, '', '200 缺少 ETag 头时不得复用旧 etag')
    assert.equal(r2.data.v, 2)
    assert.equal(seenHeaders[1], '"v1"')
    assert.equal(cache.get('/api/files?q=hello'), undefined, '空 ETag 响应后必须清理旧缓存条目')

    const r3 = await cache.fetch('/api/files?q=hello')
    assert.equal(r3.data.v, 3)
    assert.equal(seenHeaders[2], null, '清理旧缓存后后续请求不得继续发送过期的 If-None-Match')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchAllPaginatedFiles 完整聚合服务端正文搜索分页结果并遵守上限', async () => {
  const all: CollectedFile[] = Array.from({ length: 250 }, (_, idx) => ({
    id: `f-${idx + 1}`,
    name: `doc-${idx + 1}.txt`,
    size: 100 + idx,
    collectionId: 'col-1',
    owner: '提交人',
    createdAt: '2026-11-22T00:00:00.000Z',
    storage: 'local',
    status: 'ready',
  }))
  const requestedUrls: string[] = []
  const fetcher = async (path: string): Promise<PaginatedFiles> => {
    requestedUrls.push(path)
    const url = new URL(path, 'http://localhost')
    const page = Number(url.searchParams.get('page') || 1)
    const pageSize = Number(url.searchParams.get('pageSize') || 50)
    assert.equal(url.searchParams.get('q'), '海边灯塔')
    const start = (page - 1) * pageSize
    return {
      items: all.slice(start, start + pageSize),
      total: all.length,
      page,
      pageSize,
      hasMore: start + pageSize < all.length,
    }
  }
  const params = new URLSearchParams({ q: '海边灯塔', sort: 'created_desc' })
  const full = await fetchAllPaginatedFiles('/api/files', params, 500, undefined, fetcher)
  assert.equal(full.items.length, 250)
  assert.equal(full.total, 250)
  assert.equal(full.truncated, false)
  assert.equal(requestedUrls.length, 2, '250 条按每页 200 应请求 2 页')

  const capped = await fetchAllPaginatedFiles('/api/files', params, 120, undefined, fetcher)
  assert.equal(capped.items.length, 120)
  assert.equal(capped.truncated, true)
})
