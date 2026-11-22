import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createApp } from './app.ts'
import type { Config } from './config.ts'
import type { CollectedFile } from '../src/types.ts'

test('回收站后端分页搜索与仅管理员可见的二次确认在线永久清理（含活跃打包并发防误删）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jiyu-purge-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 0,
    quotaBytes: 64 * 1024 * 1024,
    requestBytes: 16 * 1024 * 1024,
    secureCookie: false,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const origin = { origin: config.origin }
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: origin,
      payload: {
        setupToken: store.setupToken(),
        password: 'admin-purge-password',
        displayName: '管理员',
      },
    })
    assert.equal(setup.statusCode, 200)
    const adminHeaders = {
      ...origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf as string,
    }

    // 创建编辑者账号用于验证权限边界
    const editorCreate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: adminHeaders,
      payload: {
        username: 'editor1',
        displayName: '编辑成员',
        password: 'editor-strong-password',
        role: 'editor',
      },
    })
    assert.equal(editorCreate.statusCode, 200, editorCreate.body)
    const editorLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: origin,
      payload: { username: 'editor1', password: 'editor-strong-password' },
    })
    assert.equal(editorLogin.statusCode, 200)
    const editorHeaders = {
      ...origin,
      cookie: editorLogin.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': editorLogin.json().csrf as string,
    }

    const colRes = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers: adminHeaders,
      payload: {
        title: '回收站清理测试',
        description: '',
        category: 'document',
        formats: 'TXT',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 10,
        maxFilesPerSubmission: 5,
      },
    })
    const collectionId = colRes.json().collections[0].id as string

    const addFile = async (name: string, owner: string, content: string) => {
      const buf = Buffer.from(content)
      const key = randomUUID()
      const record: CollectedFile = {
        id: randomUUID(),
        name,
        size: buf.length,
        collectionId,
        owner,
        createdAt: new Date().toISOString(),
        storage: 'local',
        status: 'pending',
        sha256: createHash('sha256').update(buf).digest('hex'),
      }
      await writeFile(join(config.dataDir, 'objects', key), buf)
      store.addFile(record, key)
      return { record, key }
    }

    const f1 = await addFile('alpha.txt', '张三', '文件内容一')
    const f2 = await addFile('beta.txt', '李四', '文件内容二二二')
    const fActive = await addFile('keep.txt', '王五', '活跃文件')

    // 先对 f1 建立活跃打包计划，再将 f1/f2 移入回收站，模拟并发引用场景
    const planRes = await app.inject({
      method: 'POST',
      url: '/api/archives',
      headers: adminHeaders,
      payload: { ids: [f1.record.id], layout: 'flat' },
    })
    assert.equal(planRes.statusCode, 200)
    const planId = planRes.json().id as string

    const trashRes = await app.inject({
      method: 'POST',
      url: '/api/files/trash',
      headers: adminHeaders,
      payload: { ids: [f1.record.id, f2.record.id] },
    })
    assert.equal(trashRes.statusCode, 200)

    // 验证回收站分页与搜索接口
    const trashQuery = await app.inject({
      method: 'GET',
      url: '/api/files?trashed=true&q=beta&sort=size_desc&page=1&pageSize=20',
      headers: adminHeaders,
    })
    assert.equal(trashQuery.statusCode, 200)
    assert.equal(trashQuery.json().total, 1)
    assert.equal(trashQuery.json().items[0].id, f2.record.id)

    // 编辑者不可永久清理（403）
    const editorPurge = await app.inject({
      method: 'POST',
      url: '/api/files/purge',
      headers: editorHeaders,
      payload: { ids: [f2.record.id], confirm: 'PERMANENT_DELETE' },
    })
    assert.equal(editorPurge.statusCode, 403)

    // 缺少二次确认令牌（400）
    const noConfirm = await app.inject({
      method: 'POST',
      url: '/api/files/purge',
      headers: adminHeaders,
      payload: { ids: [f2.record.id] },
    })
    assert.equal(noConfirm.statusCode, 400)

    // 不允许直接永久清理活跃文件（409）
    const purgeActive = await app.inject({
      method: 'POST',
      url: '/api/files/purge',
      headers: adminHeaders,
      payload: { ids: [fActive.record.id], confirm: 'PERMANENT_DELETE' },
    })
    assert.equal(purgeActive.statusCode, 409)

    // 被活跃打包计划引用的回收站文件拒绝清理（409）
    const blockedByArchive = await app.inject({
      method: 'POST',
      url: '/api/files/purge',
      headers: adminHeaders,
      payload: { ids: [f1.record.id], confirm: 'PERMANENT_DELETE' },
    })
    assert.equal(blockedByArchive.statusCode, 409)
    assert.match(blockedByArchive.json().error, /打包任务引用/)
    assert.equal(existsSync(join(config.dataDir, 'objects', f1.key)), true)

    // 取消打包计划后，管理员可永久清理 f1 与 f2，数据库记录与物理正文同步释放
    await app.inject({ method: 'DELETE', url: `/api/archives/${planId}`, headers: adminHeaders })
    const purged = await app.inject({
      method: 'POST',
      url: '/api/files/purge',
      headers: adminHeaders,
      payload: { ids: [f1.record.id, f2.record.id], confirm: 'PERMANENT_DELETE' },
    })
    assert.equal(purged.statusCode, 200, purged.body)
    assert.equal(purged.json().purged, 2)
    assert.equal(purged.json().freedBytes, f1.record.size + f2.record.size)
    assert.equal(purged.json().workspace.trash.length, 0)
    assert.equal(existsSync(join(config.dataDir, 'objects', f1.key)), false)
    assert.equal(existsSync(join(config.dataDir, 'objects', f2.key)), false)
    assert.equal(existsSync(join(config.dataDir, 'objects', fActive.key)), true)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
