import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.ts'
import { CHUNK_BYTES } from './uploads.ts'
import type { Config } from './config.ts'

// CI extracts the actual v0.3.0 tag into an ignored directory; no legacy source is vendored.
test('真实 v0.3 升级：原账号、正文、续传保留，旧快照可由旧工具回退', { skip: !process.env.JIYU_LEGACY_ROOT }, async () => {
  const legacyRoot = resolve(process.env.JIYU_LEGACY_ROOT!), root = resolve('.artifacts')
  await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'upgrade-drill-'))
  const legacy = await import(pathToFileURL(join(legacyRoot, 'server/app.ts')).href) as { createApp: typeof createApp }
  const legacyBackup = await import(pathToFileURL(join(legacyRoot, 'server/backup.ts')).href) as typeof import('./backup.ts')
  const config: Config = { dataDir: join(dir, 'data'), host: '127.0.0.1', port: 0, origin: 'http://127.0.0.1:3000', quotaBytes: CHUNK_BYTES * 4, requestBytes: CHUNK_BYTES * 2, secureCookie: false }
  let service = await legacy.createApp(config, { serveFrontend: false })
  const headers = { origin: config.origin }, key = { ...headers, 'x-upload-key': 'u'.repeat(64) }
  const schema = (directory: string) => { const db = new DatabaseSync(join(directory, 'jiyu.sqlite'), { readOnly: true }); try { return db.prepare('PRAGMA user_version').get()!.user_version } finally { db.close() } }
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  try {
    assert.equal(schema(config.dataDir), 4)
    const setup = await service.app.inject({ method: 'POST', url: '/api/auth/setup', headers, payload: { setupToken: service.store.setupToken(), password: 'upgrade-drill-password', displayName: '升级演练' } })
    const admin = { ...headers, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const task = await service.app.inject({ method: 'POST', url: '/api/collections', headers: admin, payload: { title: '旧版任务', category: 'document', description: '', formats: 'TXT', deadline: '2099-12-31', target: 10, maxFileSizeMB: 16, maxFilesPerSubmission: 2 } })
    assert.equal(task.statusCode, 200, task.body)
    const c = task.json().collections[0], passwordHash = service.store.get('password')
    const start = async (name: string, size: number) => {
      const url = `/api/public/${c.uploadToken}/uploads/${randomUUID()}`
      const result = await service.app.inject({ method: 'POST', url, headers: key, payload: { owner: '旧用户', files: [{ name, size, lastModified: 1 }] } })
      assert.equal(result.statusCode, 200, result.body); return url
    }
    const part = async (url: string, index: number, bytes: Buffer) => {
      const result = await service.app.inject({ method: 'PUT', url: `${url}/0/${index}`, headers: { ...key, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha(bytes) }, payload: bytes })
      assert.equal(result.statusCode, 200, result.body)
    }
    const savedUrl = await start('已收.txt', 3); await part(savedUrl, 0, Buffer.from('old'))
    const saved = await service.app.inject({ method: 'POST', url: savedUrl + '/complete', headers: key, payload: {} })
    assert.equal(saved.statusCode, 201, saved.body)
    const originalFile = service.store.files()[0], originalKey = service.store.fileKey(originalFile.id)!
    const pendingUrl = await start('续传.txt', CHUNK_BYTES + 7); await part(pendingUrl, 0, Buffer.alloc(CHUNK_BYTES, 65))
    await service.app.close()
    const backupDir = join(dir, 'before-upgrade')
    await legacyBackup.createBackup(config.dataDir, backupDir)
    const snapshotHash = sha(await readFile(join(backupDir, 'jiyu.sqlite')))
    assert.equal(schema(backupDir), 4)

    service = await createApp(config, { serveFrontend: false })
    assert.equal(schema(config.dataDir), 5); assert.equal(service.store.get('password'), passwordHash)
    const login = await service.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'admin', password: 'upgrade-drill-password' } })
    assert.equal(login.statusCode, 200, login.body)
    assert.deepEqual(await readFile(join(config.dataDir, 'objects', originalKey)), Buffer.from('old'))
    assert.equal((await service.app.inject({ method: 'GET', url: savedUrl, headers: key })).json().receipt.receiptId, saved.json().receiptId)
    assert.equal((await service.app.inject({ method: 'GET', url: pendingUrl, headers: key })).json().parts.length, 1)
    await part(pendingUrl, 1, Buffer.from('newtail'))
    const completed = await service.app.inject({ method: 'POST', url: pendingUrl + '/complete', headers: key, payload: {} })
    assert.equal(completed.statusCode, 201, completed.body)
    const resumedFile = service.store.files().find(f => f.name === '续传.txt')!
    assert.equal(resumedFile.sha256, sha(Buffer.concat([Buffer.alloc(CHUNK_BYTES, 65), Buffer.from('newtail')])))
    assert.equal(service.store.files().length, 2); assert.equal(service.store.collection(c.id)!.received, 2)
    await service.app.close()
    await assert.rejects(legacy.createApp(config, { serveFrontend: false }), /数据库版本高于当前应用/)

    const rollbackDir = join(dir, 'rollback')
    await legacyBackup.restoreBackup(backupDir, rollbackDir)
    assert.equal(schema(rollbackDir), 4)
    service = await legacy.createApp({ ...config, dataDir: rollbackDir }, { serveFrontend: false })
    assert.equal(service.store.files().length, 1); assert.equal(service.store.pendingBytes(), 0)
    assert.deepEqual(await readdir(join(rollbackDir, 'chunks')), [])
    assert.equal((await service.app.inject({ method: 'GET', url: '/api/workspace', headers: admin })).statusCode, 401)
    const rollbackLogin = await service.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'admin', password: 'upgrade-drill-password' } })
    assert.equal(rollbackLogin.statusCode, 200, rollbackLogin.body)
    const download = await service.app.inject({ method: 'GET', url: `/api/files/${originalFile.id}/download`, headers: { cookie: rollbackLogin.headers['set-cookie']!.toString().split(';')[0] } })
    assert.equal(download.statusCode, 200); assert.equal(download.body, 'old')
    assert.equal(sha(await readFile(join(backupDir, 'jiyu.sqlite'))), snapshotHash)
    assert.equal(schema(backupDir), 4)
  } finally { await service.app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
