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
import { materialFileVersion } from '../src/lib/materials.ts'
import type { CollectedFile, Collection, ArchiveLayout, ArchivePlan } from '../src/types.ts'

function collection(id = randomUUID()): Collection {
  return {
    id,
    title: '视觉/品牌素材',
    description: '',
    category: 'design',
    target: 10,
    received: 0,
    deadline: '2099-12-31',
    storage: 'local',
    status: 'active',
    formats: 'PDF, TXT',
    maxFileSizeMB: 100,
    maxFilesPerSubmission: 20,
  }
}
function file(collectionId: string, name = '资料.pdf', owner = '陈念'): CollectedFile {
  return {
    id: randomUUID(),
    name,
    collectionId,
    owner,
    size: 0,
    createdAt: '2026-10-20T08:00:00Z',
    storage: 'local',
    status: 'pending',
  }
}
async function unzip(bytes: Buffer) {
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) {
        reject(error)
        return
      }
      const entries = new Map<string, Buffer>()
      zip.on('error', reject)
      zip.on('end', () => resolve(entries))
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, (error, input) => {
          if (error) {
            zip.close()
            reject(error)
            return
          }
          const chunks: Buffer[] = []
          input!.on('error', reject)
          input!.on('data', (chunk) => chunks.push(chunk))
          input!.on('end', () => {
            const data = Buffer.concat(chunks)
            try {
              assert.equal(crc32(data), entry.crc32)
              assert.equal(entries.has(entry.fileName), false)
              entries.set(entry.fileName, data)
              zip.readEntry()
            } catch (e) {
              zip.close()
              reject(e)
            }
          })
        }),
      )
      zip.readEntry()
    })
  })
}
async function fixture() {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'archive-test-')),
    dataDir = join(dir, 'data')
  const origin = 'http://127.0.0.1:3000',
    service = await createApp(
      {
        dataDir,
        origin,
        host: '127.0.0.1',
        port: 3000,
        quotaBytes: 20 * 1024 ** 3,
        requestBytes: 512 * 1024 ** 2,
        secureCookie: false,
      },
      { serveFrontend: false },
    )
  const init = await service.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin },
    payload: {
      setupToken: service.store.setupToken(),
      password: 'fixture-archive-password',
      displayName: '归档测试',
    },
  })
  const headers = {
    origin,
    cookie: init.headers['set-cookie']!.toString().split(';')[0],
    'x-csrf-token': init.json().csrf,
  }
  const request = (
    method: 'POST' | 'GET' | 'DELETE',
    url: string,
    payload?: object,
    custom = headers,
  ) => service.app.inject({ method, url, headers: custom, payload })
  const add = async (collectionId: string, name: string, owner: string, bytes: Buffer) => {
    const record = file(collectionId, name, owner),
      key = randomUUID()
    record.size = bytes.length
    record.sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(dataDir, 'objects', key), bytes)
    service.store.addFile(record, key)
    return { record, key, bytes }
  }
  return {
    ...service,
    dataDir,
    headers,
    request,
    add,
    async close() {
      await service.app.close()
      if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
    },
  }
}

test('归档路径处理中文、路径字符、设备名、重名与超长名称，保持原记录', () => {
  const a = collection(),
    b = collection()
  const files = [
    file(a.id, '资料.pdf', '../陈念'),
    file(a.id, '资料.pdf', '../陈念'),
    file(b.id, 'CON.txt', '..:陈念'),
    file(a.id, `${'长'.repeat(180)}.pdf`, '../陈念'),
  ]
  const before = JSON.stringify(files)
  for (const layout of ['flat', 'collection', 'owner', 'collection-owner'] as ArchiveLayout[]) {
    const paths = archiveEntries(files, [a, b], layout).map((e) => e.path)
    assert.equal(new Set(paths.map((p) => p.toLowerCase())).size, 4)
    for (const path of paths) {
      assert.equal(path.startsWith('/'), false)
      for (const part of path.split('/')) {
        assert.ok(part !== '..' && part !== '.')
        assert.ok(Buffer.byteLength(part) <= 180)
        assert.equal(/[<>:"\\|?*]/.test(part), false)
      }
    }
    assert.ok(paths.some((p) => p.endsWith('_CON.txt')))
  }
  assert.equal(JSON.stringify(files), before)
  const same = [file(a.id, 'A.pdf'), file(a.id, 'a.pdf'), file(a.id, 'a (2).pdf')]
  assert.equal(new Set(archiveEntries(same, [a], 'flat').map((e) => e.path.toLowerCase())).size, 3)
})

test('四种布局生成可解包 ZIP，字节/CRC 一致，会话隔离且计划只能下载一次', async () => {
  const f = await fixture()
  try {
    const a = collection(),
      b = collection()
    f.store.saveCollection(a)
    f.store.saveCollection(b)
    const files = [
      await f.add(a.id, '资料.pdf', '陈念', Buffer.from('真实文件内容一')),
      await f.add(a.id, '资料.pdf', '陈念', Buffer.from('真实文件内容二')),
      await f.add(b.id, '空文件.txt', '陈/念', Buffer.alloc(0)),
    ]
    const ids = files.map((f) => f.record.id)
    assert.equal(
      (
        await f.request(
          'POST',
          '/api/archives',
          { ids, layout: 'flat' },
          { ...f.headers, cookie: '' },
        )
      ).statusCode,
      401,
    )
    assert.equal(
      (
        await f.request(
          'POST',
          '/api/archives',
          { ids, layout: 'flat' },
          { ...f.headers, 'x-csrf-token': '' },
        )
      ).statusCode,
      403,
    )
    assert.equal(
      (
        await f.request(
          'POST',
          '/api/archives',
          { ids, layout: 'flat' },
          { ...f.headers, origin: 'https://evil.example' },
        )
      ).statusCode,
      403,
    )
    for (const layout of ['flat', 'collection', 'owner', 'collection-owner']) {
      const result = await f.request('POST', '/api/archives', { ids, layout })
      assert.equal(result.statusCode, 200, result.body)
      const plan = result.json() as ArchivePlan
      assert.equal(result.body.includes('storage_key'), false)
      const download = await f.request('GET', `/api/archives/${plan.id}/download`)
      assert.equal(download.statusCode, 200, download.body)
      assert.match(String(download.headers['content-type']), /application\/zip/)
      assert.match(String(download.headers['content-disposition']), /attachment/)
      const entries = await unzip(download.rawPayload)
      assert.deepEqual(
        [...entries.keys()],
        plan.entries.map((e) => e.path),
      )
      for (const entry of plan.entries)
        assert.deepEqual(
          entries.get(entry.path),
          files.find((f) => f.record.id === entry.id)!.bytes,
        )
      assert.equal((await f.request('GET', `/api/archives/${plan.id}`)).json().status, 'completed')
      if (layout === 'flat') {
        assert.equal((await f.request('GET', `/api/archives/${plan.id}/download`)).statusCode, 409)
        const login = await f.request('POST', '/api/auth/login', {
          password: 'fixture-archive-password',
        })
        assert.equal(
          (
            await f.request('GET', `/api/archives/${plan.id}`, undefined, {
              ...f.headers,
              cookie: login.headers['set-cookie']!.toString().split(';')[0],
            })
          ).statusCode,
          404,
        )
      }
    }
    assert.deepEqual(
      f.store.files().map((f) => f.name),
      ['空文件.txt', '资料.pdf', '资料.pdf'],
    )
    assert.deepEqual(await readdir(join(f.dataDir, 'tmp')), [])
  } finally {
    await f.close()
  }
})

test('拒绝过量、过期、未知、回收站、已变更或缺失的文件，不产出残缺归档', async (t) => {
  const f = await fixture()
  try {
    const c = collection()
    f.store.saveCollection(c)
    const { record, key } = await f.add(c.id, '资料.pdf', '陈念', Buffer.from('内容'))
    const create = () =>
      f.request('POST', '/api/archives', { ids: [record.id], layout: 'collection-owner' })
    assert.equal(
      (await f.request('POST', '/api/archives', { ids: [], layout: 'flat' })).statusCode,
      400,
    )
    assert.equal(
      (await f.request('POST', '/api/archives', { ids: [record.id, record.id], layout: 'flat' }))
        .statusCode,
      400,
    )
    assert.equal(
      (
        await f.request('POST', '/api/archives', {
          ids: Array.from({ length: 501 }, () => randomUUID()),
          layout: 'flat',
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (await f.request('POST', '/api/archives', { ids: [randomUUID()], layout: 'flat' }))
        .statusCode,
      404,
    )
    assert.equal(
      (await f.request('POST', '/api/archives', { ids: [record.id], layout: '../' })).statusCode,
      400,
    )
    f.store.saveFile({ ...record, size: 10 * 1024 ** 3 + 1 })
    assert.equal((await create()).statusCode, 413)
    f.store.saveFile(record)
    const stale = (await create()).json()
    f.store.saveFile({ ...record, name: '修改.pdf' })
    const rejected = await f.request('GET', `/api/archives/${stale.id}/download`)
    assert.equal(rejected.statusCode, 409)
    assert.match(String(rejected.headers['content-type']), /text\/html/)
    assert.equal((await f.request('GET', `/api/archives/${stale.id}`)).json().status, 'failed')
    f.store.saveFile(record)
    const trash = (await create()).json()
    f.store.saveFile({ ...record, deletedAt: new Date().toISOString() })
    assert.equal((await f.request('GET', `/api/archives/${trash.id}/download`)).statusCode, 409)
    f.store.saveFile(record)
    const missing = (await create()).json()
    await rm(join(f.dataDir, 'objects', key))
    assert.equal((await f.request('GET', `/api/archives/${missing.id}/download`)).statusCode, 409)
    assert.equal(
      (
        await f.request('GET', `/api/archives/${missing.id}/download`, undefined, {
          ...f.headers,
          cookie: '',
        })
      ).statusCode,
      401,
    )
    const expired = (await create()).json()
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60 * 1000 + 1 })
    assert.equal((await f.request('GET', `/api/archives/${expired.id}/download`)).statusCode, 404)
  } finally {
    t.mock.timers.reset()
    await f.close()
  }
})

test('真实 HTTP 中断可释放归档并发名额，损坏内容不会报告成功', async () => {
  const f = await fixture()
  const connections: Awaited<ReturnType<typeof connect>>[] = []
  async function connect(id: string, address: string) {
    return new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = httpGet(
        `${address}/api/archives/${id}/download`,
        { headers: { cookie: f.headers.cookie } },
        (res) => {
          res.on('error', () => {})
          res.pause()
          resolve(res)
        },
      )
      req.on('error', reject)
    })
  }
  try {
    const c = collection()
    f.store.saveCollection(c)
    const record = file(c.id),
      key = randomUUID(),
      chunk = Buffer.alloc(1024 ** 2),
      hash = createHash('sha256')
    for (let i = 0; i < 64; i++) hash.update(chunk)
    record.size = 64 * 1024 ** 2
    record.sha256 = hash.digest('hex')
    const disk = await open(join(f.dataDir, 'objects', key), 'w')
    await disk.truncate(record.size)
    await disk.close()
    f.store.addFile(record, key)
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 })
    const create = async () =>
      (
        await f.request('POST', '/api/archives', { ids: [record.id], layout: 'flat' })
      ).json() as ArchivePlan
    const a = await create(),
      b = await create(),
      blocked = await create()
    connections.push(await connect(a.id, address), await connect(b.id, address))
    assert.equal((await f.request('GET', `/api/archives/${blocked.id}/download`)).statusCode, 429)
    connections[0].destroy()
    for (
      let i = 0;
      i < 30 && (await f.request('GET', `/api/archives/${a.id}`)).json().status === 'streaming';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await f.request('GET', `/api/archives/${a.id}`)).json().status, 'cancelled')
    const next = await create()
    connections.push(await connect(next.id, address))
    assert.equal(connections[2].statusCode, 200)
    for (const plan of [b, next]) await f.request('DELETE', `/api/archives/${plan.id}`)
    const broken = await f.add(c.id, '损坏.pdf', '陈念', Buffer.from('原文'))
    await writeFile(join(f.dataDir, 'objects', broken.key), Buffer.from('改动'))
    const corruptPlan = (
      await f.request('POST', '/api/archives', { ids: [broken.record.id], layout: 'flat' })
    ).json()
    const response = await connect(corruptPlan.id, address)
    connections.push(response)
    await new Promise<void>((resolve) => {
      response.once('end', resolve)
      response.once('close', resolve)
      response.resume()
    })
    assert.equal(
      (await f.request('GET', `/api/archives/${corruptPlan.id}`)).json().status,
      'failed',
    )
  } finally {
    for (const response of connections) response.destroy()
    await f.close()
  }
})

test('按材料项分目录（material-owner / owner-material）与仅打包人工核对通过（绑定 rulesRevision）', async () => {
  const f = await fixture()
  try {
    const rev = 'rev-material-v1'
    const c: Collection = {
      ...collection(),
      title: '材料归档任务',
      materials: [
        { id: 'mat_form', name: '报名表', required: true, description: '' },
        { id: 'mat_doc', name: '作品说明', required: true, description: '' },
      ],
      materialRevision: rev,
    }
    f.store.saveCollection(c)

    const acceptedA = await f.add(c.id, 'form.pdf', '张三', Buffer.from('已通过报名表'))
    acceptedA.record.materialId = 'mat_form'
    acceptedA.record.materialVersion = 1
    acceptedA.record.materialReview = {
      decision: 'accepted',
      note: '合格',
      rulesRevision: rev,
      fileVersion: materialFileVersion(acceptedA.record),
      operationId: randomUUID(),
      reviewerId: 'primary',
      reviewerName: '管理员',
      reviewedAt: new Date().toISOString(),
    }
    f.store.saveFile(acceptedA.record)

    const acceptedB = await f.add(c.id, 'doc.pdf', '李四', Buffer.from('已通过作品说明'))
    acceptedB.record.materialId = 'mat_doc'
    acceptedB.record.materialVersion = 1
    acceptedB.record.materialReview = {
      decision: 'accepted',
      note: '',
      rulesRevision: rev,
      fileVersion: materialFileVersion(acceptedB.record),
      operationId: randomUUID(),
      reviewerId: 'primary',
      reviewerName: '管理员',
      reviewedAt: new Date().toISOString(),
    }
    f.store.saveFile(acceptedB.record)

    const pendingC = await f.add(c.id, 'pending.pdf', '王五', Buffer.from('待核对'))
    pendingC.record.materialId = 'mat_form'
    pendingC.record.materialVersion = 1
    f.store.saveFile(pendingC.record)

    const rejectedD = await f.add(c.id, 'rejected.pdf', '赵六', Buffer.from('已退回'))
    rejectedD.record.materialId = 'mat_doc'
    rejectedD.record.materialVersion = 1
    rejectedD.record.materialReview = {
      decision: 'needs_changes',
      note: '缺少签名',
      rulesRevision: rev,
      fileVersion: materialFileVersion(rejectedD.record),
      operationId: randomUUID(),
      reviewerId: 'primary',
      reviewerName: '管理员',
      reviewedAt: new Date().toISOString(),
    }
    f.store.saveFile(rejectedD.record)

    const unclassifiedE = await f.add(c.id, 'misc.pdf', '周七', Buffer.from('未分类'))

    const allIds = [
      acceptedA.record.id,
      acceptedB.record.id,
      pendingC.record.id,
      rejectedD.record.id,
      unclassifiedE.record.id,
    ]

    // 1. 验证 material/owner 与 owner/material 目录路径生成（含未分类回退）
    const matOwnerPaths = archiveEntries(
      [acceptedA.record, acceptedB.record, unclassifiedE.record],
      [c],
      'material-owner',
    ).map((e) => e.path)
    assert.deepEqual(matOwnerPaths, [
      '报名表/张三/form.pdf',
      '作品说明/李四/doc.pdf',
      '未分类/周七/misc.pdf',
    ])

    const ownerMatPaths = archiveEntries(
      [acceptedA.record, acceptedB.record, unclassifiedE.record],
      [c],
      'owner-material',
    ).map((e) => e.path)
    assert.deepEqual(ownerMatPaths, [
      '张三/报名表/form.pdf',
      '李四/作品说明/doc.pdf',
      '周七/未分类/misc.pdf',
    ])

    // 2. acceptedOnly 缺少或错配 rulesRevision 时严格拒绝
    assert.equal(
      (
        await f.request('POST', '/api/archives', {
          ids: allIds,
          layout: 'material/owner',
          acceptedOnly: true,
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await f.request('POST', '/api/archives', {
          ids: allIds,
          layout: 'material/owner',
          acceptedOnly: true,
          rulesRevision: 'stale-rev',
        })
      ).statusCode,
      409,
    )

    // 3. 正确 rulesRevision 下仅保留 2 份人工核对通过文件并生成有效 ZIP
    const planRes = await f.request('POST', '/api/archives', {
      ids: allIds,
      layout: 'material/owner',
      acceptedOnly: true,
      rulesRevision: rev,
    })
    assert.equal(planRes.statusCode, 200, planRes.body)
    const plan = planRes.json() as ArchivePlan
    assert.equal(plan.layout, 'material-owner')
    assert.equal(plan.acceptedOnly, true)
    assert.equal(plan.excludedCount, 3)
    assert.deepEqual(
      plan.entries.map((e) => e.path),
      ['报名表/张三/form.pdf', '作品说明/李四/doc.pdf'],
    )
    const dl = await f.request('GET', `/api/archives/${plan.id}/download`)
    assert.equal(dl.statusCode, 200)
    const unzipped = await unzip(dl.rawPayload)
    assert.deepEqual([...unzipped.keys()], ['报名表/张三/form.pdf', '作品说明/李四/doc.pdf'])

    // 4. 计划创建后、下载前若材料规则版本发生变更，下载必须返回 409 拒绝
    const plan2Res = await f.request('POST', '/api/archives', {
      ids: allIds,
      layout: 'owner/material',
      acceptedOnly: true,
      rulesRevision: rev,
    })
    assert.equal(plan2Res.statusCode, 200)
    const plan2 = plan2Res.json() as ArchivePlan
    f.store.saveCollection({ ...c, materialRevision: 'rev-material-v2' })
    const blockedDl = await f.request('GET', `/api/archives/${plan2.id}/download`)
    assert.equal(blockedDl.statusCode, 409)

    // 5. material-owner / owner-material 规范按 participant || owner 分组（不拆大小写目录、同学名不同学号独立分组）
    const caseA: CollectedFile = {
      ...acceptedA.record,
      id: 'case-1',
      owner: 'Alice',
      name: 'a.pdf',
    }
    const caseB: CollectedFile = {
      ...acceptedA.record,
      id: 'case-2',
      owner: 'alice',
      name: 'b.pdf',
    }
    const sameName1: CollectedFile = {
      ...acceptedB.record,
      id: 'same-1',
      owner: '张伟',
      participant: 'S2026001',
      name: 's1.pdf',
    }
    const sameName2: CollectedFile = {
      ...acceptedB.record,
      id: 'same-2',
      owner: '张伟',
      participant: 'S2026002',
      name: 's2.pdf',
    }
    const normalizedPaths = archiveEntries(
      [caseA, caseB, sameName1, sameName2],
      [c],
      'material-owner',
    ).map((e) => e.path)
    assert.deepEqual(normalizedPaths, [
      '报名表/Alice/a.pdf',
      '报名表/Alice/b.pdf',
      '作品说明/S2026001/s1.pdf',
      '作品说明/S2026002/s2.pdf',
    ])

    // 6. 即使 acceptedOnly=false，计划生成后下载前若修改了文件 materialId，也必须返回 409 防落入旧目录
    f.store.saveCollection(c)
    const plan3Res = await f.request('POST', '/api/archives', {
      ids: [pendingC.record.id],
      layout: 'material/owner',
    })
    assert.equal(plan3Res.statusCode, 200)
    const plan3 = plan3Res.json() as ArchivePlan
    f.store.saveFile({ ...pendingC.record, materialId: 'mat_doc' })
    const blockedMoved = await f.request('GET', `/api/archives/${plan3.id}/download`)
    assert.equal(blockedMoved.statusCode, 409)
  } finally {
    await f.close()
  }
})

test('ZIP 计划上限仅统计活跃计划（单会话 5 个 / 全局 20 个），已结束计划 60s 过期不占活跃配额', async (t) => {
  const f = await fixture()
  try {
    const c = collection()
    f.store.saveCollection(c)
    const { record } = await f.add(c.id, 'quota.txt', '张三', Buffer.from('archive-quota-test'))

    const loginSession = async (ip: string) => {
      const login = await f.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: ip,
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { password: 'fixture-archive-password' },
      })
      assert.equal(login.statusCode, 200, login.body)
      return {
        ip,
        headers: {
          origin: 'http://127.0.0.1:3000',
          cookie: String(login.headers['set-cookie']).split(';')[0],
          'x-csrf-token': login.json().csrf as string,
        },
      }
    }

    const createPlan = (sess: { ip: string; headers: Record<string, string> }) =>
      f.app.inject({
        method: 'POST',
        url: '/api/archives',
        remoteAddress: sess.ip,
        headers: sess.headers,
        payload: { ids: [record.id], layout: 'flat' },
      })

    // 1. 单会话最多 5 个活跃计划，第 6 个返回 429；取消 1 个后可立即再创建
    const s1 = await loginSession('127.0.0.11')
    const s1Plans: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await createPlan(s1)
      assert.equal(r.statusCode, 200, `第 ${i + 1} 个计划应成功: ${r.body}`)
      s1Plans.push(r.json().id as string)
    }
    const sixth = await createPlan(s1)
    assert.equal(sixth.statusCode, 429, '同会话第 6 个活跃计划应返回 429')

    // 2. 已完成计划不占用活跃配额：下载完成后该会话立即释放 1 个活跃名额
    const dl = await f.app.inject({
      method: 'GET',
      url: `/api/archives/${s1Plans[0]}/download`,
      remoteAddress: s1.ip,
      headers: s1.headers,
    })
    assert.equal(dl.statusCode, 200)
    const afterComplete = await createPlan(s1)
    assert.equal(afterComplete.statusCode, 200, '已结束计划不应占用活跃计划名额')
    const extraReadyId = afterComplete.json().id as string

    // 3. 全局活跃计划上限为 20 个（4 个会话各 5 个活跃计划 = 20）
    const s2 = await loginSession('127.0.0.12')
    const s3 = await loginSession('127.0.0.13')
    const s4 = await loginSession('127.0.0.14')
    const s5 = await loginSession('127.0.0.15')
    for (const sess of [s2, s3, s4]) {
      for (let i = 0; i < 5; i++) {
        const r = await createPlan(sess)
        assert.equal(r.statusCode, 200, r.body)
      }
    }
    const globalBlocked = await createPlan(s5)
    assert.equal(globalBlocked.statusCode, 429, '全局已有 20 个活跃计划时新会话应返回 429')

    // 释放 1 个活跃计划后，第 5 个会话立即可创建
    await f.app.inject({
      method: 'DELETE',
      url: `/api/archives/${extraReadyId}`,
      remoteAddress: s1.ip,
      headers: s1.headers,
    })
    const globalAllowed = await createPlan(s5)
    assert.equal(globalAllowed.statusCode, 200, globalAllowed.body)

    // 4. 已结束计划使用 60s 短 TTL，61s 后自动过期返回 404，而未下载的 ready 计划在 61s 后仍有效
    const finishedBefore = await f.app.inject({
      method: 'GET',
      url: `/api/archives/${s1Plans[0]}`,
      remoteAddress: s1.ip,
      headers: s1.headers,
    })
    assert.equal(finishedBefore.statusCode, 200)
    assert.equal(finishedBefore.json().status, 'completed')

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61 * 1000 })
    const finishedAfter = await f.app.inject({
      method: 'GET',
      url: `/api/archives/${s1Plans[0]}`,
      remoteAddress: s1.ip,
      headers: s1.headers,
    })
    assert.equal(finishedAfter.statusCode, 404, '已结束计划应在 60s 后过期淘汰')

    const readyStillAlive = await f.app.inject({
      method: 'GET',
      url: `/api/archives/${s1Plans[1]}`,
      remoteAddress: s1.ip,
      headers: s1.headers,
    })
    assert.equal(readyStillAlive.statusCode, 200, '活跃 ready 计划在 61s 后应仍保持 10 分钟有效期')
    assert.equal(readyStillAlive.json().status, 'ready')
  } finally {
    t.mock.timers.reset()
    await f.close()
  }
})
