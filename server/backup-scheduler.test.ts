import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createApp } from './app.ts'
import { createOnlineBackup, restoreBackup } from './backup.ts'
import type { Config } from './config.ts'

test('在线备份可恢复正文，保留策略只删除自己的完整快照', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'online-backup-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    secureCookie: false,
    quotaBytes: 1024 ** 2,
    requestBytes: 1024 ** 2,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: config.origin },
      payload: {
        setupToken: store.setupToken(),
        displayName: '备份',
        password: 'test-backup-password',
      },
    })
    const headers = {
      origin: config.origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    const task = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers,
      payload: {
        title: '资料',
        category: 'document',
        description: '',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 1,
        maxFilesPerSubmission: 2,
      },
    })
    const c = task.json().collections[0],
      key = randomUUID(),
      content = Buffer.from('在线备份正文')
    await writeFile(join(config.dataDir, 'objects', key), content)
    store.addFile(
      {
        id: randomUUID(),
        name: '资料.txt',
        size: content.length,
        collectionId: c.id,
        owner: '小屿',
        createdAt: new Date().toISOString(),
        storage: 'local',
        status: 'pending',
        sha256: createHash('sha256').update(content).digest('hex'),
      },
      key,
    )
    const backupDir = join(dir, 'snapshot')
    assert.equal((await createOnlineBackup(store, backupDir)).files, 1)
    assert.deepEqual(await readFile(join(backupDir, 'objects', key)), content)
    await restoreBackup(backupDir, join(dir, 'restored'))
    const dest = join(dir, 'backups')
    await mkdir(dest, { recursive: true })
    await mkdir(join(dest, 'unrelated'))
    await writeFile(join(dest, 'unrelated', 'keep.txt'), 'preserve')
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/backups/settings',
          headers,
          payload: { enabled: false, intervalHours: 24, keep: 1 },
        })
      ).statusCode,
      200,
    )
    for (let i = 0; i < 2; i++) {
      const start = await app.inject({
        method: 'POST',
        url: '/api/backups/run',
        headers,
        payload: {},
      })
      assert.equal(start.statusCode, 202)
      for (let n = 0; n < 100; n++) {
        const info = await app.inject({ method: 'GET', url: '/api/backups', headers })
        if (info.json().lastRun.status !== 'running') {
          assert.equal(info.json().lastRun.status, 'succeeded', info.body)
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    const info = await app.inject({ method: 'GET', url: '/api/backups', headers })
    assert.equal(info.json().backups.length, 1)
    assert.equal(info.json().maxKeep, 30)
    assert.equal(await readFile(join(dest, 'unrelated', 'keep.txt'), 'utf8'), 'preserve')
    await assert.rejects(createOnlineBackup(store, join(config.dataDir, 'nested')), /互相独立/)
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})

test('在线备份失败时清理半成品目录但不影响已有备份，且 /api/backups 同步 maxKeep 上限', async () => {
  const prevMaxKeep = process.env.JIYU_BACKUP_MAX_KEEP
  process.env.JIYU_BACKUP_MAX_KEEP = '3'
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'online-backup-fail-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    secureCookie: false,
    quotaBytes: 1024 ** 2,
    requestBytes: 1024 ** 2,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: config.origin },
      payload: {
        setupToken: store.setupToken(),
        displayName: '备份',
        password: 'test-backup-password',
      },
    })
    const headers = {
      origin: config.origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    const initial = (await app.inject({ method: 'GET', url: '/api/backups', headers })).json()
    assert.equal(initial.maxKeep, 3)
    assert.equal(initial.settings.keep, 3)
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/backups/settings',
          headers,
          payload: { enabled: false, intervalHours: 24, keep: 4 },
        })
      ).statusCode,
      400,
    )
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/backups/settings',
      headers,
      payload: { enabled: false, intervalHours: 24, keep: 3 },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().maxKeep, 3)

    // Complete one valid backup first.
    const waitBackup = async () => {
      for (let n = 0; n < 200; n++) {
        const res = (await app.inject({ method: 'GET', url: '/api/backups', headers })).json()
        if (res.lastRun?.status !== 'running') return res
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('backup timeout')
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/backups/run', headers, payload: {} }))
        .statusCode,
      202,
    )
    const first = await waitBackup()
    assert.equal(first.lastRun.status, 'succeeded')
    assert.equal(first.backups.length, 1)
    const validId = first.backups[0].id as string

    // Inject a missing object file so the next online backup fails halfway after creating its target dir.
    const task = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers,
      payload: {
        title: '损坏对象',
        category: 'document',
        description: '',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 1,
        maxFilesPerSubmission: 2,
      },
    })
    store.addFile(
      {
        id: randomUUID(),
        name: '缺失.txt',
        size: 12,
        collectionId: task.json().collections[0].id,
        owner: '测试',
        createdAt: new Date().toISOString(),
        storage: 'local',
        status: 'pending',
        sha256: '0'.repeat(64),
      },
      randomUUID(),
    )

    const failedStart = await app.inject({
      method: 'POST',
      url: '/api/backups/run',
      headers,
      payload: {},
    })
    assert.equal(failedStart.statusCode, 202)
    const failedId = failedStart.json().id as string
    const afterFail = await waitBackup()
    assert.equal(afterFail.lastRun.status, 'failed')
    assert.equal(afterFail.backups.length, 1)
    assert.equal(afterFail.backups[0].id, validId)
    const entries = await readdir(join(dir, 'backups'))
    assert.deepEqual(entries, [validId], `失败的半成品目录 ${failedId} 应已被清理，只保留完整备份`)
  } finally {
    await app.close()
    if (prevMaxKeep === undefined) delete process.env.JIYU_BACKUP_MAX_KEEP
    else process.env.JIYU_BACKUP_MAX_KEEP = prevMaxKeep
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})
