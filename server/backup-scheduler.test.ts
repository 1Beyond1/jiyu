import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createApp } from './app.ts'
import { createOnlineBackup, restoreBackup } from './backup.ts'
import type { Config } from './config.ts'

test('在线备份可恢复正文，保留策略只删除自己的完整快照', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'online-backup-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: store.setupToken(), displayName: '备份', password: 'test-backup-password' } })
    const headers = { origin: config.origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const task = await app.inject({ method: 'POST', url: '/api/collections', headers, payload: { title: '资料', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 2 } })
    const c = task.json().collections[0], key = randomUUID(), content = Buffer.from('在线备份正文')
    await writeFile(join(config.dataDir, 'objects', key), content)
    store.addFile({ id: randomUUID(), name: '资料.txt', size: content.length, collectionId: c.id, owner: '小屿', createdAt: new Date().toISOString(), storage: 'local', status: 'pending', sha256: createHash('sha256').update(content).digest('hex') }, key)
    const backupDir = join(dir, 'snapshot')
    assert.equal((await createOnlineBackup(store, backupDir)).files, 1)
    assert.deepEqual(await readFile(join(backupDir, 'objects', key)), content)
    await restoreBackup(backupDir, join(dir, 'restored'))
    const dest = join(dir, 'backups'); await mkdir(dest, { recursive: true }); await mkdir(join(dest, 'unrelated'))
    await writeFile(join(dest, 'unrelated', 'keep.txt'), 'preserve')
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/backups/settings', headers, payload: { enabled: false, intervalHours: 24, keep: 1 } })).statusCode, 200)
    for (let i = 0; i < 2; i++) {
      const start = await app.inject({ method: 'POST', url: '/api/backups/run', headers, payload: {} }); assert.equal(start.statusCode, 202)
      for (let n = 0; n < 100; n++) { const info = await app.inject({ method: 'GET', url: '/api/backups', headers }); if (info.json().lastRun.status !== 'running') { assert.equal(info.json().lastRun.status, 'succeeded', info.body); break }; await new Promise(r => setTimeout(r, 10)) }
    }
    const info = await app.inject({ method: 'GET', url: '/api/backups', headers })
    assert.equal(info.json().backups.length, 1)
    assert.equal(await readFile(join(dest, 'unrelated', 'keep.txt'), 'utf8'), 'preserve')
    await assert.rejects(createOnlineBackup(store, join(config.dataDir, 'nested')), /互相独立/)
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
