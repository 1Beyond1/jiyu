import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createApp } from './app.ts'
import type { AIRequest } from './ai.ts'
import type { Collection, CollectedFile, MaterialAIPlan, MaterialAIPreview } from '../src/types.ts'
import { materialStateVersion, materialReviewState } from '../src/lib/materials.ts'

test('材料AI预核对：授权正文、真实引用边界、覆盖、人工处置及替换失效（内部注入，非语义质量测试）', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'material-ai-test-'))
  let responseMode = 'valid', captured: AIRequest | undefined, calls = 0, delayed: (() => void) | undefined, release: (() => void) | undefined
  const service = await createApp({ dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 0, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }, { serveFrontend: false, aiTransport: async request => {
    calls++; captured = request
    if (responseMode === 'delayed') { delayed?.(); await new Promise<void>(r => { release = r }) }
    const messages = (request.body.input || request.body.messages) as { content: string }[]
    const context = JSON.parse(messages[1].content)
    const findings = context.files.map((f: { file: string; excerpt: string; coverage: string; materialId: string }) => ({ file: f.file, assessment: f.coverage === 'unread' ? 'uncertain' : f.excerpt.includes('旧活动') ? 'attention' : 'no_issue_in_excerpt', materialId: f.coverage === 'unread' ? '' : 'mat_form', message: f.coverage === 'unread' ? '未读取，无法判断' : '本次要求与已读片段需人工对照', suggestion: '请核对活动名称与缺少的报名信息', evidence: f.coverage === 'unread' ? [] : [{ file: f.file, start: 0, end: Math.min(8, f.excerpt.length), quote: f.excerpt.slice(0, 8) }] }))
    if (responseMode === 'wrong-file') findings[0].evidence[0].file = 'F2'
    if (responseMode === 'forged') findings[0].evidence[0].quote = '凭空生成原文'
    if (responseMode === 'unread-pass') { const unread = findings.find((f: { evidence: unknown[] }) => !f.evidence.length)!; unread.assessment = 'no_issue_in_excerpt' }
    if (responseMode === 'out-of-range') { findings[0].evidence[0].start = 5000; findings[0].evidence[0].end = 5008 }
    if (responseMode === 'wrong-material') findings[0].materialId = 'mat_other_task'
    if (responseMode === 'missing-file') findings.pop()
    if (responseMode === 'whitespace') { const start = context.files[0].excerpt.indexOf('\n'); findings[0].evidence = [{ file: 'F1', start, end: start + 2, quote: context.files[0].excerpt.slice(start, start + 2) }] }
    if (context.question) return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ reply: '共享额度协议测试', renames: [] }) }] }] }
    return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ findings }) }] }] }
  } })
  const { app, store } = service, origin = { origin: 'http://127.0.0.1:3000' }
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: origin, payload: { setupToken: store.setupToken(), displayName: '预核对测试', password: 'material-ai-fixture-password' } })
    const headers = { ...origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    let ip = 2
    const call = (url: string, payload?: object, method: 'POST' | 'GET' | 'PATCH' = 'POST', h = headers) => app.inject({ method, url, headers: h, remoteAddress: `127.0.0.${ip++}`, ...(payload ? { payload } : {}) })
    const rules = { title: '新活动报名', description: '仅接收新活动报名表，必须有活动名与报名说明', category: 'document', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 5, materials: [{ id: 'mat_form', name: '报名表', required: true, description: '新活动报名信息' }, { id: 'mat_statement', name: '作品说明', required: true, description: '新活动作品介绍' }] }
    const created = await call('/api/collections', rules), c = created.json().collections[0] as Collection
    const add = async (name: string, body: string, indexed = true) => {
      const id = randomUUID(), key = randomUUID(), bytes = Buffer.from(body)
      await writeFile(join(store.dataDir, 'objects', key), bytes)
      const file: CollectedFile = { id, name, owner: '不可外发姓名', participant: 'A01', collectionId: c.id, sha256: createHash('sha256').update(bytes).digest('hex'), materialId: 'mat_form', materialVersion: 1, createdAt: '2026-10-24', storage: 'local', status: 'pending', size: bytes.length }
      store.addFile(file, key)
      store.db.prepare('INSERT INTO documents(file_id,status,chars,updated_at,kind) VALUES (?,?,?,?,?)').run(id, indexed ? 'ready' : 'failed', indexed ? body.length : 0, '2026-10-24T00:00:00Z', 'UTF-8 文本')
      if (indexed) store.db.prepare('INSERT INTO content_search VALUES (?,?)').run(id, body)
      return file
    }
    await writeFile(join(dir, 'expected.json'), JSON.stringify({ authorizedAliases: ['F1', 'F2', 'F3', 'F4'], coverage: ['full', 'full', 'unread', 'partial'], zeroAutomaticApproval: true, wrongFileSameValueRejected: true, replacedPlanStale: true }))
    const files = [await add('旧活动表.txt', '编号42：旧活动报名表，\n仅适用旧活动。'), await add('新活动表.txt', '编号42：新活动报名表，申请参与展示。'), await add('读取失败.txt', '未授权隐藏内容', false), await add('长说明.txt', '新活动片段'.repeat(1000) + '未读取的尾部独有标记')]
    const previewRequest = () => ({ collectionId: c.id, files: files.map(f => ({ id: f.id, expectedVersion: materialStateVersion(store.files().find(v => v.id === f.id)!) })) })
    const preview = async () => { const r = await call('/api/material-ai/preview', previewRequest()); assert.equal(r.statusCode, 200, r.body); return r.json() as MaterialAIPreview }
    const p = await preview()
    assert.deepEqual(p.sources.map(s => s.coverage), ['full', 'full', 'unread', 'partial'])
    assert.equal(p.sources[3].excerpt.length, 2000); assert.equal(p.sources[3].excerpt.includes('尾部独有标记'), false)
    assert.equal(p.sources[2].excerpt, '')
    assert.equal((await call('/api/material-ai/run', { previewId: p.previewId, settingsRevision: p.settingsRevision, consent: true, contentConsent: true, testMode: true })).statusCode, 400)
    assert.equal(calls, 0, '客户端不能用测试参数绕过模型配置')
    const saved = await call('/api/ai/settings', { enabled: true, protocol: 'responses', baseUrl: 'https://fixture.example/v1', model: 'internal-protocol-fixture', maxDailyCalls: 50, apiKey: 'synthetic-key-for-material-ai' }, 'PATCH')
    const current = await preview(), runBody = { previewId: current.previewId, settingsRevision: saved.json().revision, consent: true, contentConsent: true }
    assert.equal((await call('/api/material-ai/run', { ...runBody, contentConsent: false })).statusCode, 400)
    assert.equal((await call('/api/material-ai/run', { ...runBody, settingsRevision: 'old' })).statusCode, 409)
    assert.equal(calls, 0)
    const valid = await call('/api/material-ai/run', runBody)
    assert.equal(valid.statusCode, 200, valid.body)
    const plan = valid.json() as MaterialAIPlan
    assert.equal(plan.preview.testMode, true)
    assert.equal(plan.findings[0].assessment, 'attention', '错活动样本只验证协议与出处，非真实语义推理')
    assert.equal(JSON.stringify(captured!.body).includes('不可外发姓名'), false)
    assert.equal(JSON.stringify(captured!.body).includes('未授权隐藏内容'), false)
    assert.equal(JSON.stringify(captured!.body).includes('尾部独有标记'), false)
    assert.equal(store.files().some(f => f.materialReview), false, 'AI未写人工通过')
    for (const mode of ['wrong-file', 'forged', 'unread-pass', 'out-of-range', 'wrong-material', 'missing-file']) { responseMode = mode; const bad = await call('/api/material-ai/run', runBody); assert.equal(bad.statusCode, 422, `${mode}: ${bad.body}`) }
    responseMode = 'whitespace'; assert.equal((await call('/api/material-ai/run', runBody)).statusCode, 200, '精确引用保留原文换行与空白')
    responseMode = 'valid'
    const beforeFailure = (store.db.prepare('SELECT COUNT(*) AS n FROM ai_plans').get() as { n: number }).n
    const activity = store.activity.bind(store)
    store.activity = message => { if (message.startsWith('生成')) throw Object.assign(new Error('injected full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 }); return activity(message) }
    try { assert.equal((await call('/api/material-ai/run', runBody)).statusCode, 507) } finally { store.activity = activity }
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM ai_plans').get() as { n: number }).n, beforeFailure, '保存建议时写入失败不留下半份成功计划')
    const noCsrf = { ...headers, 'x-csrf-token': '' }
    assert.equal((await call('/api/material-ai/preview', previewRequest(), 'POST', noCsrf)).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: `/api/material-ai/plans/${plan.runId}` })).statusCode, 401)
    const other = (await call('/api/collections', { ...rules, title: '另一个活动' })).json().collections[0] as Collection
    assert.equal((await call('/api/material-ai/preview', { ...previewRequest(), collectionId: other.id })).statusCode, 409)
    await call('/api/users', { username: 'material-reader', displayName: '只读', role: 'viewer', password: 'read-only-fixture-password' })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: origin, payload: { username: 'material-reader', password: 'read-only-fixture-password' } })
    const viewer = { ...origin, cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': login.json().csrf }
    assert.equal((await call('/api/material-ai/preview', previewRequest(), 'POST', viewer)).statusCode, 403)
    const file = store.files().find(f => f.id === files[0].id)!
    const action = { collectionId: c.id, rulesRevision: c.materialRevision, requestId: randomUUID(), files: [{ id: file.id, expectedVersion: materialStateVersion(file) }], decision: 'needs_changes', note: '人工确认属于旧活动，请补交本次材料', aiReview: { runId: plan.runId, fileId: file.id, acknowledged: true } }
    assert.equal((await call('/api/materials/review', { ...action, aiReview: { ...action.aiReview, acknowledged: false } })).statusCode, 400)
    const disposition = await call('/api/materials/review', action)
    assert.equal(disposition.statusCode, 200, disposition.body)
    assert.equal((await call('/api/materials/review', action)).statusCode, 200, '人工处置重试仍幂等')
    const after = (await call(`/api/material-ai/plans/${plan.runId}`, undefined, 'GET')).json() as MaterialAIPlan
    assert.equal(after.stale, true); assert.equal(after.dispositions?.[file.id].decision, 'needs_changes')
    assert.equal(materialReviewState(c, store.files().find(f => f.id === file.id)!), 'needs_changes')
    const nextPreview = await preview(), nextPlan = (await call('/api/material-ai/run', { ...runBody, previewId: nextPreview.previewId })).json() as MaterialAIPlan
    store.db.prepare('UPDATE documents SET updated_at=? WHERE file_id=?').run('2026-10-24T01:00:00Z', files[1].id)
    assert.equal((await call(`/api/material-ai/plans/${nextPlan.runId}`, undefined, 'GET')).json().stale, true)
    const delayedPreview = await preview(), started = new Promise<void>(r => { delayed = r }); responseMode = 'delayed'
    const pending = call('/api/material-ai/run', { ...runBody, previewId: delayedPreview.previewId }); await started
    store.saveCollection({ ...store.collection(c.id)!, materialRevision: randomUUID() })
    release!(); assert.equal((await pending).statusCode, 409, '模型晚回包拒绝旧快照')
    responseMode = 'valid'
    const replacementPreview = await preview(), replacementPlan = (await call('/api/material-ai/run', { ...runBody, previewId: replacementPreview.previewId })).json() as MaterialAIPlan
    await add('随后补交.txt', '新活动补交内容', false)
    const freshFile = store.files().find(f => f.id === file.id)!
    const outdatedAdvice = { ...action, requestId: randomUUID(), rulesRevision: store.collection(c.id)!.materialRevision, files: [{ id: freshFile.id, expectedVersion: materialStateVersion(freshFile) }], aiReview: { ...action.aiReview, runId: replacementPlan.runId } }
    assert.equal((await call('/api/materials/review', outdatedAdvice)).statusCode, 409, '本人追加文件也使旧建议失效，不能只靠当前文件版本通过')
    store.saveFile({ ...store.files().find(f => f.id === file.id)!, deletedAt: new Date().toISOString(), materialVersion: 2 })
    await add('本人替换后新表.txt', '新活动报名信息，原件已替换')
    assert.equal((await call(`/api/material-ai/plans/${replacementPlan.runId}`, undefined, 'GET')).json().stale, true)
    assert.equal((await call('/api/materials/review', { ...action, requestId: randomUUID(), rulesRevision: store.collection(c.id)!.materialRevision, aiReview: { ...action.aiReview, runId: replacementPlan.runId } })).statusCode, 409)
    assert.equal((await call('/api/ai/chat', { prompt: '检查共享额度', fileIds: [], settingsRevision: saved.json().revision, consent: true })).statusCode, 200)
    const usage = (await call('/api/ai/settings', undefined, 'GET')).json()
    assert.equal(usage.usedToday, calls, '通用助手与材料预核对共享每日额度，失败响应也计数')
    const limited = await call('/api/ai/settings', { enabled: true, protocol: 'responses', baseUrl: 'https://fixture.example/v1', model: 'internal-protocol-fixture', maxDailyCalls: 1 }, 'PATCH')
    const limitPreview = (await call('/api/material-ai/preview', { collectionId: c.id, files: [{ id: files[1].id, expectedVersion: materialStateVersion(store.files().find(f => f.id === files[1].id)!) }] })).json()
    const beforeQuota = calls
    assert.equal((await call('/api/material-ai/run', { previewId: limitPreview.previewId, settingsRevision: limited.json().revision, consent: true, contentConsent: true })).statusCode, 429)
    assert.equal(calls, beforeQuota)
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
