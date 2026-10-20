import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile, rm, readdir, open } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { crc32 } from 'node:zlib'
import { fromBuffer } from 'yauzl'
import { createApp } from './app.ts'
import { archiveEntries } from './archive.ts'
import type { CollectedFile, Collection, ArchiveLayout, ArchivePlan } from '../src/types.ts'

function collection(id = randomUUID()): Collection { return { id, title: '视觉/品牌素材', description: '', category: 'design', target: 10, received: 0, deadline: '2099-12-31', storage: 'local', status: 'active', formats: 'PDF, TXT', maxFileSizeMB: 100, maxFilesPerSubmission: 20 } }
function file(collectionId: string, name = '资料.pdf', owner = '陈念'): CollectedFile { return { id: randomUUID(), name, collectionId, owner, size: 0, createdAt: '2026-10-20T08:00:00Z', storage: 'local', status: 'pending' } }
async function unzip(bytes: Buffer) {
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) { reject(error); return }
      const entries = new Map<string, Buffer>()
      zip.on('error', reject); zip.on('end', () => resolve(entries))
      zip.on('entry', entry => zip.openReadStream(entry, (error, input) => {
        if (error) { zip.close(); reject(error); return }
        const chunks: Buffer[] = []
        input!.on('error', reject); input!.on('data', chunk => chunks.push(chunk))
        input!.on('end', () => {
          const data = Buffer.concat(chunks)
          try { assert.equal(crc32(data), entry.crc32); assert.equal(entries.has(entry.fileName), false); entries.set(entry.fileName, data); zip.readEntry() } catch (e) { zip.close(); reject(e) }
        })
      }))
      zip.readEntry()
    })
  })
}
async function fixture() {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'archive-test-')), dataDir = join(dir, 'data')
  const origin = 'http://127.0.0.1:3000', service = await createApp({ dataDir, origin, host: '127.0.0.1', port: 3000, quotaBytes: 20 * 1024 ** 3, requestBytes: 512 * 1024 ** 2, secureCookie: false }, { serveFrontend: false })
  const init = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin }, payload: { setupToken: service.store.setupToken(), password: 'fixture-archive-password', displayName: '归档测试' } })
  const headers = { origin, cookie: init.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': init.json().csrf }
  const request = (method: 'POST' | 'GET' | 'DELETE', url: string, payload?: object, custom = headers) => service.app.inject({ method, url, headers: custom, payload })
  const add = async (collectionId: string, name: string, owner: string, bytes: Buffer) => {
    const record = file(collectionId, name, owner), key = randomUUID()
    record.size = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(dataDir, 'objects', key), bytes); service.store.addFile(record, key)
    return { record, key, bytes }
  }
  return { ...service, dataDir, headers, request, add, async close() { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) } }
}

test('归档路径处理中文、路径字符、设备名、重名与超长名称，保持原记录', () => {
  const a = collection(), b = collection()
  const files = [file(a.id, '资料.pdf', '../陈念'), file(a.id, '资料.pdf', '../陈念'), file(b.id, 'CON.txt', '..:陈念'), file(a.id, `${'长'.repeat(180)}.pdf`, '../陈念')]
  const before = JSON.stringify(files)
  for (const layout of ['flat', 'collection', 'owner', 'collection-owner'] as ArchiveLayout[]) {
    const paths = archiveEntries(files, [a, b], layout).map(e => e.path)
    assert.equal(new Set(paths.map(p => p.toLowerCase())).size, 4)
    for (const path of paths) { assert.equal(path.startsWith('/'), false); for (const part of path.split('/')) { assert.ok(part !== '..' && part !== '.'); assert.ok(Buffer.byteLength(part) <= 180); assert.equal(/[<>:"\\|?*]/.test(part), false) } }
    assert.ok(paths.some(p => p.endsWith('_CON.txt')))
  }
  assert.equal(JSON.stringify(files), before)
  const same = [file(a.id, 'A.pdf'), file(a.id, 'a.pdf'), file(a.id, 'a (2).pdf')]
  assert.equal(new Set(archiveEntries(same, [a], 'flat').map(e => e.path.toLowerCase())).size, 3)
})

test('四种布局生成可解包 ZIP，字节/CRC 一致，会话隔离且计划只能下载一次', async () => {
  const f = await fixture()
  try {
    const a = collection(), b = collection(); f.store.saveCollection(a); f.store.saveCollection(b)
    const files = [await f.add(a.id, '资料.pdf', '陈念', Buffer.from('真实文件内容一')), await f.add(a.id, '资料.pdf', '陈念', Buffer.from('真实文件内容二')), await f.add(b.id, '空文件.txt', '陈/念', Buffer.alloc(0))]
    const ids = files.map(f => f.record.id)
    assert.equal((await f.request('POST', '/api/archives', { ids, layout: 'flat' }, { ...f.headers, cookie: '' })).statusCode, 401)
    assert.equal((await f.request('POST', '/api/archives', { ids, layout: 'flat' }, { ...f.headers, 'x-csrf-token': '' })).statusCode, 403)
    assert.equal((await f.request('POST', '/api/archives', { ids, layout: 'flat' }, { ...f.headers, origin: 'https://evil.example' })).statusCode, 403)
    for (const layout of ['flat', 'collection', 'owner', 'collection-owner']) {
      const result = await f.request('POST', '/api/archives', { ids, layout }); assert.equal(result.statusCode, 200, result.body)
      const plan = result.json() as ArchivePlan
      assert.equal(result.body.includes('storage_key'), false)
      const download = await f.request('GET', `/api/archives/${plan.id}/download`)
      assert.equal(download.statusCode, 200, download.body)
      assert.match(String(download.headers['content-type']), /application\/zip/)
      assert.match(String(download.headers['content-disposition']), /attachment/)
      const entries = await unzip(download.rawPayload)
      assert.deepEqual([...entries.keys()], plan.entries.map(e => e.path))
      for (const entry of plan.entries) assert.deepEqual(entries.get(entry.path), files.find(f => f.record.id === entry.id)!.bytes)
      assert.equal((await f.request('GET', `/api/archives/${plan.id}`)).json().status, 'completed')
      if (layout === 'flat') {
        assert.equal((await f.request('GET', `/api/archives/${plan.id}/download`)).statusCode, 409)
        const login = await f.request('POST', '/api/auth/login', { password: 'fixture-archive-password' })
        assert.equal((await f.request('GET', `/api/archives/${plan.id}`, undefined, { ...f.headers, cookie: login.headers['set-cookie']!.toString().split(';')[0] })).statusCode, 404)
      }
    }
    assert.deepEqual(f.store.files().map(f => f.name), ['空文件.txt', '资料.pdf', '资料.pdf'])
    assert.deepEqual(await readdir(join(f.dataDir, 'tmp')), [])
  } finally { await f.close() }
})

test('拒绝过量、过期、未知、回收站、已变更或缺失的文件，不产出残缺归档', async t => {
  const f = await fixture()
  try {
    const c = collection(); f.store.saveCollection(c)
    const { record, key } = await f.add(c.id, '资料.pdf', '陈念', Buffer.from('内容'))
    const create = () => f.request('POST', '/api/archives', { ids: [record.id], layout: 'collection-owner' })
    assert.equal((await f.request('POST', '/api/archives', { ids: [], layout: 'flat' })).statusCode, 400)
    assert.equal((await f.request('POST', '/api/archives', { ids: [record.id, record.id], layout: 'flat' })).statusCode, 400)
    assert.equal((await f.request('POST', '/api/archives', { ids: Array.from({ length: 501 }, () => randomUUID()), layout: 'flat' })).statusCode, 400)
    assert.equal((await f.request('POST', '/api/archives', { ids: [randomUUID()], layout: 'flat' })).statusCode, 404)
    assert.equal((await f.request('POST', '/api/archives', { ids: [record.id], layout: '../' })).statusCode, 400)
    f.store.saveFile({ ...record, size: 10 * 1024 ** 3 + 1 }); assert.equal((await create()).statusCode, 413); f.store.saveFile(record)
    const stale = (await create()).json()
    f.store.saveFile({ ...record, name: '修改.pdf' })
    const rejected = await f.request('GET', `/api/archives/${stale.id}/download`)
    assert.equal(rejected.statusCode, 409); assert.match(String(rejected.headers['content-type']), /text\/html/)
    assert.equal((await f.request('GET', `/api/archives/${stale.id}`)).json().status, 'failed')
    f.store.saveFile(record)
    const trash = (await create()).json(); f.store.saveFile({ ...record, deletedAt: new Date().toISOString() })
    assert.equal((await f.request('GET', `/api/archives/${trash.id}/download`)).statusCode, 409)
    f.store.saveFile(record)
    const missing = (await create()).json(); await rm(join(f.dataDir, 'objects', key))
    assert.equal((await f.request('GET', `/api/archives/${missing.id}/download`)).statusCode, 409)
    assert.equal((await f.request('GET', `/api/archives/${missing.id}/download`, undefined, { ...f.headers, cookie: '' })).statusCode, 401)
    const expired = (await create()).json()
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60 * 1000 + 1 })
    assert.equal((await f.request('GET', `/api/archives/${expired.id}/download`)).statusCode, 404)
  } finally { t.mock.timers.reset(); await f.close() }
})

test('真实 HTTP 中断可释放归档并发名额，损坏内容不会报告成功', async () => {
  const f = await fixture()
  const connections: Awaited<ReturnType<typeof connect>>[] = []
  async function connect(id: string, address: string) {
    return new Promise<import('node:http').IncomingMessage>((resolve, reject) => { const req = httpGet(`${address}/api/archives/${id}/download`, { headers: { cookie: f.headers.cookie } }, res => { res.on('error', () => {}); res.pause(); resolve(res) }); req.on('error', reject) })
  }
  try {
    const c = collection(); f.store.saveCollection(c)
    const record = file(c.id), key = randomUUID(), chunk = Buffer.alloc(1024 ** 2), hash = createHash('sha256')
    for (let i = 0; i < 64; i++) hash.update(chunk)
    record.size = 64 * 1024 ** 2; record.sha256 = hash.digest('hex')
    const disk = await open(join(f.dataDir, 'objects', key), 'w'); await disk.truncate(record.size); await disk.close(); f.store.addFile(record, key)
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 })
    const create = async () => (await f.request('POST', '/api/archives', { ids: [record.id], layout: 'flat' })).json() as ArchivePlan
    const a = await create(), b = await create(), blocked = await create()
    connections.push(await connect(a.id, address), await connect(b.id, address))
    assert.equal((await f.request('GET', `/api/archives/${blocked.id}/download`)).statusCode, 429)
    connections[0].destroy()
    for (let i = 0; i < 30 && (await f.request('GET', `/api/archives/${a.id}`)).json().status === 'streaming'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal((await f.request('GET', `/api/archives/${a.id}`)).json().status, 'cancelled')
    const next = await create(); connections.push(await connect(next.id, address)); assert.equal(connections[2].statusCode, 200)
    for (const plan of [b, next]) await f.request('DELETE', `/api/archives/${plan.id}`)
    const broken = await f.add(c.id, '损坏.pdf', '陈念', Buffer.from('原文'))
    await writeFile(join(f.dataDir, 'objects', broken.key), Buffer.from('改动'))
    const corruptPlan = (await f.request('POST', '/api/archives', { ids: [broken.record.id], layout: 'flat' })).json()
    const response = await connect(corruptPlan.id, address); connections.push(response)
    await new Promise<void>(resolve => { response.once('end', resolve); response.once('close', resolve); response.resume() })
    assert.equal((await f.request('GET', `/api/archives/${corruptPlan.id}`)).json().status, 'failed')
  } finally { for (const response of connections) response.destroy(); await f.close() }
})
