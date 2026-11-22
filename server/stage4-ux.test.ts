import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { Collection, ReceiptDetail, Workspace } from '../src/types.ts'

async function boot() {
  const root = resolve('.tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'stage4-ux-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 20 * 1024 ** 2,
    requestBytes: 4 * 1024 ** 2,
    secureCookie: false,
  }
  const { app, store, webhooks } = await createApp(config, { serveFrontend: false })
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin: config.origin },
    payload: {
      setupToken: store.setupToken(),
      displayName: '主管老师',
      password: 'AdminPassword123!',
    },
  })
  const cookie = String(setup.headers['set-cookie']).split(';')[0]
  const csrf = setup.json().csrf as string
  const adminHeaders = { origin: config.origin, cookie, 'x-csrf-token': csrf }
  return {
    dir,
    config,
    app,
    store,
    webhooks,
    adminHeaders,
    cleanup: async () => {
      await app.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function buildMultipart(
  boundary: string,
  fields: Record<string, string>,
  files: { name: string; bytes: Buffer }[],
) {
  const chunks: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    )
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      f.bytes,
      Buffer.from('\r\n'),
    )
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

test('J3.1 一键复制任务（Clone）与归档/取消归档（Archive）全流程', async () => {
  const ctx = await boot()
  try {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: ctx.adminHeaders,
      payload: {
        title: '春季奖学金申报',
        description: '请按材料清单提交',
        category: 'document',
        target: 50,
        deadline: '2099-06-30',
        formats: 'PDF, DOCX',
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
        fields: [{ id: 'field_sid', label: '学号', required: true }],
        identityField: 'field_sid',
        expectedSubmitters: ['202601', '202602'],
        restrictToExpectedSubmitters: true,
        accessCode: 'Abcd12',
        naming: { parts: ['collection', 'field_sid', 'owner', 'material'], separator: '_' },
        materials: [
          { id: 'mat_form', name: '申请表', required: true, description: '需签字' },
          { id: 'mat_cert', name: '成绩单', required: true, description: '盖章扫描件' },
        ],
      },
    })
    assert.equal(created.statusCode, 200, created.body)
    const orig = (created.json() as Workspace).collections[0]

    // 1. 一键复制：不继承旧提取码、重置 received=0、生成新 token、可选择不复制名单
    const clonedRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${orig.id}/clone`,
      headers: ctx.adminHeaders,
      payload: {
        title: '秋季奖学金申报',
        deadline: '2099-12-31',
        includeExpectedSubmitters: false,
      },
    })
    assert.equal(clonedRes.statusCode, 201, clonedRes.body)
    const cloned = clonedRes.json().collection as Collection
    assert.notEqual(cloned.id, orig.id)
    assert.notEqual(cloned.uploadToken, orig.uploadToken)
    assert.equal(cloned.title, '秋季奖学金申报')
    assert.equal(cloned.deadline, '2099-12-31')
    assert.equal(cloned.received, 0)
    assert.equal(cloned.status, 'active')
    assert.equal(cloned.hasAccessCode, false, '复制任务不得隐式继承旧提取码')
    assert.deepEqual(cloned.expectedSubmitters, [])
    assert.equal(cloned.restrictToExpectedSubmitters, false)
    assert.equal(cloned.materials?.length, 2)
    assert.deepEqual(cloned.naming, orig.naming)

    // 2. 归档任务：自动暂停公开提交，且不可在归档状态直接重新开放
    const archivedRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${cloned.id}/archive`,
      headers: ctx.adminHeaders,
      payload: { archived: true },
    })
    assert.equal(archivedRes.statusCode, 200)
    const archivedCol = (archivedRes.json() as Workspace).collections.find(
      (c) => c.id === cloned.id,
    )!
    assert.ok(archivedCol.archivedAt)
    assert.equal(archivedCol.status, 'paused')

    // 归档后公开上传必须返回 410
    const blockedUpload = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/${cloned.uploadToken}/uploads/${randomUUID()}`,
      headers: { origin: ctx.config.origin, 'x-upload-key': 'k'.repeat(40) },
      payload: {
        owner: '张三',
        fields: { field_sid: '202601' },
        files: [{ name: 'a.pdf', size: 10, lastModified: 1 }],
        materialIds: ['mat_form'],
      },
    })
    assert.equal(blockedUpload.statusCode, 410)

    // 归档状态尝试直接重新开放返回 409
    const reopenWhileArchived = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${cloned.id}/status`,
      headers: ctx.adminHeaders,
      payload: { status: 'active' },
    })
    assert.equal(reopenWhileArchived.statusCode, 409)

    // 3. 取消归档后可重新开放
    const unarchivedRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${cloned.id}/archive`,
      headers: ctx.adminHeaders,
      payload: { archived: false },
    })
    assert.equal(unarchivedRes.statusCode, 200)
    const restoredCol = (unarchivedRes.json() as Workspace).collections.find(
      (c) => c.id === cloned.id,
    )!
    assert.equal(restoredCol.archivedAt, undefined)
    const reopenOk = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${cloned.id}/status`,
      headers: ctx.adminHeaders,
      payload: { status: 'active' },
    })
    assert.equal(reopenOk.statusCode, 200)
  } finally {
    await ctx.cleanup()
  }
})

test('J3.3 提交人私密回执缺项总览：跨批次汇总本人在当前任务全部材料槽位进度与退回原因，零他人泄露', async () => {
  const ctx = await boot()
  try {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: ctx.adminHeaders,
      payload: {
        title: '社团立项材料',
        description: '',
        category: 'document',
        target: 20,
        deadline: '2099-12-31',
        formats: 'TXT, PDF',
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 5,
        fields: [{ id: 'field_code', label: '学号', required: true }],
        identityField: 'field_code',
        materials: [
          { id: 'mat_plan', name: '立项书', required: true, description: '必需' },
          { id: 'mat_budget', name: '预算表', required: true, description: '必需' },
          { id: 'mat_extra', name: '补充附件', required: false, description: '选填' },
        ],
      },
    })
    const c = (created.json() as Workspace).collections[0]

    const submitBatch = async (
      owner: string,
      code: string,
      fileName: string,
      content: string,
      materialId: string,
      uploadKey: string,
      parentReceipt?: { receiptId: string; key: string },
    ) => {
      const batchId = randomUUID()
      const bytes = Buffer.from(content, 'utf8')
      const base = `/api/public/${c.uploadToken}/uploads/${batchId}`
      const headers = { origin: ctx.config.origin, 'x-upload-key': uploadKey }
      const init = await ctx.app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: {
          owner,
          fields: { field_code: code },
          files: [{ name: fileName, size: bytes.length, lastModified: 1 }],
          materialIds: [materialId],
          ...(parentReceipt ? { parentReceipt } : {}),
        },
      })
      assert.equal(init.statusCode, 200, init.body)
      const put = await ctx.app.inject({
        method: 'PUT',
        url: `${base}/0/0`,
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'x-chunk-sha256': createHash('sha256').update(bytes).digest('hex'),
        },
        payload: bytes,
      })
      assert.equal(put.statusCode, 200, put.body)
      const done = await ctx.app.inject({
        method: 'POST',
        url: `${base}/complete`,
        headers,
        payload: {},
      })
      assert.equal(done.statusCode, 201, done.body)
      return done.json().receiptId as string
    }

    const keyA1 = 'a'.repeat(40)
    const keyA2 = 'b'.repeat(40)
    const keyB1 = 'c'.repeat(40)
    const keyAttacker = 'd'.repeat(40)

    // 提交人 A 第 1 批交立项书，提交人 B 交预算表
    const receiptA1 = await submitBatch('同学甲', 'STU01', 'plan.txt', 'plan-v1', 'mat_plan', keyA1)
    await submitBatch('同学乙', 'STU02', 'other.txt', 'other-budget', 'mat_budget', keyB1)

    // 查回执 A1：应看到立项书待审核、预算表缺失、补充附件选填未交，且绝不包含同学乙的文件
    const r1Res = await ctx.app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${receiptA1}`,
      headers: { 'x-receipt-key': keyA1 },
    })
    assert.equal(r1Res.statusCode, 200, r1Res.body)
    const r1 = r1Res.json() as ReceiptDetail
    assert.ok(r1.materialOverview)
    assert.equal(r1.materialOverview.identity, 'STU01')
    assert.equal(r1.materialOverview.linkedBatches, 1)
    assert.equal(r1.materialOverview.requiredTotal, 2)
    assert.equal(r1.materialOverview.requiredSubmitted, 1)
    assert.deepEqual(r1.materialOverview.missingRequired, ['预算表'])
    assert.equal(r1Res.body.includes('other.txt'), false, '私密回执不得泄露他人文件')

    // 提交人 A 第 2 批凭原回执 A1 凭证续交预算表（建立可信回执链）
    const receiptA2 = await submitBatch(
      '同学甲',
      'STU01',
      'budget.txt',
      'budget-v1',
      'mat_budget',
      keyA2,
      { receiptId: receiptA1, key: keyA1 },
    )

    // 管理员替 STU01 线下补录一份附件（不得暴露给任何未验权冒充者）
    const offlineBoundary = 'offline-idor-check'
    const offlineBody = buildMultipart(
      offlineBoundary,
      {
        owner: '同学甲',
        fields: JSON.stringify({ field_code: 'STU01' }),
        materialIds: JSON.stringify(['mat_extra']),
        note: '管理员线下代传私密件',
      },
      [{ name: 'offline-secret.txt', bytes: Buffer.from('offline-secret-body') }],
    )
    const offlineRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/offline-upload`,
      headers: {
        ...ctx.adminHeaders,
        'content-type': `multipart/form-data; boundary=${offlineBoundary}`,
      },
      payload: offlineBody,
    })
    assert.equal(offlineRes.statusCode, 201, offlineRes.body)

    // 管理员审核：立项书通过，预算表退回并附私密原因
    const reportRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/collections/${c.id}/materials`,
      headers: { cookie: ctx.adminHeaders.cookie },
    })
    const report = reportRes.json() as {
      rulesRevision: string
      files: { id: string; materialId: string; expectedVersion: string }[]
    }
    const planFile = report.files.find(
      (f) => f.materialId === 'mat_plan' && ctx.store.file(f.id)?.participant === 'STU01',
    )!
    const budgetFile = report.files.find(
      (f) => f.materialId === 'mat_budget' && ctx.store.file(f.id)?.participant === 'STU01',
    )!

    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/materials/review',
          headers: ctx.adminHeaders,
          payload: {
            collectionId: c.id,
            rulesRevision: report.rulesRevision,
            requestId: randomUUID(),
            files: [{ id: planFile.id, expectedVersion: planFile.expectedVersion }],
            decision: 'accepted',
            note: '符合要求',
          },
        })
      ).statusCode,
      200,
    )
    assert.equal(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/materials/review',
          headers: ctx.adminHeaders,
          payload: {
            collectionId: c.id,
            rulesRevision: report.rulesRevision,
            requestId: randomUUID(),
            files: [{ id: budgetFile.id, expectedVersion: budgetFile.expectedVersion }],
            decision: 'needs_changes',
            note: '预算缺少指导老师签字页',
          },
        })
      ).statusCode,
      200,
    )

    // 凭回执 A2 查询：因已通过 parentReceipt 绑定回执 A1，可见 A1+A2 两批槽位进度及最新退回原因，但不泄露线下独立补录文件
    const r2Res = await ctx.app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${receiptA2}`,
      headers: { 'x-receipt-key': keyA2 },
    })
    assert.equal(r2Res.statusCode, 200)
    const ov = (r2Res.json() as ReceiptDetail).materialOverview!
    assert.equal(ov.linkedBatches, 2)
    assert.equal(ov.status, 'needs_changes')
    assert.equal(ov.acceptedCount, 1)
    assert.equal(ov.needsChangesCount, 1)
    assert.deepEqual(ov.missingRequired, [])
    const planSlot = ov.slots.find((s) => s.materialId === 'mat_plan')!
    const budgetSlot = ov.slots.find((s) => s.materialId === 'mat_budget')!
    const extraSlot = ov.slots.find((s) => s.materialId === 'mat_extra')!
    assert.equal(planSlot.state, 'accepted')
    assert.equal(planSlot.files[0].inCurrentBatch, false, '先前批次文件应标明非本批')
    assert.equal(budgetSlot.state, 'needs_changes')
    assert.equal(budgetSlot.latestNote, '预算缺少指导老师签字页')
    assert.equal(budgetSlot.files[0].inCurrentBatch, true)
    assert.equal(extraSlot.state, 'missing')
    assert.equal(extraSlot.required, false)
    assert.equal(r2Res.body.includes('offline-secret.txt'), false, '未链入的线下补录不得泄露')

    // 【P0-1 跨用户 IDOR 冒充拦截回归】攻击者冒用相同学号 STU01 独立提交一份文件
    const attackerReceipt = await submitBatch(
      '冒充者',
      'STU01',
      'attacker-probe.txt',
      'probe-payload',
      'mat_extra',
      keyAttacker,
    )
    const attackerRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${attackerReceipt}`,
      headers: { 'x-receipt-key': keyAttacker },
    })
    assert.equal(attackerRes.statusCode, 200, attackerRes.body)
    assert.equal(attackerRes.body.includes('plan.txt'), false, 'IDOR 防护：不得泄露受害者立项书')
    assert.equal(attackerRes.body.includes('budget.txt'), false, 'IDOR 防护：不得泄露受害者预算表')
    assert.equal(
      attackerRes.body.includes('预算缺少指导老师签字页'),
      false,
      'IDOR 防护：不得泄露管理员私密退回批注',
    )
    assert.equal(
      attackerRes.body.includes('offline-secret.txt'),
      false,
      'IDOR 防护：不得泄露管理员线下补录文件',
    )
    const attackerOv = (attackerRes.json() as ReceiptDetail).materialOverview!
    assert.equal(attackerOv.linkedBatches, 1)
    assert.equal(attackerOv.requiredSubmitted, 0)
    assert.deepEqual(attackerOv.missingRequired, ['立项书', '预算表'])

    // 伪造 parentReceipt 凭证或跨身份挂接必须返回 403
    const forgedParent = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`,
      headers: { origin: ctx.config.origin, 'x-upload-key': 'e'.repeat(40) },
      payload: {
        owner: '冒充者',
        fields: { field_code: 'STU01' },
        files: [{ name: 'x.txt', size: 4, lastModified: 1 }],
        materialIds: ['mat_plan'],
        parentReceipt: { receiptId: receiptA1, key: 'z'.repeat(40) },
      },
    })
    assert.equal(forgedParent.statusCode, 403)

    const crossIdentityParent = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/${c.uploadToken}/uploads/${randomUUID()}`,
      headers: { origin: ctx.config.origin, 'x-upload-key': 'f'.repeat(40) },
      payload: {
        owner: '串人者',
        fields: { field_code: 'STU99' },
        files: [{ name: 'x.txt', size: 4, lastModified: 1 }],
        materialIds: ['mat_plan'],
        parentReceipt: { receiptId: receiptA1, key: keyA1 },
      },
    })
    assert.equal(crossIdentityParent.statusCode, 403)

    // 【P0-1 附带修复】规则变化导致核对记录进入 stale 后，单批 files[] 与总览均须过滤过期批注
    const ruleUpdate = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/collections/${c.id}`,
      headers: ctx.adminHeaders,
      payload: {
        title: c.title,
        description: '更新后的材料规则说明',
        category: c.category,
        target: c.target,
        deadline: c.deadline,
        formats: c.formats,
        maxFileSizeMB: c.maxFileSizeMB,
        maxFilesPerSubmission: c.maxFilesPerSubmission,
        fields: c.fields,
        identityField: c.identityField,
        materials: c.materials,
      },
    })
    assert.equal(ruleUpdate.statusCode, 200, ruleUpdate.body)
    const staleRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/public/${c.uploadToken}/receipts/${receiptA2}`,
      headers: { 'x-receipt-key': keyA2 },
    })
    assert.equal(staleRes.statusCode, 200)
    const staleBody = staleRes.json() as ReceiptDetail
    assert.equal(staleBody.files[0].materialState, 'stale')
    assert.equal(staleBody.files[0].materialNote, '', '单批 files[] 须过滤 stale 过期批注')
    assert.equal(
      staleBody.materialOverview!.slots.find((s) => s.materialId === 'mat_budget')!.latestNote,
      '',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('J3.4 管理员线下补录文件：仅限管理员、无视暂停截止、自动套用任务命名规则且拒绝归档任务', async () => {
  const ctx = await boot()
  try {
    // 创建编辑者，校验无权调用线下补录
    await ctx.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: ctx.adminHeaders,
      payload: {
        username: 'ed_offline',
        displayName: '编辑同事',
        password: 'EditorPassword123!',
        role: 'editor',
      },
    })
    const edLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ctx.config.origin },
      payload: { username: 'ed_offline', password: 'EditorPassword123!' },
    })
    const edHeaders = {
      origin: ctx.config.origin,
      cookie: String(edLogin.headers['set-cookie']).split(';')[0],
      'x-csrf-token': edLogin.json().csrf as string,
    }

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: ctx.adminHeaders,
      payload: {
        title: '期末作品',
        description: '',
        category: 'document',
        target: 10,
        deadline: '2099-12-31',
        formats: 'PDF, TXT',
        maxFileSizeMB: 5,
        maxFilesPerSubmission: 5,
        fields: [{ id: 'field_sid', label: '学号', required: true }],
        identityField: 'field_sid',
        naming: { parts: ['collection', 'field_sid', 'owner', 'material'], separator: '_' },
        materials: [{ id: 'mat_report', name: '实验报告', required: true, description: '' }],
      },
    })
    const c = (created.json() as Workspace).collections[0]

    // 暂停收集后，管理员仍可线下补录
    await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/status`,
      headers: ctx.adminHeaders,
      payload: { status: 'paused' },
    })

    const boundary = 'offline-test-boundary'
    const payload = buildMultipart(
      boundary,
      {
        owner: '王小明',
        fields: JSON.stringify({ field_sid: '202699' }),
        materialIds: JSON.stringify(['mat_report']),
        note: '微信私发补录',
        markReady: 'true',
      },
      [{ name: 'raw-upload.pdf', bytes: Buffer.from('%PDF-1.4 offline test') }],
    )

    // 编辑者应被 403 拒绝
    const edRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/offline-upload`,
      headers: { ...edHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    assert.equal(edRes.statusCode, 403)

    // 管理员补录成功，自动套用命名规则：期末作品_202699_王小明_实验报告.pdf
    const adminRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/offline-upload`,
      headers: {
        ...ctx.adminHeaders,
        'x-workspace-mode': 'summary',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })
    assert.equal(adminRes.statusCode, 201, adminRes.body)
    const body = adminRes.json() as {
      workspace: Workspace
      files: {
        id: string
        name: string
        originalName: string
        owner: string
        participant: string
        materialId: string
        status: string
      }[]
    }
    assert.equal(body.files.length, 1)
    assert.equal(body.files[0].name, '期末作品_202699_王小明_实验报告.pdf')
    assert.equal(body.files[0].originalName, 'raw-upload.pdf')
    assert.equal(body.files[0].owner, '王小明')
    assert.equal(body.files[0].participant, '202699')
    assert.equal(body.files[0].materialId, 'mat_report')
    assert.equal(body.files[0].status, 'ready')
    assert.equal(body.workspace.summaryMode, true)

    // 线下补录 multipart 字段顺序无关：即使 files 排在 markReady 之前仍须生效
    const reversedBoundary = 'offline-reversed-order'
    const reversedPayload = Buffer.concat([
      Buffer.from(
        `--${reversedBoundary}\r\nContent-Disposition: form-data; name="files"; filename="late-flag.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from('%PDF-1.4 reversed order'),
      Buffer.from('\r\n'),
      Buffer.from(
        `--${reversedBoundary}\r\nContent-Disposition: form-data; name="owner"\r\n\r\n李小红\r\n`,
      ),
      Buffer.from(
        `--${reversedBoundary}\r\nContent-Disposition: form-data; name="fields"\r\n\r\n${JSON.stringify({ field_sid: '202698' })}\r\n`,
      ),
      Buffer.from(
        `--${reversedBoundary}\r\nContent-Disposition: form-data; name="materialIds"\r\n\r\n${JSON.stringify(['mat_report'])}\r\n`,
      ),
      Buffer.from(
        `--${reversedBoundary}\r\nContent-Disposition: form-data; name="markReady"\r\n\r\ntrue\r\n`,
      ),
      Buffer.from(`--${reversedBoundary}--\r\n`),
    ])
    const reversedRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/offline-upload`,
      headers: {
        ...ctx.adminHeaders,
        'content-type': `multipart/form-data; boundary=${reversedBoundary}`,
      },
      payload: reversedPayload,
    })
    assert.equal(reversedRes.statusCode, 201, reversedRes.body)
    assert.equal(
      reversedRes.json().files[0].status,
      'ready',
      'markReady 字段位于文件之后时仍须正确标记为 ready',
    )

    // 归档后禁止线下补录（409）
    await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/archive`,
      headers: ctx.adminHeaders,
      payload: { archived: true },
    })
    const archivedUpload = await ctx.app.inject({
      method: 'POST',
      url: `/api/collections/${c.id}/offline-upload`,
      headers: { ...ctx.adminHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    assert.equal(archivedUpload.statusCode, 409)
  } finally {
    await ctx.cleanup()
  }
})
