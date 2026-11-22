import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { apiCached } from './api.ts'

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
