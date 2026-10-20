import { backup, DatabaseSync } from 'node:sqlite'
import { createReadStream } from 'node:fs'
import { mkdir, copyFile, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from './store.ts'

async function checksum(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function separate(a: string, b: string) {
  const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || (!path.startsWith('..') && !isAbsolute(path)) }
  if (inside(a, b) || inside(b, a)) throw new Error('备份与数据目录必须互相独立')
}
interface Manifest { version: 1; createdAt: string; databaseSha256: string; files: { key: string; size: number; sha256: string }[] }

export async function createBackup(dataDir: string, destination: string) {
  dataDir = resolve(dataDir); destination = resolve(destination); separate(dataDir, destination)
  const store = new Store(dataDir)
  try {
    await mkdir(destination, { mode: 0o700 })
    await mkdir(join(destination, 'objects'), { mode: 0o700 })
    await backup(store.db, join(destination, 'jiyu.sqlite'))
    const files = []
    for (const file of store.files()) {
      const key = store.fileKey(file.id)!, source = join(dataDir, 'objects', key), target = join(destination, 'objects', key)
      if (await checksum(source) !== file.sha256) throw new Error('文件校验不通过，备份未完成')
      await copyFile(source, target)
      files.push({ key, size: file.size, sha256: file.sha256! })
    }
    const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), databaseSha256: await checksum(join(destination, 'jiyu.sqlite')), files }
    // 最后写清单；没有清单的目录不视为有效备份。
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
    return { files: files.length, destination }
  } finally { store.close() }
}

export async function restoreBackup(source: string, destination: string) {
  source = resolve(source); destination = resolve(destination); separate(source, destination)
  if ((await stat(join(source, 'manifest.json'))).size > 10 * 1024 ** 2) throw new Error('备份清单过大')
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as Manifest
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.databaseSha256)) throw new Error('备份清单无效')
  if (await checksum(join(source, 'jiyu.sqlite')) !== manifest.databaseSha256) throw new Error('数据库校验失败')
  for (const file of manifest.files) {
    if (!/^[a-f0-9-]{36}$/.test(file.key) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('备份文件条目无效')
    if ((await stat(join(source, 'objects', file.key))).size !== file.size || await checksum(join(source, 'objects', file.key)) !== file.sha256) throw new Error('备份文件校验失败')
  }
  const db = new DatabaseSync(join(source, 'jiyu.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT storage_key,data FROM files').all() as { storage_key: string; data: string }[]
    if (rows.length !== manifest.files.length || rows.some(row => { const entry = manifest.files.find(f => f.key === row.storage_key); const data = JSON.parse(row.data); return !entry || entry.size !== data.size || entry.sha256 !== data.sha256 })) throw new Error('清单与数据库不一致')
    const integrity = db.prepare('PRAGMA integrity_check').get() as Record<string, string>
    if (Object.values(integrity)[0] !== 'ok') throw new Error('数据库完整性检查失败')
  } finally { db.close() }
  await mkdir(destination, { mode: 0o700 }) // 必须是全新目录，永不覆盖现有数据。
  await mkdir(join(destination, 'objects'), { mode: 0o700 })
  await copyFile(join(source, 'jiyu.sqlite'), join(destination, 'jiyu.sqlite'))
  for (const file of manifest.files) await copyFile(join(source, 'objects', file.key), join(destination, 'objects', file.key))
  const restored = new Store(destination)
  try { restored.db.exec('DELETE FROM sessions'); restored.activity('从已校验的备份恢复数据，旧登录会话已撤销') } finally { restored.close() }
  return { files: manifest.files.length, destination }
}

export async function pruneTrash(dataDir: string, backupDir: string) {
  // 完整备份成功后才进入不可逆清理；应用必须保持停止。
  await createBackup(dataDir, backupDir)
  const store = new Store(resolve(dataDir))
  try {
    const files = store.files().filter(f => f.deletedAt), keys = files.map(f => store.fileKey(f.id)!)
    store.transaction(() => { for (const file of files) store.db.prepare('DELETE FROM files WHERE id=?').run(file.id); store.activity(`离线清理了回收站中的 ${files.length} 个文件，已先完成完整备份`) })
    for (const key of keys) { if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('存储键无效'); await rm(join(dataDir, 'objects', key), { force: true }) }
    return { files: files.length, destination: resolve(backupDir) }
  } finally { store.close() }
}
