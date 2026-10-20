import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createApp } from './app.ts'
import { endpointBase, isPublicAddress } from './ai.ts'
import type { AIRequest, AITransport } from './ai.ts'
import { createBackup, restoreBackup } from './backup.ts'

test('模型地址限制内网、保留地址、URL 凭证和非 HTTPS', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address)
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPublicAddress(address), true, address)
  for (const url of ['http://provider.example/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://key@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example:8443/v1']) assert.throws(() => endpointBase(url))
  assert.equal(endpointBase('https://provider.example/v1/'), 'https://provider.example/v1')
})

test('AI 凭证、发送范围、建议确认、审计与完整备份恢复', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'ai-test-')), dataDir = join(dir, 'data')
  const config = { dataDir, origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, quotaBytes: 1024 ** 3, requestBytes: 512 * 1024 ** 2, secureCookie: false }
  const secret = 'fixture-api-key-not-a-real-credential'
  let captured: AIRequest | undefined, mode = 'rename'
  const transport: AITransport = async req => {
    captured = req
    const renames = mode === 'unsafe' ? [{ file: 'F1', name: '../escape.pdf' }] : mode === 'unknown' ? [{ file: 'F2', name: 'unknown.pdf' }] : mode === 'rename' ? [{ file: 'F1', name: '统一资料_01.pdf' }] : []
    const content = JSON.stringify({ reply: `请先预览再应用。${mode === 'echo' ? secret : ''}`, renames })
    return req.endpoint.pathname.endsWith('/responses') ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }], usage: { total_tokens: 24 } } : { choices: [{ finish_reason: 'stop', message: { content } }], usage: { total_tokens: 24 } }
  }
  let service = await createApp(config, { serveFrontend: false, aiTransport: transport })
  let cookie = '', csrf = ''
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, auth = true) => service.app.inject({ method, url, payload, headers: { origin: config.origin, ...(auth ? { cookie, 'x-csrf-token': csrf } : {}) } })
  try {
    const init = await request('POST', '/api/auth/setup', { setupToken: service.store.setupToken(), password: 'test-ai-admin-password', displayName: 'AI 测试' }, false)
    cookie = init.headers['set-cookie']!.toString().split(';')[0]; csrf = init.json().csrf
    const draft = { title: '任务元数据', description: '不应发送说明全文', category: 'document', target: 10, deadline: '2099-12-31', formats: 'PDF', maxFileSizeMB: 100, maxFilesPerSubmission: 20 }
    const created = await request('POST', '/api/collections', draft), collection = created.json().collections[0]
    const id = randomUUID(), key = randomUUID(), body = Buffer.from('绝不发送的文件正文')
    await writeFile(join(dataDir, 'objects', key), body)
    service.store.addFile({ id, collectionId: collection.id, name: '原始资料.pdf', owner: '提交人隐私', size: body.length, createdAt: new Date().toISOString(), storage: 'local', status: 'pending', sha256: createHash('sha256').update(body).digest('hex') }, key)
    assert.equal((await request('GET', '/api/ai/settings', undefined, false)).statusCode, 401)
    assert.equal((await request('GET', '/api/ai/settings')).json().enabled, false)
    const settings = { enabled: true, protocol: 'responses', baseUrl: 'https://provider.example/v1', model: 'fixture-model', maxDailyCalls: 50, apiKey: secret }
    const saved = await request('PATCH', '/api/ai/settings', settings)
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal(saved.json().hasKey, true)
    assert.equal(saved.body.includes(secret), false)
    assert.equal(service.store.get('ai.settings')!.includes(secret), false)
    assert.equal((await readFile(join(dataDir, 'secrets.key'))).length, 32)
    assert.equal((await request('GET', '/api/workspace')).body.includes(secret), false)
    assert.equal((await request('PATCH', '/api/ai/settings', { ...settings, baseUrl: 'https://elsewhere.example/v1', apiKey: '' })).statusCode, 400)
    const prompt = { prompt: '统一命名', fileIds: [id], includeOwners: false, consent: true, settingsRevision: saved.json().revision }
    assert.equal((await request('POST', '/api/ai/chat', { ...prompt, consent: false })).statusCode, 400)
    assert.equal(captured, undefined)
    assert.equal((await request('POST', '/api/ai/chat', { ...prompt, settingsRevision: 'stale-settings' })).statusCode, 409)
    assert.equal(captured, undefined)
    const reply = await request('POST', '/api/ai/chat', prompt)
    assert.equal(reply.statusCode, 200, reply.body)
    assert.equal(service.store.files()[0].name, '原始资料.pdf')
    const serialized = JSON.stringify(captured!.body)
    assert.equal(captured!.apiKey, secret)
    assert.equal(captured!.body.store, false)
    for (const hidden of ['绝不发送的文件正文', '提交人隐私', collection.uploadToken, id, '不应发送说明全文']) assert.equal(serialized.includes(hidden), false)
    assert.ok(serialized.includes('原始资料.pdf'))
    const plan = reply.json()
    assert.equal((await request('POST', '/api/files/rename', { changes: [{ ...plan.changes[0], name: '修改方案.pdf' }], aiRunId: plan.runId })).statusCode, 409)
    const applied = await request('POST', '/api/files/rename', { changes: plan.changes, aiRunId: plan.runId })
    assert.equal(applied.statusCode, 200, applied.body)
    assert.equal(applied.json().workspace.files[0].name, '统一资料_01.pdf')
    assert.equal((await request('POST', '/api/files/rename', { changes: plan.changes, aiRunId: plan.runId })).statusCode, 409)
    assert.equal((await request('POST', `/api/files/rename/${applied.json().operationId}/undo`, {})).statusCode, 200)
    mode = 'unsafe'; assert.equal((await request('POST', '/api/ai/chat', prompt)).statusCode, 422)
    mode = 'unknown'; assert.equal((await request('POST', '/api/ai/chat', prompt)).statusCode, 422)
    mode = 'echo'; const echo = await request('POST', '/api/ai/chat', { ...prompt, includeOwners: true })
    assert.equal(echo.body.includes(secret), false)
    assert.ok(JSON.stringify(captured!.body).includes('提交人隐私'))
    assert.equal(service.store.files()[0].name, '原始资料.pdf')
    assert.equal((await request('GET', '/api/ai/history')).body.includes('统一命名'), false)
    await service.app.close()
    const backupDir = join(dir, 'backup'), restoredDir = join(dir, 'restored')
    await createBackup(dataDir, backupDir)
    assert.equal((await readFile(join(backupDir, 'secrets.key'))).length, 32)
    await restoreBackup(backupDir, restoredDir)
    service = await createApp({ ...config, dataDir: restoredDir }, { serveFrontend: false, aiTransport: transport })
    const login = await request('POST', '/api/auth/login', { password: 'test-ai-admin-password' }, false)
    cookie = login.headers['set-cookie']!.toString().split(';')[0]; csrf = login.json().csrf
    mode = 'test'
    assert.equal((await request('POST', '/api/ai/test', { consent: true, settingsRevision: prompt.settingsRevision })).statusCode, 200)
    assert.equal(captured!.apiKey, secret)
    const chatSettings = { ...settings, protocol: 'chat', apiKey: '', maxDailyCalls: 6 }
    const chatSaved = await request('PATCH', '/api/ai/settings', chatSettings)
    assert.equal(chatSaved.statusCode, 200)
    prompt.settingsRevision = chatSaved.json().revision
    assert.equal((await request('POST', '/api/ai/chat', prompt)).statusCode, 200)
    assert.equal(captured!.endpoint.pathname, '/v1/chat/completions')
    assert.equal((await request('POST', '/api/ai/chat', prompt)).statusCode, 429)
    assert.equal((await request('DELETE', '/api/ai/settings/key')).json().enabled, false)
    assert.equal((await request('GET', '/api/ai/settings')).json().hasKey, false)
  } finally { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})

test('拒绝截断、无效或拒答的模型结果，并限制同时调用数量', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'ai-limits-test-'))
  const config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, quotaBytes: 1024 ** 3, requestBytes: 512 * 1024 ** 2, secureCookie: false }
  let mode = 'invalid', count = 0, release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  const transport: AITransport = async req => {
    if (mode === 'pending') { if (++count === 2) entered(); await gate }
    const content = mode === 'invalid' ? 'not-json' : JSON.stringify({ reply: '只提供建议，未执行操作', renames: [] })
    return req.endpoint.pathname.endsWith('/responses') ? { status: mode === 'incomplete' ? 'incomplete' : 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] } : { choices: [{ finish_reason: 'stop', message: { content, ...(mode === 'refusal' ? { refusal: 'fixture refusal' } : {}) } }] }
  }
  const service = await createApp(config, { serveFrontend: false, aiTransport: transport })
  try {
    const init = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: service.store.setupToken(), password: 'fixture-ai-limits-password', displayName: '模型边界测试' } })
    const headers = { origin: config.origin, cookie: init.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': init.json().csrf }
    const settings = { enabled: true, protocol: 'responses', model: 'fixture-model', baseUrl: 'https://provider.example/v1', maxDailyCalls: 50, apiKey: 'fixture-key' }
    const save = (protocol: string) => service.app.inject({ method: 'PATCH', url: '/api/ai/settings', headers, payload: { ...settings, protocol } })
    let revision = (await save('responses')).json().revision
    const request = () => service.app.inject({ method: 'POST', url: '/api/ai/chat', headers, payload: { prompt: '查看统计', fileIds: [], consent: true, settingsRevision: revision } })
    assert.equal((await request()).statusCode, 502)
    mode = 'incomplete'; assert.equal((await request()).statusCode, 502)
    revision = (await save('chat')).json().revision
    mode = 'refusal'; assert.equal((await request()).statusCode, 502)
    mode = 'pending'
    const running = [Promise.resolve(request()), Promise.resolve(request())]
    await ready
    assert.equal((await request()).statusCode, 429)
    assert.equal(count, 2)
    release()
    for (const result of await Promise.all(running)) assert.equal(result.statusCode, 200, result.body)
    const status = await service.app.inject({ method: 'GET', url: '/api/ai/settings', headers })
    assert.equal(status.json().usedToday, 5)
    const runs = service.store.db.prepare('SELECT status FROM ai_runs').all()
    assert.equal(runs.filter(r => r.status === 'failed').length, 3)
    assert.equal(service.store.files().length, 0)
  } finally { release(); await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
