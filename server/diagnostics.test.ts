import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { DiagnosticItem } from '../src/types.ts'

test('部署检查读取真实环境、提示 HTTP 与未配置备份，临时探针不残留', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'diagnostics-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, quotaBytes: 1024 ** 3, requestBytes: 1024 ** 2, secureCookie: false }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const origin = { origin: config.origin }
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/diagnostics', headers: origin, payload: {} })).statusCode, 401)
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: origin, payload: { setupToken: store.setupToken(), password: 'test-diagnostics-password', displayName: '环境测试' } })
    const headers = { ...origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const workspace = await app.inject({ method: 'GET', url: '/api/workspace', headers })
    assert.equal(workspace.json().requestLimitMB, 1)
    const checked = await app.inject({ method: 'POST', url: '/api/settings/diagnostics', headers, payload: {} })
    assert.equal(checked.statusCode, 200, checked.body)
    const rows = checked.json().items as DiagnosticItem[]
    assert.equal(rows.find(r => r.id === 'data')?.state, 'ok'); assert.equal(rows.find(r => r.id === 'database')?.state, 'ok')
    assert.equal(rows.find(r => r.id === 'origin')?.state, 'attention'); assert.equal(rows.find(r => r.id === 'backup')?.state, 'attention')
    assert.equal(rows.length, 7); assert.deepEqual(await readdir(join(config.dataDir, 'tmp')), [])
    assert.equal(store.files().length, 0)
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
