import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import { materialParticipants, materialStateVersion, materialReviewState } from '../src/lib/materials.ts'
import { createBackup, restoreBackup } from './backup.ts'
import { Store } from './store.ts'
import type { Collection, CollectedFile, UploadReceipt } from '../src/types.ts'
import type { Config } from './config.ts'

test('逐人逐材料：缺件、未分类、重复、人工纠正、补交替换、版本失效和权限原子闭环', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'materials-test-'))
  const config: Config = { dataDir: join(dir, 'data'), host: '127.0.0.1', port: 0, origin: 'http://127.0.0.1:3000', quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2, secureCookie: false }
  const service = await createApp(config, { serveFrontend: false }), { app, store } = service
  const origin = { origin: config.origin }, secret = 'm'.repeat(64)
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: origin, payload: { setupToken: store.setupToken(), displayName: '材料规则验收', password: 'materials-test-password' } })
    const headers = { ...origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const rules = { title: '合成社团作品征集', category: 'document', description: '本次活动报名表与作品说明均须提交，附件选填。', formats: 'TXT', deadline: '2099-12-31', target: 8, maxFileSizeMB: 1, maxFilesPerSubmission: 5, fields: [{ id: 'field_student', label: '报名编号', required: true }], identityField: 'field_student', expectedSubmitters: ['A01', 'A02', 'A03', 'A04'], materials: [{ id: 'mat_form', name: '报名表', description: '本次社团活动报名信息', required: true }, { id: 'mat_statement', name: '作品说明', description: '本次活动的作品介绍', required: true }, { id: 'mat_extra', name: '补充附件', description: '选填，不影响必需项是否收齐', required: false }] }
    const created = await app.inject({ method: 'POST', url: '/api/collections', headers, payload: rules })
    assert.equal(created.statusCode, 200, created.body)
    let c = created.json().collections[0] as Collection
    const expected = { A01: { receivedComplete: true, reviewComplete: false, unknown: 0, duplicates: 0 }, A02: { receivedComplete: false, reviewComplete: false, unknown: 0, duplicates: 0 }, A03: { receivedComplete: false, reviewComplete: false, unknown: 1, duplicates: 0 }, A04: { receivedComplete: false, reviewComplete: false, unknown: 0, duplicates: 1 } }
    await writeFile(join(dir, 'independent-expected.json'), JSON.stringify(expected))
    const upload = async (person: string, contents: string[], materialIds: string[], replace?: { receiptId: string; key: string }) => {
      const url = `/api/public/${c.uploadToken}/uploads/${randomUUID()}`, h = { ...origin, 'x-upload-key': secret }
      const response = await app.inject({ method: 'POST', url, headers: h, payload: { owner: '同名同学', fields: { field_student: person }, files: contents.map((s, i) => ({ name: `${person}-${i}.txt`, size: Buffer.byteLength(s), lastModified: 1 })), materialIds, ...(replace ? { replace } : {}) } })
      assert.equal(response.statusCode, 200, response.body)
      for (let i = 0; i < contents.length; i++) {
        const content = Buffer.from(contents[i]), r = await app.inject({ method: 'PUT', url: `${url}/${i}/0`, headers: { ...h, 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(content).digest('hex') }, payload: content })
        assert.equal(r.statusCode, 200, r.body)
      }
      const complete = await app.inject({ method: 'POST', url: `${url}/complete`, headers: h, payload: {} })
      assert.equal(complete.statusCode, 201, complete.body)
      return complete.json() as UploadReceipt
    }
    const receipts = [await upload('A01', ['A01 报名表', 'A01 作品说明'], ['mat_form', 'mat_statement']), await upload('A02', ['A02 报名表'], ['mat_form']), await upload('A03', ['A03 报名表', 'A03 作品说明'], ['', 'mat_form']), await upload('A04', ['重复内容', '重复内容'], ['mat_form', 'mat_statement'])]
    const report = () => materialParticipants(store.collection(c.id)!, store.files())
    for (const person of report()) {
      const e = expected[person.identity as keyof typeof expected]
      assert.deepEqual({ receivedComplete: person.receivedComplete, reviewComplete: person.reviewComplete, unknown: person.unclassified.length, duplicates: person.duplicateCount }, e)
    }
    // Read the actual exported CSV with an independent CSV parser, never the aggregation helper.
    const exported = await app.inject({ method: 'GET', url: `/api/collections/${c.id}/materials/export?revision=${c.materialRevision}`, headers })
    assert.equal(exported.statusCode, 200)
    const csvRows = [...exported.body.replace(/^\uFEFF/, '').matchAll(/(?:^|\r\n)((?:"(?:[^"]|"")*"(?:,|(?=\r\n|$)))+)/g)].map(match => [...match[1].matchAll(/"((?:[^"]|"")*)"/g)].map(cell => cell[1].replaceAll('""', '"')))
    assert.deepEqual(csvRows[0], ['任务', '规则版本', '参与标识', '姓名', '名单内', '必需项收齐', '人工核对通过', '材料项', '必需', '当前状态', '文件名', '文件版本', '核对说明'])
    for (const [identity, e] of Object.entries(expected)) {
      const lines = csvRows.slice(1).filter(row => row[2] === identity)
      assert.ok(lines.length >= 3)
      assert.equal(lines.every(row => row[5] === (e.receivedComplete ? '是' : '否') && row[6] === '否'), true)
    }
    assert.ok(csvRows.some(row => row[2] === 'A03' && row[9] === '未分类'))
    assert.ok(csvRows.some(row => row[2] === 'A02' && row[7] === '作品说明' && row[9] === '缺项'))
    assert.equal(exported.body.includes(secret), false)
    assert.equal((await app.inject({ method: 'GET', url: `/api/collections/${c.id}/materials/export?revision=outdated`, headers })).statusCode, 409)
    assert.equal((await app.inject({ method: 'GET', url: `/api/collections/${c.id}/materials/export?revision=${c.materialRevision}` })).statusCode, 401)
    const invalidMaterial = await app.inject({ method: 'POST', url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`, headers: { ...origin, 'x-upload-key': secret }, payload: { owner: '分类校验', fields: { field_student: 'A05' }, files: [{ name: 'wrong.txt', size: 1, lastModified: 1 }], materialIds: ['mat_removed'] } })
    assert.equal(invalidMaterial.statusCode, 400)
    const personFiles = (person: string) => store.files().filter(f => f.collectionId === c.id && f.participant === person && !f.deletedAt)
    const action = (files: CollectedFile[], kind = 'review', extra: Record<string, unknown> = {}) => ({ collectionId: c.id, rulesRevision: store.collection(c.id)!.materialRevision, requestId: randomUUID(), files: files.map(f => ({ id: f.id, expectedVersion: materialStateVersion(f), ...(kind === 'classify' ? { materialId: f.materialId || '' } : {}) })), ...(kind === 'review' ? { decision: 'accepted', note: '' } : {}), ...extra })
    const call = (kind: string, body: unknown, h = headers) => app.inject({ method: 'POST', url: `/api/materials/${kind}`, headers: h, payload: body as Record<string, unknown> })
    const initialReview = action(personFiles('A01'))
    assert.equal((await call('review', initialReview)).statusCode, 200)
    assert.equal((await call('review', initialReview)).statusCode, 200, '同一操作重试幂等')
    assert.equal(report().find(p => p.identity === 'A01')!.reviewComplete, true)
    assert.equal((await call('review', { ...initialReview, note: '复用编号改变内容' })).statusCode, 409)
    assert.equal((await call('review', action(personFiles('A04')))).statusCode, 200)
    assert.equal(report().find(p => p.identity === 'A04')!.receivedComplete, false, '相同内容不能充当两个不同必需项')
    const unknown = personFiles('A03').find(f => !f.materialId)!
    assert.equal((await call('review', action([unknown]))).statusCode, 400)
    const wrong = personFiles('A03').find(f => !!f.materialId)!
    assert.equal((await call('review', action([wrong], 'review', { decision: 'needs_changes', note: '此文件是作品说明，请纠正归属。' }))).statusCode, 200)
    const correctionFiles = personFiles('A03'), correction = action(correctionFiles, 'classify', { files: correctionFiles.map(f => ({ id: f.id, expectedVersion: materialStateVersion(f), materialId: f.id === unknown.id ? 'mat_form' : 'mat_statement' })) })
    assert.equal((await call('classify', correction)).statusCode, 200)
    assert.equal((await call('classify', correction)).statusCode, 200)
    assert.equal(report().find(p => p.identity === 'A03')!.receivedComplete, true)
    assert.equal(materialReviewState(store.collection(c.id)!, personFiles('A03').find(f => f.id === wrong.id)!), 'stale')
    const a2Old = personFiles('A02')[0]
    assert.equal((await call('review', action([a2Old]))).statusCode, 200)
    await upload('A02', ['A02 补交作品说明'], ['mat_statement'])
    assert.equal(report().find(p => p.identity === 'A02')!.receivedComplete, true)
    assert.equal(report().find(p => p.identity === 'A02')!.reviewComplete, false)
    await upload('A04', ['A04 新报名表', 'A04 新作品说明'], ['mat_form', 'mat_statement'], { receiptId: receipts[3].receiptId, key: secret })
    assert.equal(report().find(p => p.identity === 'A04')!.receivedComplete, true)
    assert.equal(report().find(p => p.identity === 'A04')!.reviewComplete, false, '替换文件不继承原批准')
    assert.equal(store.files().filter(f => f.participant === 'A04' && f.deletedAt).length, 2)
    const beforeRule = store.collection(c.id)!.materialRevision, delayed = action(personFiles('A01'))
    const patched = await app.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, headers, payload: { ...rules, description: '要求变更：作品说明需包含本次活动名称。' } })
    assert.equal(patched.statusCode, 200, patched.body); c = store.collection(c.id)!
    assert.notEqual(c.materialRevision, beforeRule)
    assert.equal((await call('review', delayed)).statusCode, 409)
    assert.equal(materialReviewState(c, personFiles('A01')[0]), 'stale')
    await app.inject({ method: 'PATCH', url: `/api/collections/${c.id}`, headers, payload: rules })
    assert.notEqual(store.collection(c.id)!.materialRevision, beforeRule, '恢复旧规则也不能复活旧结论')
    const concurrent = action(personFiles('A01'))
    const race = await Promise.all([call('review', concurrent), call('review', { ...concurrent, requestId: randomUUID(), decision: 'needs_changes', note: '不同核对者的后到操作' })])
    assert.deepEqual(race.map(r => r.statusCode).sort(), [200, 409])
    const a3 = personFiles('A03'), before = a3.map(f => f.materialReview?.operationId)
    const mixed = action(a3); mixed.files[1].expectedVersion = 'stale'
    assert.equal((await call('review', mixed)).statusCode, 409)
    assert.deepEqual(personFiles('A03').map(f => f.materialReview?.operationId), before, '批量任一冲突时不半笔核对')
    const authless = await app.inject({ method: 'POST', url: '/api/materials/review', headers: origin, payload: action(a3) })
    assert.equal(authless.statusCode, 401)
    await app.inject({ method: 'POST', url: '/api/users', headers, payload: { username: 'readmat', displayName: '只读验收', role: 'viewer', password: 'material-viewer-password' } })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: origin, payload: { username: 'readmat', password: 'material-viewer-password' } })
    const viewer = { ...origin, cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': login.json().csrf }
    assert.equal((await call('review', action(a3), viewer)).statusCode, 403)
    const publicInfo = await app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}` })
    assert.equal(publicInfo.json().collection.expectedSubmitters, undefined)
    const own = await app.inject({ method: 'GET', url: `/api/public/${c.uploadToken}/receipts/${receipts[0].receiptId}`, headers: { 'x-receipt-key': secret } })
    assert.equal(own.json().files.length, 2)
    assert.equal(own.json().files.some((f: { materialReview?: unknown }) => f.materialReview), false)
    assert.equal(own.body.includes('A02'), false)
    const approved = personFiles('A01')[0]
    await app.inject({ method: 'POST', url: '/api/files/trash', headers, payload: { ids: [approved.id] } })
    await app.inject({ method: 'POST', url: '/api/files/restore', headers, payload: { ids: [approved.id] } })
    assert.equal(materialReviewState(store.collection(c.id)!, personFiles('A01').find(f => f.id === approved.id)!), 'stale')
    const template = await app.inject({ method: 'POST', url: '/api/templates', headers, payload: { name: '材料模板', collectionId: c.id } })
    assert.equal(template.json().rules.materials.length, 3); assert.equal(template.json().rules.materialRevision, undefined)
    await app.close(); await createBackup(config.dataDir, join(dir, 'backup')); await restoreBackup(join(dir, 'backup'), join(dir, 'restored'))
    const restored = new Store(join(dir, 'restored'))
    try { assert.equal(restored.collection(c.id)!.materials!.length, 3); assert.equal(restored.files().filter(f => f.materialReview).length > 0, true); assert.equal(await readFile(join(dir, 'independent-expected.json'), 'utf8'), JSON.stringify(expected)) } finally { restored.close() }
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
