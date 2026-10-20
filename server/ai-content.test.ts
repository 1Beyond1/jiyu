import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createApp } from './app.ts'
import type { AIRequest } from './ai.ts'
import type { Config } from './config.ts'

test('正文摘录需额外授权，分类建议绑定方案、原子应用且可撤销', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'ai-content-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }
  let captured: AIRequest | undefined
  const { app, store } = await createApp(config, { serveFrontend: false, aiTransport: async request => { captured = request; return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ reply: '可标为合同，等待确认', renames: [], classifications: [{ file: 'F1', tags: ['合同', '待确认'] }] }) }] }] } } })
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: store.setupToken(), displayName: '分类测试', password: 'test-classify-password' } })
    const headers = { origin: config.origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const call = (url: string, payload: object, method: 'POST' | 'PATCH' = 'POST') => app.inject({ method, url, headers, payload })
    const task = await call('/api/collections', { title: '资料', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 2 })
    const id = randomUUID(), key = randomUUID(), bytes = Buffer.from('仅在额外授权后发送的合约内容')
    await writeFile(join(config.dataDir, 'objects', key), bytes)
    store.addFile({ id, name: '资料.txt', collectionId: task.json().collections[0].id, owner: '私密姓名', size: bytes.length, createdAt: new Date().toISOString(), storage: 'local', status: 'pending', sha256: createHash('sha256').update(bytes).digest('hex') }, key)
    store.db.prepare("INSERT INTO documents(file_id,status,chars) VALUES (?,'ready',?)").run(id, bytes.toString().length)
    store.db.prepare('INSERT INTO content_search VALUES (?,?)').run(id, bytes.toString())
    const settings = await call('/api/ai/settings', { enabled: true, protocol: 'responses', baseUrl: 'https://provider.example/v1', model: 'classification-fixture', maxDailyCalls: 10, apiKey: 'test-fixture-key' }, 'PATCH')
    const request = { prompt: '请给文件分类', fileIds: [id], settingsRevision: settings.json().revision, consent: true }
    assert.equal((await call('/api/ai/chat', { ...request, includeContent: true })).statusCode, 400)
    assert.equal(captured, undefined)
    const metadataOnly = await call('/api/ai/chat', request)
    assert.equal(metadataOnly.statusCode, 200, metadataOnly.body)
    assert.equal(JSON.stringify((captured as AIRequest | undefined)?.body).includes(bytes.toString()), false)
    const reply = await call('/api/ai/chat', { ...request, includeContent: true, contentConsent: true })
    assert.equal(reply.statusCode, 200, reply.body)
    assert.equal(JSON.stringify((captured as AIRequest | undefined)?.body).includes(bytes.toString()), true)
    assert.equal(JSON.stringify((captured as AIRequest | undefined)?.body).includes('私密姓名'), false)
    const plan = reply.json()
    assert.equal(store.files()[0].tags, undefined)
    assert.equal((await call('/api/files/rename', { changes: [], tags: [{ ...plan.tags[0], tags: ['被修改'] }], aiRunId: plan.runId })).statusCode, 409)
    const applied = await call('/api/files/rename', { changes: plan.changes, tags: plan.tags, aiRunId: plan.runId })
    assert.equal(applied.statusCode, 200, applied.body); assert.deepEqual(store.files()[0].tags, ['合同', '待确认'])
    assert.equal((await call('/api/files/rename', { changes: plan.changes, tags: plan.tags, aiRunId: plan.runId })).statusCode, 409)
    assert.equal((await call(`/api/files/rename/${applied.json().operationId}/undo`, {})).statusCode, 200)
    assert.deepEqual(store.files()[0].tags, [])
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
