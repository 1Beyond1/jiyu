import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { apiCached, EtagCache } from './api.ts'

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
