import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { token } from './security.ts'
import type { Workspace, Collection, CollectedFile } from '../src/types.ts'

export class Store {
  db: DatabaseSync
  lock: DatabaseSync
  dataDir: string
  constructor(dataDir: string) {
    this.dataDir = dataDir
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.lock = new DatabaseSync(join(dataDir, 'service-lock.sqlite'))
    try { this.lock.exec('BEGIN EXCLUSIVE') } catch { this.lock.close(); throw new Error('数据目录正被使用，请先停止集屿服务') }
    this.db = new DatabaseSync(join(dataDir, 'jiyu.sqlite'))
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (schema.user_version > 2) { this.db.close(); this.lock.exec('ROLLBACK'); this.lock.close(); throw new Error('数据库版本高于当前应用，请使用匹配版本，禁止降级覆盖') }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), storage_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, time TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS renames (id TEXT PRIMARY KEY, data TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ai_runs (id TEXT PRIMARY KEY, model TEXT NOT NULL, fileCount INTEGER NOT NULL, status TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, proposalHash TEXT);
      CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL);
      PRAGMA user_version=2;`)
    for (const dir of ['objects', 'tmp']) mkdirSync(join(dataDir, dir), { recursive: true, mode: 0o700 })
    // 在获得目录互斥锁后恢复中断批次，已提交文件永不清理。
    for (const name of readdirSync(join(dataDir, 'tmp'))) rmSync(join(dataDir, 'tmp', name), { force: true })
    const keys = new Set((this.db.prepare('SELECT storage_key FROM files').all() as { storage_key: string }[]).map(r => r.storage_key))
    for (const name of readdirSync(join(dataDir, 'objects'))) if (/^[a-f0-9-]{36}$/.test(name) && !keys.has(name)) rmSync(join(dataDir, 'objects', name), { force: true })
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now())
    this.db.prepare("UPDATE ai_runs SET status='interrupted' WHERE status='pending'").run()
    if (!this.get('password') && !existsSync(join(dataDir, 'setup-token'))) writeFileSync(join(dataDir, 'setup-token'), token(), { mode: 0o600 })
  }
  get(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value }
  set(key: string, value: string) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  activity(text: string) {
    this.db.prepare('INSERT INTO activities(text,time) VALUES (?,?)').run(text, new Date().toISOString())
    this.db.exec('DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY id DESC LIMIT 1000)')
  }
  collection(id: string) { return this.collections().find(c => c.id === id) }
  byToken(value: string) {
    const row = this.db.prepare('SELECT data,token FROM collections WHERE token=?').get(value) as { data: string; token: string } | undefined
    return row ? { ...JSON.parse(row.data), uploadToken: row.token } as Collection : undefined
  }
  collections(): Collection[] { return (this.db.prepare('SELECT data,token FROM collections ORDER BY rowid DESC').all() as { data: string; token: string }[]).map(r => ({ ...JSON.parse(r.data), uploadToken: r.token })) }
  saveCollection(collection: Collection) {
    const { uploadToken, ...data } = collection
    this.db.prepare('INSERT INTO collections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,data=excluded.data').run(collection.id, uploadToken || token(), JSON.stringify(data))
  }
  files(): CollectedFile[] { return (this.db.prepare('SELECT data FROM files ORDER BY rowid DESC').all() as { data: string }[]).map(r => JSON.parse(r.data)) }
  saveFile(file: CollectedFile) { this.db.prepare('UPDATE files SET data=? WHERE id=?').run(JSON.stringify(file), file.id) }
  addFile(file: CollectedFile, key: string) { this.db.prepare('INSERT INTO files VALUES (?,?,?,?)').run(file.id, file.collectionId, key, JSON.stringify(file)) }
  fileKey(id: string) { return (this.db.prepare('SELECT storage_key FROM files WHERE id=?').get(id) as { storage_key: string } | undefined)?.storage_key }
  usedBytes(collectionId?: string) { return this.files().filter(f => !collectionId || f.collectionId === collectionId).reduce((sum, f) => sum + f.size, 0) }
  workspace(quotaBytes: number): Workspace {
    const files = this.files()
    return { version: 1, displayName: this.get('displayName') || '管理员', collections: this.collections(), files: files.filter(f => !f.deletedAt), trash: files.filter(f => f.deletedAt), storage: { usedBytes: this.usedBytes(), quotaBytes }, lastRenameId: (this.db.prepare('SELECT id FROM renames WHERE undone=0 ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined)?.id, activities: (this.db.prepare('SELECT id,text,time FROM activities ORDER BY id DESC LIMIT 30').all() as { id: number; text: string; time: string }[]).map(a => ({ ...a, id: String(a.id), time: new Date(a.time).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false }) })) }
  }
  setupToken() { return readFileSync(join(this.dataDir, 'setup-token'), 'utf8').trim() }
  close() { this.db.close(); this.lock.exec('ROLLBACK'); this.lock.close() }
}
