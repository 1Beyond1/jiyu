import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { AITransport } from './ai.ts'

test('重名校验按 collectionId 分组（含批量改名、撤销和 AI 建议），且正确比对无扩展名文件', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'rename-scope-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    quotaBytes: 4 * 1024 ** 2,
    requestBytes: 2 * 1024 ** 2,
    secureCookie: false,
  }
  let nextReply: Record<string, unknown> = { reply: '好', renames: [] }
  const transport: AITransport = async () => ({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(nextReply) } }],
    usage: { total_tokens: 10 },
  })
  const { app, store } = await createApp(config, { serveFrontend: false, aiTransport: transport })
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: config.origin },
      payload: {
        setupToken: store.setupToken(),
        displayName: '重名测试',
        password: 'rename-scope-password',
      },
    })
    const headers = {
      origin: config.origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    const makeCollection = async (title: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/collections',
        headers,
        payload: {
          title,
          description: '',
          category: 'document',
          target: 10,
          deadline: '2099-12-31',
          formats: 'PDF, TXT',
          maxFileSizeMB: 1,
          maxFilesPerSubmission: 5,
        },
      })
      assert.equal(res.statusCode, 200, res.body)
      return res.json().collections[0] as { id: string }
    }
    const colA = await makeCollection('任务A'),
      colB = await makeCollection('任务B')
    const add = (collectionId: string, name: string) => {
      const id = randomUUID()
      store.addFile(
        {
          id,
          name,
          originalName: name,
          size: 10,
          collectionId,
          owner: '测试者',
          createdAt: new Date().toISOString(),
          storage: 'local',
          status: 'pending',
        },
        randomUUID(),
      )
      return id
    }
    const a1 = add(colA.id, '报告.pdf'),
      a2 = add(colA.id, '草稿.pdf')
    const b1 = add(colB.id, '初稿.pdf'),
      bDotless = add(colB.id, 'readme')

    // 1. Cross-collection rename to same filename as another collection succeeds.
    const crossRename = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      headers,
      payload: { changes: [{ id: b1, oldName: '初稿.pdf', name: '报告.pdf' }] },
    })
    assert.equal(crossRename.statusCode, 200, crossRename.body)
    assert.equal(store.file(b1)?.name, '报告.pdf')

    // 2. Same-collection duplicate rename is still rejected with 409.
    const sameDup = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      headers,
      payload: { changes: [{ id: a2, oldName: '草稿.pdf', name: '报告.pdf' }] },
    })
    assert.equal(sameDup.statusCode, 409)

    // 3. Undo succeeds even when another collection has a file named '初稿.pdf'.
    add(colA.id, '初稿.pdf')
    const undoOk = await app.inject({
      method: 'POST',
      url: `/api/files/rename/${crossRename.json().operationId}/undo`,
      headers,
      payload: {},
    })
    assert.equal(undoOk.statusCode, 200, undoOk.body)
    assert.equal(store.file(b1)?.name, '初稿.pdf')

    // 4. Undo still rejects when the SAME collection now occupies the original filename.
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      headers,
      payload: { changes: [{ id: a2, oldName: '草稿.pdf', name: '新草稿.pdf' }] },
    })
    assert.equal(r2.statusCode, 200)
    add(colA.id, '草稿.pdf')
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/files/rename/${r2.json().operationId}/undo`,
          headers,
          payload: {},
        })
      ).statusCode,
      409,
    )

    // 5. Extension preservation with dotless and dot-only names.
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/files/rename',
          headers,
          payload: { changes: [{ id: b1, oldName: '初稿.pdf', name: 'pdf' }] },
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/files/rename',
          headers,
          payload: { changes: [{ id: b1, oldName: '初稿.pdf', name: '.pdf' }] },
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/files/rename',
          headers,
          payload: { changes: [{ id: bDotless, oldName: 'readme', name: 'notes.txt' }] },
        })
      ).statusCode,
      400,
    )
    const dotlessOk = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      headers,
      payload: { changes: [{ id: bDotless, oldName: 'readme', name: 'notes' }] },
    })
    assert.equal(dotlessOk.statusCode, 200, dotlessOk.body)
    assert.equal(store.file(bDotless)?.name, 'notes')

    // 6. AI rename suggestions: allow cross-collection same name, reject same-collection duplicate & extension stripping.
    const aiCfg = await app.inject({
      method: 'PATCH',
      url: '/api/ai/settings',
      headers,
      payload: {
        enabled: true,
        protocol: 'chat',
        baseUrl: 'https://provider.example/v1',
        model: 'm',
        maxDailyCalls: 50,
        apiKey: 'fixture-key',
      },
    })
    assert.equal(aiCfg.statusCode, 200, aiCfg.body)
    const rev = aiCfg.json().revision as string

    nextReply = { reply: '跨任务改名', renames: [{ file: 'F1', name: '报告.pdf' }] }
    const aiCross = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers,
      payload: { prompt: '改名', fileIds: [b1], consent: true, settingsRevision: rev },
    })
    assert.equal(aiCross.statusCode, 200, aiCross.body)
    const aiApply = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      headers,
      payload: { changes: aiCross.json().changes, aiRunId: aiCross.json().runId },
    })
    assert.equal(aiApply.statusCode, 200, aiApply.body)
    assert.equal(store.file(b1)?.name, '报告.pdf')

    nextReply = { reply: '同任务重名', renames: [{ file: 'F1', name: '报告.pdf' }] }
    const aiSameDup = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers,
      payload: { prompt: '改名', fileIds: [a2], consent: true, settingsRevision: rev },
    })
    assert.equal(aiSameDup.statusCode, 422)

    nextReply = { reply: '去后缀', renames: [{ file: 'F1', name: 'pdf' }] }
    const aiBadExt = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers,
      payload: { prompt: '改名', fileIds: [a1], consent: true, settingsRevision: rev },
    })
    assert.equal(aiBadExt.statusCode, 422)
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})
