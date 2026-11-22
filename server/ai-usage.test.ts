import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { tokenUsage } from './ai-usage.ts'
import { createApp } from './app.ts'

test('真实网关非标准推理计数、标准嵌套推理与缺失用量如实区分', () => {
  const raw = { prompt_tokens: 18, completion_tokens: 5, total_tokens: 121, reasoning_tokens: 98 }
  assert.deepEqual(tokenUsage(raw).rawUsage, raw)
  assert.equal(tokenUsage(raw).tokens, 121)
  assert.equal(tokenUsage({ ...raw, total_tokens: 23 }).tokens, 121)
  assert.equal(
    tokenUsage({
      prompt_tokens: 18,
      completion_tokens: 103,
      total_tokens: 121,
      completion_tokens_details: { reasoning_tokens: 98 },
    }).tokens,
    121,
  )
  assert.equal(
    tokenUsage({
      input_tokens: 18,
      output_tokens: 103,
      total_tokens: 121,
      output_tokens_details: { reasoning_tokens: 98 },
    }).tokens,
    121,
  )
  assert.equal(tokenUsage(undefined).tokens, null)
  assert.equal(tokenUsage({ prompt_tokens: 18 }).tokens, null)
  assert.equal(tokenUsage({ prompt_tokens: 18 }).knownLowerBound, 18)
  assert.equal(tokenUsage({ total_tokens: -1 }).tokens, null)
  assert.equal(tokenUsage({ total_tokens: 0 }).tokens, 0)
})

test('回复拒绝仍记真实用量，缺失usage不记0，正常API隐藏密钥并保留统计', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'ai-usage-test-'))
  assert(dir.startsWith(root + sep))
  let mode = 'refusal'
  const { app, store } = await createApp(
    {
      dataDir: join(dir, 'data'),
      host: '127.0.0.1',
      port: 0,
      origin: 'http://127.0.0.1:3000',
      quotaBytes: 1024 ** 2,
      requestBytes: 1024 ** 2,
      secureCookie: false,
    },
    {
      serveFrontend: false,
      aiTransport: async (req) => {
        req.onResponse?.(200)
        return {
          choices: [
            {
              finish_reason: mode === 'refusal' ? 'length' : 'stop',
              message: { content: '{"reply":"先人工核对","renames":[]}' },
            },
          ],
          ...(mode === 'unknown'
            ? {}
            : {
                usage: {
                  prompt_tokens: 18,
                  completion_tokens: 5,
                  total_tokens: 121,
                  reasoning_tokens: 98,
                },
              }),
        }
      },
    },
  )
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        setupToken: store.setupToken(),
        displayName: '合成用量验证',
        password: 'usage-synthetic-admin',
      },
    })
    const headers = {
      origin: 'http://127.0.0.1:3000',
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/ai/settings',
      headers,
      payload: {
        baseUrl: 'https://example.com/v1',
        model: 'synthetic-model',
        apiKey: 'synthetic-unit-secret',
        protocol: 'chat',
        enabled: true,
        maxDailyCalls: 8,
      },
    })
    assert.equal(saved.statusCode, 200)
    const invoke = () =>
      app.inject({
        method: 'POST',
        url: '/api/ai/chat',
        headers,
        payload: {
          consent: true,
          prompt: '给出本地人工整理建议',
          fileIds: [],
          settingsRevision: saved.json().revision,
        },
      })
    assert.equal((await invoke()).statusCode, 502)
    let runs = await app.inject({ method: 'GET', url: '/api/ai/history', headers })
    assert.equal(runs.json()[0].tokens, 121)
    assert.equal(runs.json()[0].accounting.rawUsage.reasoning_tokens, 98)
    assert.equal(runs.json()[0].accounting.httpStatus, 200)
    assert.equal(runs.json()[0].accounting.cost, null)
    mode = 'unknown'
    assert.equal((await invoke()).json().tokens, null)
    runs = await app.inject({ method: 'GET', url: '/api/ai/history', headers })
    assert.equal(runs.json()[0].tokens, null)
    assert.equal(runs.json()[0].accounting.basis, 'unknown')
    assert.equal(
      (
        store.db.prepare('SELECT tokens FROM ai_runs ORDER BY rowid DESC LIMIT 1').get() as {
          tokens: number
        }
      ).tokens,
      -1,
    )
    mode = 'valid'
    assert.equal((await invoke()).json().tokens, 121)
    runs = await app.inject({ method: 'GET', url: '/api/ai/history', headers })
    assert.equal(runs.body.includes('synthetic-unit-secret'), false)
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/ai/settings', headers })).json().usedToday,
      3,
    )
    assert(
      runs
        .json()
        .every(
          (r: any) => r.accounting.inputHash.length === 64 && r.accounting.costStatus === 'unknown',
        ),
    )
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
