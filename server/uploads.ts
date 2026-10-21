import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Store } from './store.ts'
import type { Config } from './config.ts'
import type { Collection, CollectedFile, UploadReceipt } from '../src/types.ts'
import { digest, equalToken, HttpError, object, safeName, text } from './security.ts'
import { submissionError, isExpired } from '../src/lib/collections.ts'

export const CHUNK_BYTES = 4 * 1024 ** 2
const UUID = /^[a-f0-9-]{36}$/
interface DraftFile { name: string; size: number; lastModified: number }
interface Batch { owner: string; files: DraftFile[] }
interface Row { id: string; collection_id: string; token_hash: string; key_hash: string; data: string; bytes: number; expires: number }
interface Part { file_index: number; part_index: number; sha256: string; size: number }

// Legacy multipart and persistent uploads share the same reservations.
export interface UploadBudget { bytes: number; files: number; active: number; collections: Map<string, number> }

export async function registerUploads(app: FastifyInstance, store: Store, config: Config, budget: UploadBudget) {
  const active = new Set<string>()
  const path = (id: string, file: number, part: number) => join(config.dataDir, 'chunks', `${id}.${file}.${part}`)
  async function clearParts(id: string) {
    for (const name of await readdir(join(config.dataDir, 'chunks'))) if (name.startsWith(`${id}.`)) await rm(join(config.dataDir, 'chunks', name), { force: true })
  }
  async function cleanup() {
    const expired = store.db.prepare('SELECT id FROM uploads WHERE expires<=?').all(Date.now()) as { id: string }[]
    for (const { id } of expired) if (!active.has(id)) { store.db.prepare('DELETE FROM uploads WHERE id=?').run(id); await clearParts(id) }
    const ids = new Set((store.db.prepare('SELECT id FROM uploads').all() as { id: string }[]).map(r => r.id))
    for (const name of await readdir(join(config.dataDir, 'chunks'))) if (/^[a-f0-9-]{36}\.\d+\.\d+(\.tmp)?$/.test(name) && !ids.has(name.slice(0, 36))) await rm(join(config.dataDir, 'chunks', name), { force: true })
  }
  await cleanup()
  const timer = setInterval(() => { void cleanup().catch(() => {}) }, 60 * 60 * 1000); timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_BYTES }, (_req, body, done) => done(null, body))
  const collection = (req: FastifyRequest) => {
    const value = String(object(req.params).token), c = store.byToken(value)
    if (!c) throw new HttpError(404, '收集链接无效或已撤销')
    if (c.status !== 'active' || isExpired(c)) throw new HttpError(410, '这项收集已暂停、结束或截止')
    return c
  }
  const key = (req: FastifyRequest) => { const value = text(req.headers['x-upload-key'], '续传凭证', 100); if (!/^[a-zA-Z0-9_-]{32,100}$/.test(value)) throw new HttpError(400, '续传凭证无效'); return digest(value) }
  const id = (req: FastifyRequest) => { const value = String(object(req.params).id); if (!UUID.test(value)) throw new HttpError(400, '上传编号无效'); return value }
  const authorize = (req: FastifyRequest): { row: Row; c: Collection; batch: Batch } => {
    const c = collection(req), row = store.db.prepare('SELECT * FROM uploads WHERE id=?').get(id(req)) as unknown as Row | undefined
    if (!row || row.expires <= Date.now()) throw new HttpError(410, '续传记录已过期，请重新选择文件提交')
    if (row.collection_id !== c.id || !equalToken(row.token_hash, digest(c.uploadToken!)) || !equalToken(row.key_hash, key(req))) throw new HttpError(403, '续传凭证不匹配')
    return { row, c, batch: JSON.parse(row.data) }
  }
  const receipt = (req: FastifyRequest, c: Collection) => {
    const row = store.db.prepare('SELECT collection_id,fingerprint,receipt FROM submissions WHERE id=?').get(id(req)) as { collection_id: string; fingerprint: string; receipt: string } | undefined
    if (!row) return undefined
    if (row.collection_id !== c.id || !equalToken(row.fingerprint, key(req))) throw new HttpError(403, '续传凭证不匹配')
    return JSON.parse(row.receipt) as UploadReceipt
  }
  const status = (row: Row) => ({ id: row.id, chunkBytes: CHUNK_BYTES, expiresAt: new Date(row.expires).toISOString(), parts: store.db.prepare('SELECT file_index,part_index,sha256,size FROM upload_parts WHERE batch_id=? ORDER BY file_index,part_index').all(row.id) })
  const limits = (c: Collection, bytes: number, count: number) => {
    if (store.usedBytes() + store.pendingBytes() + budget.bytes + bytes > config.quotaBytes || store.usedBytes(c.id) + store.pendingBytes(c.id) + (budget.collections.get(c.id) || 0) + bytes > (c.maxTotalSizeMB || 2048) * 1024 ** 2) throw new HttpError(413, '任务或存储总容量超过上限')
    if (store.files().length + store.pendingFiles() + budget.files + count > 10000) throw new HttpError(413, '已达到 10000 个文件的上限')
  }
  app.post('/api/public/:token/uploads/:id', { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async req => {
    const c = collection(req), saved = receipt(req, c)
    if (saved) return { receipt: saved }
    const body = object(req.body), owner = text(body.owner, '你的姓名', 30)
    if (!Array.isArray(body.files) || !body.files.length || body.files.length > c.maxFilesPerSubmission) throw new HttpError(400, '提交数量超过任务限制')
    const files: DraftFile[] = body.files.map(value => { const f = object(value); if (!Number.isSafeInteger(f.size) || Number(f.size) < 0 || !Number.isSafeInteger(f.lastModified) || Number(f.lastModified) < 0) throw new HttpError(400, '文件大小或修改时间无效'); return { name: safeName(text(f.name, '文件名称', 240)), size: Number(f.size), lastModified: Number(f.lastModified) } })
    const invalid = submissionError(c, files), bytes = files.reduce((sum, f) => sum + f.size, 0)
    if (invalid) throw new HttpError(400, invalid)
    if (bytes > config.requestBytes) throw new HttpError(413, '单次提交总量超过上限')
    const data = JSON.stringify({ owner, files }), existing = store.db.prepare('SELECT * FROM uploads WHERE id=?').get(id(req)) as unknown as Row | undefined
    if (existing) { const { row } = authorize(req); if (row.data !== data) throw new HttpError(409, '文件或提交人已改变，请创建新批次'); return status(row) }
    const count = (store.db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE expires>?').get(Date.now()) as { n: number }).n
    if (count >= 20) throw new HttpError(429, '待续传批次较多，请完成已有提交或稍后重试')
    limits(c, bytes, files.length)
    store.db.prepare('INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?)').run(id(req), c.id, digest(c.uploadToken!), key(req), data, bytes, files.length, Date.now() + 24 * 60 * 60 * 1000)
    return status(store.db.prepare('SELECT * FROM uploads WHERE id=?').get(id(req)) as unknown as Row)
  })
  app.get('/api/public/:token/uploads/:id', async req => { const c = collection(req), saved = receipt(req, c); return saved ? { receipt: saved } : status(authorize(req).row) })
  app.delete('/api/public/:token/uploads/:id', async req => {
    const { row } = authorize(req)
    if (active.has(row.id)) throw new HttpError(409, '仍有分片写入，请稍后取消')
    store.db.prepare('DELETE FROM uploads WHERE id=?').run(row.id); await clearParts(row.id)
    return { ok: true }
  })
  app.put('/api/public/:token/uploads/:id/:file/:part', { bodyLimit: CHUNK_BYTES, config: { rateLimit: { max: 180, timeWindow: '1 minute' } } }, async req => {
    const { row, batch, c } = authorize(req), params = object(req.params)
    const index = Number(params.file), part = Number(params.part), file = batch.files[index]
    if (!/^\d{1,3}$/.test(String(params.file)) || !/^\d{1,3}$/.test(String(params.part)) || !file || part >= Math.ceil(file.size / CHUNK_BYTES)) throw new HttpError(400, '分片序号无效')
    const bytes = req.body as Buffer
    if (!Buffer.isBuffer(bytes) || bytes.length !== Math.min(CHUNK_BYTES, file.size - part * CHUNK_BYTES)) throw new HttpError(400, '分片大小不匹配')
    if (active.has(row.id) || budget.active >= 4) throw new HttpError(429, '当前上传较多，请稍后重试')
    const invalid = submissionError(c, batch.files)
    if (invalid) throw new HttpError(410, invalid)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (!equalToken(String(req.headers['x-chunk-sha256'] || ''), hash)) throw new HttpError(400, '分片校验失败，请重试')
    const old = store.db.prepare('SELECT sha256 FROM upload_parts WHERE batch_id=? AND file_index=? AND part_index=?').get(row.id, index, part) as { sha256: string } | undefined
    if (old) { if (old.sha256 !== hash) throw new HttpError(409, '所选文件内容已改变，请重新开始提交'); return { sha256: hash } }
    active.add(row.id); budget.active++
    const target = path(row.id, index, part)
    try {
      await writeFile(`${target}.tmp`, bytes, { mode: 0o600, flush: true })
      await rename(`${target}.tmp`, target)
      // Check again after disk I/O: revoked links must not commit a new part.
      authorize(req)
      store.db.prepare('INSERT INTO upload_parts VALUES (?,?,?,?,?)').run(row.id, index, part, hash, bytes.length)
      return { sha256: hash }
    } finally { active.delete(row.id); budget.active--; await rm(`${target}.tmp`, { force: true }).catch(() => {}) }
  })
  app.post('/api/public/:token/uploads/:id/complete', async (req, reply) => {
    const c = collection(req), saved = receipt(req, c)
    if (saved) return saved
    const { row, batch } = authorize(req)
    if (active.has(row.id) || budget.active >= 4) throw new HttpError(429, '文件正在写入，请稍后重试')
    active.add(row.id); budget.active++
    let committed = false
    const staged: { file: CollectedFile; key: string; path: string }[] = []
    try {
      const parts = store.db.prepare('SELECT * FROM upload_parts WHERE batch_id=?').all(row.id) as unknown as Part[]
      for (let i = 0; i < batch.files.length; i++) {
        const f = batch.files[i], hash = createHash('sha256'), storageKey = randomUUID(), target = join(config.dataDir, 'tmp', storageKey)
        const entry = { file: { id: randomUUID(), name: f.name, originalName: f.name, size: f.size, collectionId: c.id, owner: batch.owner, createdAt: new Date().toISOString(), storage: c.storage, ...(c.storage !== 'local' ? { remoteStatus: 'queued' } : {}), status: 'pending' } as CollectedFile, key: storageKey, path: target }
        staged.push(entry)
        async function* source() {
          for (let part = 0; part < Math.ceil(f.size / CHUNK_BYTES); part++) {
            const expected = parts.find(p => p.file_index === i && p.part_index === part)
            if (!expected) throw new HttpError(409, '还有分片未上传，请继续上传')
            const partHash = createHash('sha256'); let size = 0
            for await (const bytes of createReadStream(path(row.id, i, part))) { size += bytes.length; partHash.update(bytes); yield bytes }
            if (size !== expected.size || partHash.digest('hex') !== expected.sha256) throw new HttpError(409, '服务器分片校验失败，请重新开始提交')
          }
        }
        await pipeline(Readable.from(source()), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk) } }), createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }))
        entry.file.sha256 = hash.digest('hex')
        const destination = join(config.dataDir, 'objects', entry.key); await rename(target, destination); entry.path = destination
      }
      const latest = authorize(req).c, invalid = submissionError(latest, batch.files)
      if (invalid) throw new HttpError(410, invalid)
      limits(latest, 0, 0)
      const result: UploadReceipt = { receiptId: randomUUID(), filesCount: staged.length, bytes: row.bytes, createdAt: new Date().toISOString() }
      store.transaction(() => {
        for (const entry of staged) store.addFile({ ...entry.file, storage: latest.storage, remoteStatus: latest.storage === 'local' ? undefined : 'queued' }, entry.key)
        store.saveCollection({ ...latest, received: latest.received + staged.length })
        store.db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run(row.id, c.id, row.key_hash, JSON.stringify(result))
        store.db.prepare('DELETE FROM uploads WHERE id=?').run(row.id)
        store.activity(`${batch.owner}向「${latest.title}」提交了 ${staged.length} 份文件（分片校验完成）`)
      })
      committed = true; reply.code(201)
      await clearParts(row.id).catch(() => {})
      return result
    } finally {
      active.delete(row.id); budget.active--
      if (!committed) for (const entry of staged) await rm(entry.path, { force: true }).catch(() => {})
    }
  })
}
