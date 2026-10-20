import type { FastifyInstance } from 'fastify'
import { mkdir, readdir, readFile, lstat, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import { createOnlineBackup } from './backup.ts'
import type { BackupSettings, BackupInfo, BackupRun } from '../src/types.ts'
import { HttpError, object } from './security.ts'

const ID = /^jiyu-\d{8}T\d{9}Z-[a-f0-9-]{36}$/
export async function registerBackups(app: FastifyInstance, store: Store, backupRoot: string) {
  backupRoot = resolve(backupRoot)
  const within = (parent: string, child: string) => { const p = relative(parent, child); return !p || (!p.startsWith('..') && !isAbsolute(p)) }
  if (within(resolve(store.dataDir), backupRoot) || within(backupRoot, resolve(store.dataDir))) throw new Error('备份与数据目录必须互相独立')
  const settings = (): BackupSettings => JSON.parse(store.get('backup.settings') || '{"enabled":false,"intervalHours":24,"keep":7}')
  const last = (): BackupRun | null => JSON.parse(store.get('backup.last') || 'null')
  let running: Promise<void> | undefined, stopping = false
  if (last()?.status === 'running') store.set('backup.last', JSON.stringify({ ...last(), status: 'failed', error: '上次备份被服务重启中断，未完成的目录不视为有效备份' }))
  const directories = async (): Promise<BackupInfo[]> => {
    let entries
    try { entries = await readdir(backupRoot, { withFileTypes: true }) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
    const list: BackupInfo[] = []
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && ID.test(e.name)) {
      try {
        const path = join(backupRoot, e.name, 'manifest.json')
        if ((await lstat(path)).size > 10 * 1024 ** 2) continue
        const manifest = JSON.parse(await readFile(path, 'utf8'))
        if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.databaseSha256)) continue
        list.push({ id: e.name, createdAt: manifest.createdAt, files: manifest.files.length, bytes: manifest.files.reduce((s: number, f: { size: number }) => s + f.size, 0) })
      } catch { /* A missing final manifest identifies an interrupted backup. */ }
    }
    return list.sort((a, b) => b.id.localeCompare(a.id))
  }
  const run = () => {
    if (running) throw new HttpError(409, '已有备份正在执行')
    const id = `jiyu-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}`
    const record: BackupRun = { id, status: 'running', startedAt: new Date().toISOString() }
    store.set('backup.last', JSON.stringify(record))
    running = (async () => {
      try {
        await mkdir(backupRoot, { recursive: true, mode: 0o700 })
        // Canonical containment guards scheduled deletion against symlinked roots.
        const root = await realpath(backupRoot), data = await realpath(store.dataDir)
        if (within(root, data) || within(data, root)) throw new Error('备份与数据目录必须互相独立')
        await createOnlineBackup(store, join(root, id))
        const backups = await directories()
        for (const old of backups.slice(settings().keep)) {
          const target = join(root, old.id), info = await lstat(target)
          if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await realpath(target)) || resolve(target) === root) throw new Error('保留策略路径校验失败')
          await rm(target, { recursive: true })
        }
        store.set('backup.last', JSON.stringify({ ...record, status: 'succeeded', finishedAt: new Date().toISOString() }))
        store.activity('完成在线完整备份与保留策略检查')
      } catch {
        store.set('backup.last', JSON.stringify({ ...record, status: 'failed', finishedAt: new Date().toISOString(), error: '备份未完成，请检查备份磁盘空间、数据完整性和目录权限。未清理现有备份。' }))
      } finally { running = undefined }
    })()
    return record
  }
  const info = async () => ({ settings: settings(), lastRun: last(), backups: await directories(), directory: backupRoot })
  app.get('/api/backups', async () => info())
  app.patch('/api/backups/settings', async req => {
    const body = object(req.body)
    if (typeof body.enabled !== 'boolean' || ![6, 12, 24, 168].includes(Number(body.intervalHours)) || !Number.isInteger(body.keep) || Number(body.keep) < 1 || Number(body.keep) > 30) throw new HttpError(400, '备份周期或保留份数无效')
    store.set('backup.settings', JSON.stringify({ enabled: body.enabled, intervalHours: body.intervalHours, keep: body.keep }))
    store.activity('更新自动备份计划')
    return info()
  })
  app.post('/api/backups/run', async (_req, reply) => { if (stopping) throw new HttpError(503, '服务正在停止'); const record = run(); reply.code(202); return record })
  const tick = () => {
    const s = settings(), previous = last(), reference = previous?.startedAt ? Date.parse(previous.startedAt) : 0
    if (!stopping && s.enabled && !running && Date.now() - reference >= s.intervalHours * 60 * 60 * 1000) run()
  }
  const timer = setInterval(tick, 30000); timer.unref()
  tick()
  return async () => { stopping = true; clearInterval(timer); await running }
}
