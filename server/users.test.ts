import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createApp } from './app.ts'
import type { Config } from './config.ts'

test('成员角色由服务端约束，撤销旧会话并保留最后一位管理员', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'members-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const origin = { origin: config.origin }
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: origin, payload: { setupToken: store.setupToken(), displayName: '管理者', password: 'test-admin-password' } })
    const headers = (r: typeof setup) => ({ ...origin, cookie: r.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': r.json().csrf })
    const admin = headers(setup)
    assert.equal(setup.json().user.username, 'admin')
    const add = async (username: string, role: string) => app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { username, role, displayName: username, password: 'test-member-password' } })
    assert.equal((await add('reader', 'viewer')).statusCode, 200)
    const added = await add('writer', 'editor'), editorId = added.json().find((u: { username: string }) => u.username === 'writer').id
    assert.ok(!added.body.includes('scrypt'))
    assert.equal((await add('READER', 'viewer')).statusCode, 409)
    const login = async (username: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: origin, payload: { username, password: 'test-member-password' } })
    const editor = headers(await login('writer')), viewer = headers(await login('reader'))
    const taskDraft = { title: '团队收集', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 2 }
    assert.equal((await app.inject({ method: 'POST', url: '/api/collections', headers: editor, payload: taskDraft })).statusCode, 200)
    for (const url of ['/api/users', '/api/backups', '/api/settings', '/api/ai/settings', '/api/storage/connections/webdav']) assert.equal((await app.inject({ method: 'PATCH', url, headers: editor, payload: {} })).statusCode, 403, url)
    assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: viewer })).statusCode, 403)
    const view = await app.inject({ method: 'GET', url: '/api/workspace', headers: viewer })
    assert.equal(view.statusCode, 200); assert.equal(view.json().collections[0].uploadToken, undefined)
    assert.equal((await app.inject({ method: 'POST', url: '/api/collections', headers: viewer, payload: taskDraft })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/templates', headers: viewer, payload: {} })).statusCode, 403)
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/templates/unknown', headers: viewer, payload: { archived: true } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/diagnostics', headers: editor, payload: {} })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/api/templates', headers: viewer })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/api/files/trash', headers: viewer, payload: { ids: ['anything'] } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/users/primary', headers: admin, payload: { role: 'viewer' } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/users/${editorId}`, headers: admin, payload: { disabled: true } })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspace', headers: editor })).statusCode, 401)
    assert.equal((await login('writer')).statusCode, 401)
    const change = await app.inject({ method: 'POST', url: '/api/auth/password', headers: viewer, payload: { currentPassword: 'test-member-password', password: 'new-member-password' } })
    assert.equal(change.statusCode, 200)
    assert.equal(change.json().user.role, 'viewer')
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspace', headers: viewer })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspace', headers: admin })).statusCode, 200)
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
