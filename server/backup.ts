import { backup, DatabaseSync } from 'node:sqlite'
import { createReadStream, existsSync } from 'node:fs'
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
export interface Manifest { version: 1 | 2; createdAt: string; databaseSha256: string; secretKeySha256?: string; files: { key: string; size: number; sha256: string }[] }

async function writeSnapshot(db: DatabaseSync, dataDir: string, destination: string) {
  await mkdir(destination, { mode: 0o700 })
  await mkdir(join(destination, 'objects'), { mode: 0o700 })
  await backup(db, join(destination, 'jiyu.sqlite'))
  const snapshot = new DatabaseSync(join(destination, 'jiyu.sqlite'), { readOnly: true })
  let rows: { storage_key: string; data: string }[], schema: number
  try {
    schema = (snapshot.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (schema < 1 || schema > 4) throw new Error('数据库版本不受当前备份工具支持')
    const ai = snapshot.prepare("SELECT value FROM settings WHERE key='ai.settings'").get() as { value: string } | undefined
    if (ai && JSON.parse(ai.value).encryptedKey && !existsSync(join(dataDir, 'secrets.key'))) throw new Error('模型凭证主密钥缺失，备份未完成')
    const storage = snapshot.prepare("SELECT value FROM settings WHERE key LIKE 'storage.%'").all() as { value: string }[]
    if (storage.some(s => JSON.parse(s.value).encryptedCredentials) && !existsSync(join(dataDir, 'secrets.key'))) throw new Error('存储凭证主密钥缺失，备份未完成')
    rows = snapshot.prepare('SELECT storage_key,data FROM files').all() as { storage_key: string; data: string }[]
  } finally { snapshot.close() }
  if (existsSync(join(dataDir, 'secrets.key')) && (await stat(join(dataDir, 'secrets.key'))).size !== 32) throw new Error('模型凭证主密钥无效，备份未完成')
  const files = []
  for (const row of rows) {
    const file = JSON.parse(row.data) as { size: number; sha256: string }, key = row.storage_key
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('存储键无效')
    const source = join(dataDir, 'objects', key), target = join(destination, 'objects', key)
    await copyFile(source, target)
    if ((await stat(target)).size !== file.size || await checksum(target) !== file.sha256) throw new Error('文件校验不通过，备份未完成')
    files.push({ key, size: file.size, sha256: file.sha256 })
  }
  let secretKeySha256: string | undefined
  if (existsSync(join(dataDir, 'secrets.key'))) { await copyFile(join(dataDir, 'secrets.key'), join(destination, 'secrets.key')); secretKeySha256 = await checksum(join(destination, 'secrets.key')) }
  const manifest: Manifest = { version: schema === 1 && !secretKeySha256 ? 1 : 2, createdAt: new Date().toISOString(), databaseSha256: await checksum(join(destination, 'jiyu.sqlite')), secretKeySha256, files }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
  return { files: files.length, destination }
}

export async function createOnlineBackup(store: Store, destination: string) {
  destination = resolve(destination); separate(resolve(store.dataDir), destination)
  // All committed objects are immutable. Online deletion is deliberately unavailable.
  return writeSnapshot(store.db, store.dataDir, destination)
}

export async function createBackup(dataDir: string, destination: string) {
  dataDir = resolve(dataDir); destination = resolve(destination); separate(dataDir, destination)
  // 备份不运行 schema 迁移，升级前的旧版快照才能用于回退。
  const lock = new DatabaseSync(join(dataDir, 'service-lock.sqlite'))
  try { lock.exec('BEGIN EXCLUSIVE') } catch { lock.close(); throw new Error('数据目录正被使用，请先停止集屿服务') }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(join(dataDir, 'jiyu.sqlite'), { readOnly: true })
    return await writeSnapshot(db, dataDir, destination)
  } finally { db?.close(); lock.exec('ROLLBACK'); lock.close() }
}

export async function restoreBackup(source: string, destination: string) {
  source = resolve(source); destination = resolve(destination); separate(source, destination)
  if ((await stat(join(source, 'manifest.json'))).size > 10 * 1024 ** 2) throw new Error('备份清单过大')
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as Manifest
  if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.databaseSha256)) throw new Error('备份清单无效')
  if (manifest.secretKeySha256 !== undefined && (!/^[a-f0-9]{64}$/.test(manifest.secretKeySha256) || (await stat(join(source, 'secrets.key'))).size !== 32 || await checksum(join(source, 'secrets.key')) !== manifest.secretKeySha256)) throw new Error('凭证主密钥校验失败')
  if (await checksum(join(source, 'jiyu.sqlite')) !== manifest.databaseSha256) throw new Error('数据库校验失败')
  for (const file of manifest.files) {
    if (!/^[a-f0-9-]{36}$/.test(file.key) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('备份文件条目无效')
    if ((await stat(join(source, 'objects', file.key))).size !== file.size || await checksum(join(source, 'objects', file.key)) !== file.sha256) throw new Error('备份文件校验失败')
  }
  const db = new DatabaseSync(join(source, 'jiyu.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT storage_key,data FROM files').all() as { storage_key: string; data: string }[]
    const ai = db.prepare("SELECT value FROM settings WHERE key='ai.settings'").get() as { value: string } | undefined
    if (ai && JSON.parse(ai.value).encryptedKey && !manifest.secretKeySha256) throw new Error('备份缺少模型凭证主密钥')
    const storage = db.prepare("SELECT value FROM settings WHERE key LIKE 'storage.%'").all() as { value: string }[]
    if (storage.some(s => JSON.parse(s.value).encryptedCredentials) && !manifest.secretKeySha256) throw new Error('备份缺少存储凭证主密钥')
    if (rows.length !== manifest.files.length || rows.some(row => { const entry = manifest.files.find(f => f.key === row.storage_key); const data = JSON.parse(row.data); return !entry || entry.size !== data.size || entry.sha256 !== data.sha256 })) throw new Error('清单与数据库不一致')
    const integrity = db.prepare('PRAGMA integrity_check').get() as Record<string, string>
    if (Object.values(integrity)[0] !== 'ok') throw new Error('数据库完整性检查失败')
  } finally { db.close() }
  await mkdir(destination, { mode: 0o700 }) // 必须是全新目录，永不覆盖现有数据。
  await mkdir(join(destination, 'objects'), { mode: 0o700 })
  await copyFile(join(source, 'jiyu.sqlite'), join(destination, 'jiyu.sqlite'))
  if (manifest.secretKeySha256) await copyFile(join(source, 'secrets.key'), join(destination, 'secrets.key'))
  for (const file of manifest.files) await copyFile(join(source, 'objects', file.key), join(destination, 'objects', file.key))
  const restored = new Store(destination)
  try { restored.db.exec('DELETE FROM sessions; DELETE FROM uploads; DELETE FROM storage_oauth;'); restored.activity('从已校验的备份恢复数据，旧登录会话与未完成上传、授权流程已撤销') } finally { restored.close() }
  return { files: manifest.files.length, destination }
}

export async function pruneTrash(dataDir: string, backupDir: string) {
  // 完整备份成功后才进入不可逆清理；应用必须保持停止。
  await createBackup(dataDir, backupDir)
  const store = new Store(resolve(dataDir))
  try {
    const files = store.files().filter(f => f.deletedAt), keys = files.map(f => store.fileKey(f.id)!)
    store.transaction(() => { for (const file of files) { store.db.prepare('DELETE FROM content_search WHERE file_id=?').run(file.id); store.db.prepare('DELETE FROM files WHERE id=?').run(file.id) }; store.activity(`离线清理了回收站中的 ${files.length} 个文件，已先完成完整备份`) })
    for (const key of keys) { if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('存储键无效'); await rm(join(dataDir, 'objects', key), { force: true }) }
    return { files: files.length, destination: resolve(backupDir) }
  } finally { store.close() }
}
