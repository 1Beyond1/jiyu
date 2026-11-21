import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { safeRandomHex, safeRandomUUID, sha256Buffer, sha256BytesFallback, sha256Hex } from './browser-crypto.ts'
import { uploadFiles } from './api.ts'
import { readMaterialRows } from './material-state.ts'
import { materialSnapshotKey } from './materials.ts'
import type { Collection, MaterialStateReport } from '../types.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function withCrypto<T>(replacement: unknown, fn: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: replacement })
  return Promise.resolve().then(fn).finally(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else Reflect.deleteProperty(globalThis, 'crypto')
  })
}

test('safeRandomUUID 在缺少 randomUUID 和完全缺少 WebCrypto 时仍生成 RFC 4122 v4 UUID 且不抛错', async () => {
  assert.match(safeRandomUUID(), UUID_V4)
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  await withCrypto({ getRandomValues }, () => {
    const generated = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const id = safeRandomUUID()
      assert.match(id, UUID_V4)
      generated.add(id)
    }
    assert.equal(generated.size, 20)
    assert.match(safeRandomHex(32), /^[0-9a-f]{64}$/)
  })
  await withCrypto(undefined, () => {
    const id = safeRandomUUID()
    assert.match(id, UUID_V4)
    assert.match(safeRandomHex(32), /^[0-9a-f]{64}$/)
  })
})

test('纯 JS SHA-256 回退在边界长度、中文与大二进制缓冲上与标准实现逐字节一致', async () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    new TextEncoder().encode('abc'),
    new TextEncoder().encode('集屿非 HTTPS 局域网源 SHA-256 兼容性校验'),
    ...[55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129].map(n => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)),
    new Uint8Array(randomBytes(256 * 1024)),
  ]
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  await withCrypto({ getRandomValues }, async () => {
    for (const sample of cases) {
      const expected = createHash('sha256').update(sample).digest()
      assert.deepEqual(Buffer.from(sha256BytesFallback(sample)), expected)
      assert.equal(await sha256Hex(sample), expected.toString('hex'))
      assert.deepEqual(Buffer.from(await sha256Buffer(sample)), expected)
    }
  })
})

test('非 Secure Context 下分片上传和材料快照校验可完整运行不崩溃', async t => {
  const values = new Map<string, string>(), originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => values.get(k) || null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } })
  t.after(() => { if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage') })
  const receiptId = safeRandomUUID()
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers)
    if (url.endsWith('/complete')) return Response.json({ receiptId, filesCount: 1, bytes: 9, createdAt: new Date().toISOString() })
    if (init?.method === 'POST') return Response.json({ id: 'batch', chunkBytes: 4, parts: [] })
    const bytes = Buffer.from(await (init!.body as Blob).arrayBuffer())
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(headers.get('X-Chunk-SHA256'), expected)
    return Response.json({ sha256: expected })
  }
  t.mock.method(globalThis, 'fetch', fetchMock as typeof globalThis.fetch)

  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  await withCrypto({ getRandomValues }, async () => {
    const receipt = await uploadFiles('lan-token', [new File(['hello1234'], '测试.txt', { lastModified: 1 })], '局域网用户', safeRandomUUID(), () => {}, new AbortController().signal)
    assert.equal(receipt.receiptId, receiptId)

    const collection: Collection = {
      id: 'col-1', title: '材料', description: '', category: 'document', received: 0, target: 1, deadline: '2099-12-31',
      storage: 'local', status: 'active', formats: 'TXT', maxFileSizeMB: 10, maxFilesPerSubmission: 5,
      materials: [{ id: 'm1', name: '报名表', required: true, description: '' }], materialRevision: 'rev-1',
    }
    const stateVersion = createHash('sha256').update(materialSnapshotKey(collection, [])).digest('hex')
    const report: MaterialStateReport = {
      collectionId: 'col-1', rulesRevision: 'rev-1', stateVersion, generatedAt: new Date().toISOString(),
      requirements: collection.materials!, summary: { participants: 0, receivedComplete: 0, reviewComplete: 0, missing: 0, needsChanges: 0, unclassified: 0 },
      participants: [], files: [],
    }
    assert.deepEqual(await readMaterialRows(report, collection, []), [])
  })
})
