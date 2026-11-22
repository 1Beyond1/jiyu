import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createApp } from './app.ts'
import type { AIRequest } from './ai.ts'
import type { CollectionDraft } from '../src/types.ts'

test('一句话草稿：只授权原话、拒绝编造配置、人工澄清后原子创建，生成/编辑/取消不写收集', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'collection-draft-test-'))
  const source = '社团报名表必须交，作品说明的页数与必需性待定，展示图片选填。'
  let mode = 'valid',
    calls = 0,
    captured: AIRequest | undefined
  const { app, store } = await createApp(
    {
      dataDir: join(dir, 'data'),
      origin: 'http://127.0.0.1:3000',
      host: '127.0.0.1',
      port: 0,
      secureCookie: false,
      quotaBytes: 1024 ** 2,
      requestBytes: 1024 ** 2,
    },
    {
      serveFrontend: false,
      aiTransport: async (r) => {
        captured = r
        calls++
        const result: Record<string, unknown> = {
          title: '社团材料收集',
          materials: [
            {
              name: '报名表',
              required: true,
              description: '提交社团报名表',
              sourceQuote: '报名表必须交',
            },
            {
              name: '作品说明',
              required: null,
              description: '提交作品说明，要求待人工确认',
              sourceQuote: '作品说明的页数与必需性待定',
            },
            {
              name: '展示图片',
              required: false,
              description: '展示图片选填',
              sourceQuote: '展示图片选填',
            },
          ],
          clarifications: [
            {
              question: '作品说明的篇幅要求是什么？',
              materialIndex: 1,
              sourceQuote: '页数与必需性待定',
            },
          ],
        }
        if (mode === 'deadline') result.deadline = '2099-01-01'
        if (mode === 'roster') result.expectedSubmitters = ['不应推断的人']
        if (mode === 'fields') result.fields = [{ label: '手机号' }]
        if (mode === 'forged')
          (result.materials as { sourceQuote: string }[])[0].sourceQuote = '原话没有说过的材料'
        if (mode === 'sensitive') (result.materials as { name: string }[])[0].name = '身份证照片'
        if (mode === 'invalid-required')
          (result.materials as Record<string, unknown>[])[0].required = '默认必需'
        return {
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
          ],
        }
      },
    },
  )
  const origin = { origin: 'http://127.0.0.1:3000' }
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: origin,
      payload: {
        setupToken: store.setupToken(),
        displayName: '草稿协议验收',
        password: 'collection-draft-fixture-password',
      },
    })
    const headers = {
      ...origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    let ip = 2
    const call = (
      url: string,
      payload?: object,
      method: 'POST' | 'PATCH' | 'GET' = 'POST',
      h = headers,
    ) =>
      app.inject({
        url,
        method,
        headers: h,
        remoteAddress: `127.0.0.${ip++}`,
        ...(payload ? { payload } : {}),
      })
    const oldRules = {
      title: '原任务请保持',
      description: '不向模型发送的已有收集说明',
      category: 'document',
      deadline: '2099-12-31',
      formats: 'TXT',
      target: 5,
      maxFileSizeMB: 1,
      maxFilesPerSubmission: 5,
    }
    const old = (await call('/api/collections', oldRules)).json().collections[0]
    assert.equal(
      (
        await call('/api/ai/collection-draft', {
          prompt: source,
          consent: true,
          settingsRevision: 'none',
          testMode: true,
        })
      ).statusCode,
      400,
    )
    assert.equal(calls, 0, '公开参数不能启用内部夹具或跳过模型设置')
    const settings = await call(
      '/api/ai/settings',
      {
        enabled: true,
        protocol: 'responses',
        baseUrl: 'https://fixture.example/v1',
        model: 'internal-collection-draft',
        maxDailyCalls: 50,
        apiKey: 'synthetic-draft-key',
      },
      'PATCH',
    )
    const input = { prompt: source, settingsRevision: settings.json().revision, consent: true }
    assert.equal(
      (await call('/api/ai/collection-draft', { ...input, consent: false })).statusCode,
      400,
    )
    assert.equal(
      (await call('/api/ai/collection-draft', { ...input, settingsRevision: 'old' })).statusCode,
      409,
    )
    assert.equal(calls, 0)
    const response = await call('/api/ai/collection-draft', input)
    assert.equal(response.statusCode, 200, response.body)
    const draft = response.json() as CollectionDraft
    assert.equal(draft.testMode, true)
    assert.equal(draft.source, source)
    assert.equal(draft.materials[1].required, null)
    const context = JSON.parse((captured!.body.input as { content: string }[])[1].content)
    assert.deepEqual(context, { purpose: 'collection-draft', description: source })
    assert.equal(JSON.stringify(captured!.body).includes(oldRules.description), false)
    assert.equal(store.collections().length, 1)
    assert.equal(store.files().length, 0)
    for (mode of ['deadline', 'roster', 'fields', 'forged', 'sensitive', 'invalid-required']) {
      assert.equal((await call('/api/ai/collection-draft', input)).statusCode, 422, mode)
      assert.equal(store.collections().length, 1)
    }
    mode = 'valid'
    const edited = structuredClone(draft)
    edited.title = '人工修改草稿'
    edited.materials[0].name = '人工改名报名表'
    assert.equal(
      store.collections().length,
      1,
      '本地编辑和丢弃草稿不调用创建；仅AI调用记录按额度保留',
    )
    assert.equal(store.collection(old.id)!.title, oldRules.title)
    const answer = '不超过两页，需说明作品主题'
    const materials = draft.materials.map((m) => ({
      id: m.id,
      name: m.name,
      required: m.required === null ? true : m.required,
      description:
        m.id === draft.materials[1].id ? `${m.description}\n补充要求：${answer}` : m.description,
    }))
    const confirmation = {
      runId: draft.runId,
      confirmed: true,
      resolutions: [{ id: draft.clarifications[0].id, materialId: materials[1].id, answer }],
    }
    const final = {
      ...oldRules,
      title: '发起人确认后的收集',
      deadline: '2099-11-21',
      target: 9,
      materials,
      draftConfirmation: confirmation,
    }
    assert.equal(
      (
        await call('/api/collections', {
          ...final,
          draftConfirmation: { ...confirmation, confirmed: false },
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await call('/api/collections', {
          ...final,
          draftConfirmation: { ...confirmation, resolutions: [] },
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await call('/api/collections', {
          ...final,
          materials: materials.map((m) => ({ ...m, description: '' })),
        })
      ).statusCode,
      400,
    )
    assert.equal(
      (
        await call('/api/collections', {
          ...final,
          draftConfirmation: { ...confirmation, runId: old.id },
        })
      ).statusCode,
      409,
    )
    assert.equal(store.collections().length, 1, '拒绝路径不留下半份任务')
    assert.equal(
      (await call(`/api/collections/${old.id}`, final, 'PATCH')).statusCode,
      400,
      '草稿不能覆盖既有任务',
    )
    const created = await call('/api/collections', final)
    assert.equal(created.statusCode, 200, created.body)
    const c = created.json().collections[0]
    assert.equal(c.title, final.title)
    assert.equal(c.deadline, final.deadline)
    assert.equal(c.target, 9)
    assert.equal(c.materials.length, 3)
    assert.equal(c.materials[1].description.includes(answer), true)
    assert.match(c.materialRevision, /^[a-f0-9-]{36}$/)
    assert.equal(c.draftOrigin.runId, draft.runId)
    assert.equal(c.draftConfirmation, undefined)
    assert.equal(store.collections().length, 2)
    assert.equal(store.collection(old.id)!.title, oldRules.title)
    const publicResult = (await call(`/api/public/${c.uploadToken}`, undefined, 'GET')).json()
      .collection
    assert.equal(publicResult.draftOrigin, undefined)
    assert.equal(publicResult.expectedSubmitters, undefined)
    assert.equal(
      publicResult.materials[1].description.includes(answer),
      true,
      '实际材料要求正常公开，私人来源记录不公开',
    )
    const template = (
      await call('/api/templates', { collectionId: c.id, name: '人工确认材料模板' })
    ).json()
    assert.equal(template.rules.materials.length, 3)
    assert.equal(template.rules.draftOrigin, undefined)
    const updated = await call(
      `/api/collections/${c.id}`,
      { ...oldRules, title: c.title, description: '人工改规则', materials },
      'PATCH',
    )
    assert.equal(updated.statusCode, 200)
    assert.equal(store.collection(c.id)!.draftOrigin!.runId, draft.runId)
    assert.notEqual(store.collection(c.id)!.materialRevision, c.materialRevision)
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ai/collection-draft',
          headers: origin,
          payload: input,
        })
      ).statusCode,
      401,
    )
    assert.equal(
      (await call('/api/ai/collection-draft', input, 'POST', { ...headers, 'x-csrf-token': '' }))
        .statusCode,
      403,
    )
    await call('/api/users', {
      username: 'draft-reader',
      displayName: '只读',
      role: 'viewer',
      password: 'draft-read-only-password',
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: origin,
      payload: { username: 'draft-reader', password: 'draft-read-only-password' },
    })
    const viewer = {
      ...origin,
      cookie: login.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': login.json().csrf,
    }
    assert.equal((await call('/api/ai/collection-draft', input, 'POST', viewer)).statusCode, 403)
    assert.equal((await call('/api/collections', final, 'POST', viewer)).statusCode, 403)
    const skipped = await call('/api/collections', {
      ...final,
      title: '跳过澄清也能创建',
      draftConfirmation: {
        ...confirmation,
        resolutions: [{ id: draft.clarifications[0].id, skipped: true }],
      },
    })
    assert.equal(skipped.statusCode < 300, true, '发起人可以明确跳过澄清')
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})
