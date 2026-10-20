import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from './store.ts'
import { createBackup, restoreBackup } from './backup.ts'

test('升级前备份保留 v0.2 schema，恢复后才迁移且不修改旧快照', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'backup-test-')), dataDir = join(dir, 'data'), backupDir = join(dir, 'backup')
  try {
    const store = new Store(dataDir)
    store.set('fixture', '升级前的设置')
    store.db.exec('DROP TABLE ai_runs; DROP TABLE ai_usage; PRAGMA user_version=1;')
    store.close()
    await createBackup(dataDir, backupDir)
    assert.equal(JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8')).version, 1)
    for (const directory of [dataDir, backupDir]) {
      const db = new DatabaseSync(join(directory, 'jiyu.sqlite'), { readOnly: true })
      try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1) } finally { db.close() }
    }
    await restoreBackup(backupDir, join(dir, 'restored'))
    const restored = new Store(join(dir, 'restored'))
    try { assert.equal(restored.db.prepare('PRAGMA user_version').get()!.user_version, 2); assert.equal(restored.get('fixture'), '升级前的设置') } finally { restored.close() }
    const snapshot = new DatabaseSync(join(backupDir, 'jiyu.sqlite'), { readOnly: true })
    try { assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 1) } finally { snapshot.close() }
  } finally { if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})

test('凭证主密钥缺失或损坏不能生成可用备份或恢复', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'backup-key-test-')), dataDir = join(dir, 'data')
  try {
    const store = new Store(dataDir)
    store.set('ai.settings', JSON.stringify({ encryptedKey: 'fixture-ciphertext' }))
    store.close()
    await assert.rejects(createBackup(dataDir, join(dir, 'missing')), /主密钥缺失/)
    assert.equal(existsSync(join(dir, 'missing', 'manifest.json')), false)
    await writeFile(join(dataDir, 'secrets.key'), Buffer.alloc(4))
    await assert.rejects(createBackup(dataDir, join(dir, 'invalid')), /主密钥无效/)
    await writeFile(join(dataDir, 'secrets.key'), Buffer.alloc(32, 7))
    await createBackup(dataDir, join(dir, 'backup'))
    await writeFile(join(dir, 'backup', 'secrets.key'), Buffer.alloc(32, 8))
    await assert.rejects(restoreBackup(join(dir, 'backup'), join(dir, 'restored')), /主密钥校验失败/)
    assert.equal(existsSync(join(dir, 'restored')), false)
  } finally { if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
