import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { Collection, CollectedFile } from '../src/types.ts'
import { materialStateVersion } from '../src/lib/materials.ts'
import { MaterialSnapshotChanged, readMaterialRows } from '../src/lib/material-state.ts'

async function fixture(prefix: string) {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, prefix))
  const config: Config = {
    dataDir: join(dir, 'data'),
    backupDir: join(dir, 'backups'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    secureCookie: false,
    quotaBytes: 4 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
  }
  return {
    config,
    cleanup: async () => {
      if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
    },
  }
}

test('SQLite会话同库重启仍有效，过期与改密撤销；不新增会话迁移', async () => {
  const { config, cleanup } = await fixture('backend-session-'),
    origin = { origin: config.origin }
  let service = await createApp(config, { serveFrontend: false })
  try {
    const setup = await service.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: origin,
      payload: {
        setupToken: service.store.setupToken(),
        displayName: '重启验证',
        password: 'synthetic-restart-password',
      },
    })
    const cookie = setup.headers['set-cookie']!.toString().split(';')[0]
    assert.match(setup.headers['set-cookie']!.toString(), /Max-Age=43200/)
    assert.equal(
      (
        await service.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })
      ).json().authenticated,
      true,
    )
    await service.app.close()
    service = await createApp(config, { serveFrontend: false })
    const after = await service.app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie },
    })
    assert.equal(after.json().authenticated, true, '未过期cookie/同数据目录无需重新登录')
    assert.equal(
      (await service.app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } }))
        .statusCode,
      200,
    )
    service.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1)
    await service.app.close()
    service = await createApp(config, { serveFrontend: false })
    assert.equal(
      (
        await service.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })
      ).json().authenticated,
      false,
    )
    assert.equal(
      (await service.app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } }))
        .statusCode,
      401,
    )
    const login = await service.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: origin,
      payload: { username: 'admin', password: 'synthetic-restart-password' },
    })
    const fresh = login.headers['set-cookie']!.toString().split(';')[0]
    const changed = await service.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...origin, cookie: fresh, 'x-csrf-token': login.json().csrf },
      payload: {
        currentPassword: 'synthetic-restart-password',
        password: 'synthetic-restart-new-password',
      },
    })
    assert.equal(changed.statusCode, 200)
    assert.equal(
      (
        await service.app.inject({
          method: 'GET',
          url: '/api/auth/status',
          headers: { cookie: fresh },
        })
      ).json().authenticated,
      false,
    )
    assert.equal(
      (
        await service.app.inject({
          method: 'GET',
          url: '/api/auth/status',
          headers: { cookie: changed.headers['set-cookie']!.toString().split(';')[0] },
        })
      ).json().authenticated,
      true,
    )
  } finally {
    await service.app.close()
    await cleanup()
  }
})

test('授权材料状态与CSV/本人回执同口径；公开错误保持状态/包络/隐私并给下一步', async () => {
  const { config, cleanup } = await fixture('backend-material-status-'),
    { app, store } = await createApp(config, { serveFrontend: false }),
    origin = { origin: config.origin }
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: origin,
      payload: {
        setupToken: store.setupToken(),
        displayName: '对齐验证',
        password: 'backend-alignment-password',
      },
    })
    const headers = {
      ...origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    const call = (
      url: string,
      payload?: object,
      method: 'GET' | 'POST' | 'PATCH' = 'POST',
      h = headers,
    ) => app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) })
    const rules = {
      title: '后端对齐合成收集',
      description: '',
      category: 'document',
      target: 8,
      deadline: '2099-12-31',
      formats: 'TXT',
      maxFileSizeMB: 2,
      maxFilesPerSubmission: 5,
      maxTotalSizeMB: 1,
      fields: [{ id: 'field_registration', label: '报名编号', required: true }],
      identityField: 'field_registration',
      expectedSubmitters: ['A01', 'A02', 'A03'],
      materials: [
        { id: 'mat_form', name: '报名表', required: true, description: '' },
        { id: 'mat_work', name: '作品说明', required: true, description: '' },
        { id: 'mat_extra', name: '附件', required: false, description: '' },
      ],
    }
    let c = (await call('/api/collections', rules)).json().collections[0] as Collection
    const key = 'r'.repeat(64),
      uploadHeaders = { ...origin, 'x-upload-key': key }
    const upload = async (person: string, contents: string[], ids: string[]) => {
      const base = `/api/public/${c.uploadToken}/uploads/${randomUUID()}`
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: base,
            headers: uploadHeaders,
            payload: {
              owner: '合成同名',
              fields: { field_registration: person },
              materialIds: ids,
              files: contents.map((s, i) => ({
                name: `${person}-${i}.txt`,
                size: Buffer.byteLength(s),
                lastModified: 1,
              })),
            },
          })
        ).statusCode,
        200,
      )
      for (let i = 0; i < contents.length; i++) {
        const bytes = Buffer.from(contents[i])
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: `${base}/${i}/0`,
              headers: {
                ...uploadHeaders,
                'content-type': 'application/octet-stream',
                'x-chunk-sha256': createHash('sha256').update(bytes).digest('hex'),
              },
              payload: bytes,
            })
          ).statusCode,
          200,
        )
      }
      const saved = await app.inject({
        method: 'POST',
        url: `${base}/complete`,
        headers: uploadHeaders,
        payload: {},
      })
      assert.equal(saved.statusCode, 201)
      return saved.json()
    }
    const receipt = await upload('A01', ['A01报名表', 'A01作品说明'], ['mat_form', 'mat_work'])
    await upload('A02', ['尚未明确归属'], [''])
    await upload('A03', ['相同内容', '相同内容'], ['mat_form', 'mat_work'])
    const url = `/api/collections/${c.id}/materials`
    const first = (await call(url, undefined, 'GET')).json()
    const joined = await readMaterialRows(first, c, store.files())
    assert.equal(joined.find((p) => p.identity === 'A03')?.receivedComplete, false)
    assert.equal(joined.find((p) => p.identity === 'A02')?.unclassified.length, 1)
    await assert.rejects(
      readMaterialRows(first, { ...c, id: 'other-task' }, store.files()),
      MaterialSnapshotChanged,
    )
    await assert.rejects(
      readMaterialRows({ ...first, rulesRevision: 7 }, c, store.files()),
      MaterialSnapshotChanged,
    )
    await assert.rejects(
      readMaterialRows({ ...first, stateVersion: 'f'.repeat(64) }, c, store.files()),
      MaterialSnapshotChanged,
    )
    await assert.rejects(
      readMaterialRows(first, { ...c, expectedSubmitters: ['new-roster'] }, store.files()),
      MaterialSnapshotChanged,
    )
    assert.deepEqual(first.summary, {
      participants: 3,
      receivedComplete: 1,
      reviewComplete: 0,
      missing: 2,
      needsChanges: 0,
      unclassified: 1,
    })
    assert.equal(
      first.participants.find((p: { identity: string }) => p.identity === 'A03').duplicateCount,
      1,
    )
    assert.equal(first.participants[0].slots[2].label, '选填未交')
    assert.equal(
      (await call(url, undefined, 'GET')).json().stateVersion,
      first.stateVersion,
      '读取时刻不假造业务变更版本',
    )
    assert.equal((await call(`${url}?revision=old`, undefined, 'GET')).statusCode, 409)
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401)
    const files = store.files().filter((f) => f.participant === 'A01')
    const review = (f: CollectedFile, decision: string, note: string) =>
      call('/api/materials/review', {
        collectionId: c.id,
        rulesRevision: c.materialRevision,
        requestId: randomUUID(),
        files: [{ id: f.id, expectedVersion: materialStateVersion(f) }],
        decision,
        note,
      })
    assert.equal(
      (
        await review(
          files.find((f) => f.materialId === 'mat_form')!,
          'needs_changes',
          '请补全本次报名信息',
        )
      ).statusCode,
      200,
    )
    assert.equal(
      (await review(files.find((f) => f.materialId === 'mat_work')!, 'accepted', '')).statusCode,
      200,
    )
    const current = (await call(url, undefined, 'GET')).json()
    await assert.rejects(
      readMaterialRows(first, c, store.files()),
      MaterialSnapshotChanged,
      '旧文件核对版本不能接回当前矩阵',
    )
    assert.equal(
      (await readMaterialRows(current, c, store.files())).find((p) => p.identity === 'A01')?.status,
      'needs_changes',
    )
    assert.equal(current.summary.needsChanges, 1)
    assert.equal(current.summary.reviewComplete, 0)
    assert.notEqual(current.stateVersion, first.stateVersion)
    const own = await app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${receipt.receiptId}`,
      headers: { 'x-receipt-key': key },
    })
    for (const f of own.json().files) {
      const backend = current.files.find((x: { id: string }) => x.id === f.id)
      assert.equal(f.materialState, backend.materialState)
      assert.equal(f.materialNote, backend.materialNote)
    }
    assert.equal(own.body.includes('A02'), false)
    assert.equal(own.body.includes('reviewerId'), false)
    const csv = await call(`${url}/export?revision=${c.materialRevision}`, undefined, 'GET')
    const rows = csv.body
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"')))
    assert.ok(
      rows.some(
        (r) =>
          r[2] === 'A01' &&
          r[7] === '报名表' &&
          r[9] === '需补充' &&
          r[12] === '请补全本次报名信息',
      ),
    )
    assert.ok(rows.some((r) => r[2] === 'A01' && r[7] === '作品说明' && r[9] === '核对通过'))
    assert.ok(rows.some((r) => r[2] === 'A02' && r[9] === '未分类'))
    const versionBeforeRoster = current.stateVersion
    await call(
      `/api/collections/${c.id}`,
      { ...rules, expectedSubmitters: [...rules.expectedSubmitters, 'A04'] },
      'PATCH',
    )
    const roster = (await call(url, undefined, 'GET')).json()
    assert.equal(roster.rulesRevision, c.materialRevision)
    assert.notEqual(roster.stateVersion, versionBeforeRoster)
    assert.equal(roster.summary.missing, 3)
    await call(`/api/collections/${c.id}`, { ...rules, description: '新的材料要求' }, 'PATCH')
    c = store.collection(c.id)!
    assert.equal(
      (await call(url, undefined, 'GET'))
        .json()
        .files.filter((f: { materialState: string }) => f.materialState === 'stale').length,
      2,
    )
    const badLink = await app.inject({ method: 'GET', url: '/api/public/not-a-valid-link' })
    assert.equal(badLink.statusCode, 404)
    assert.deepEqual(Object.keys(badLink.json()), ['error'])
    assert.match(badLink.json().error, /获取新链接/)
    const badReceipt = await app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${receipt.receiptId}`,
      headers: { 'x-receipt-key': 'wrong'.repeat(10) },
    })
    assert.equal(badReceipt.statusCode, 403)
    assert.match(badReceipt.json().error, /请/)
    assert.equal(badReceipt.body.includes('A01'), false)
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`,
      headers: uploadHeaders,
      payload: { owner: '提交者', files: [], fields: { field_registration: 'A05' } },
    })
    assert.equal(invalid.statusCode, 400)
    assert.match(invalid.json().error, /减少文件/)
    const full = await app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`,
      headers: uploadHeaders,
      payload: {
        owner: '提交者',
        files: [{ name: '大文件.txt', size: 2 * 1024 ** 2, lastModified: 1 }],
        fields: { field_registration: 'A05' },
        materialIds: ['mat_form'],
      },
    })
    assert.equal(full.statusCode, 413)
    assert.match(full.json().error, /联系发起人/)
    assert.equal((await call('/api/ai/settings', undefined, 'GET')).json().testMode, false)
    const deniedDemo = await call('/api/ai/collection-draft', {
      prompt: '收集报名表和作品说明',
      consent: true,
      settingsRevision: 'old',
      testMode: true,
    })
    assert.equal(deniedDemo.statusCode, 400, '公开参数不能开启演示传输；正常实例仍未配置模型')
    assert.equal(store.files().length, 5)
    await call('/api/users', {
      username: 'status-reader',
      displayName: '状态只读',
      role: 'viewer',
      password: 'status-reader-password',
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: origin,
      payload: { username: 'status-reader', password: 'status-reader-password' },
    })
    const viewer = {
      ...origin,
      cookie: login.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': login.json().csrf,
    }
    assert.equal((await call(url, undefined, 'GET', viewer)).statusCode, 200)
    assert.equal((await call('/api/materials/review', {}, 'POST', viewer)).statusCode, 403)
  } finally {
    await app.close()
    await cleanup()
  }
})
