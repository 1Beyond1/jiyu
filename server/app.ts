import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { rename, rm, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { Config } from './config.ts'
import { Store } from './store.ts'
import { checkPassword, digest, equalToken, hashPassword, HttpError, object, passwordInput, safeName, text, token } from './security.ts'
import { fileExtensions, isExpired, submissionError } from '../src/lib/collections.ts'
import type { Collection, CollectedFile } from '../src/types.ts'
import { proposalHash, registerAI } from './ai.ts'
import type { AITransport } from './ai.ts'

function collectionInput(value: unknown, current?: Collection): Collection {
  const body = object(value)
  const integer = (key: string, max: number, fallback?: number) => {
    const n = body[key] ?? fallback
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `${key} 超出允许范围`)
    return n
  }
  const deadline = text(body.deadline, '截止日期', 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !Number.isFinite(Date.parse(`${deadline}T00:00:00+08:00`)) || new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) !== deadline) throw new HttpError(400, '截止日期无效')
  const formats = fileExtensions(text(body.formats, '文件格式', 260))
  if (formats.length > 20 || !formats.length || formats.some(f => !/^[a-z0-9]{1,12}$/.test(f))) throw new HttpError(400, '文件后缀无效')
  const category = body.category
  if (category !== 'design' && category !== 'document' && category !== 'photo') throw new HttpError(400, '收集类型无效')
  return { id: current?.id || randomUUID(), uploadToken: current?.uploadToken || token(), title: text(body.title, '收集名称', 50), description: typeof body.description === 'string' ? text(body.description, '收集说明', 150, 0) : '', category, target: integer('target', 10000), deadline, formats: formats.join(', ').toUpperCase(), maxFileSizeMB: integer('maxFileSizeMB', 1024), maxFilesPerSubmission: integer('maxFilesPerSubmission', 100), maxTotalSizeMB: integer('maxTotalSizeMB', 1048576, current?.maxTotalSizeMB || 2048), storage: 'local', received: current?.received || 0, status: current?.status || 'active' }
}

export async function createApp(config: Config, options: { serveFrontend?: boolean; aiTransport?: AITransport } = {}) {
  const store = new Store(config.dataDir)
  const app = Fastify({ logger: false, trustProxy: config.trustProxy || false, bodyLimit: 64 * 1024, requestTimeout: 10 * 60 * 1000, connectionTimeout: 30 * 1000 })
  let reserved = 0, uploads = 0
  const perCollection = new Map<string, number>()
  let usedTotal = store.usedBytes()
  let fileCount = store.files().length, reservedFiles = 0
  const usedByCollection = new Map(store.collections().map(c => [c.id, store.usedBytes(c.id)]))
  await app.register(cookie)
  await app.register(rateLimit, { global: true, max: 180, timeWindow: '1 minute', errorResponseBuilder: () => ({ error: '操作过于频繁，请稍后重试' }) })
  await app.register(multipart, { preservePath: true, limits: { fileSize: Math.min(config.requestBytes, 1024 ** 3), files: 100, fields: 1, fieldSize: 120, fieldNameSize: 30, parts: 101, headerPairs: 100 } })
  const session = (req: FastifyRequest) => {
    const value = req.cookies.jiyu_session
    if (!value || value.length > 100) return undefined
    return store.db.prepare('SELECT csrf,expires FROM sessions WHERE hash=? AND expires>?').get(digest(value), Date.now()) as { csrf: string; expires: number } | undefined
  }
  const setSession = (reply: FastifyReply) => {
    const value = token(), csrf = token()
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now())
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(value), csrf, Date.now() + 12 * 60 * 60 * 1000)
    reply.setCookie('jiyu_session', value, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookie, maxAge: 12 * 60 * 60 })
    return { authenticated: true, setupRequired: false, csrf }
  }
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    const url = req.url.split('?')[0]
    if (!url.startsWith('/api/')) return
    reply.header('Cache-Control', 'no-store')
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    if (req.headers['content-type']?.startsWith('multipart/form-data') && Number(req.headers['content-length'] || 0) > config.requestBytes + 2 * 1024 ** 2) throw new HttpError(413, '请求总量超过上限')
    if (writes && req.headers.origin !== config.origin) throw new HttpError(403, '请求来源不正确，请从集屿页面操作')
    const publicRoute = url.startsWith('/api/public/') || ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/health'].includes(url)
    if (!publicRoute) {
      const auth = session(req)
      if (!auth) throw new HttpError(401, '登录已过期，请重新登录')
      if (writes && (!req.headers['x-csrf-token'] || !equalToken(String(req.headers['x-csrf-token']), auth.csrf))) throw new HttpError(403, '安全校验失败，请刷新页面重试')
    }
  })
  app.setErrorHandler((error, _req, reply) => {
    if (reply.sent) return
    const e = error as Error & { statusCode?: number; code?: string }
    const limit = e.code?.includes('LIMIT') || e.code === 'FST_REQ_FILE_TOO_LARGE'
    const status = limit ? 413 : e.statusCode && e.statusCode >= 400 && (e.statusCode < 500 || (error instanceof HttpError && e.statusCode <= 599)) ? e.statusCode : e.code === 'ENOSPC' ? 507 : 500
    reply.code(status).send({ error: error instanceof HttpError ? error.message : limit ? '文件大小、数量或请求总量超过限制' : status === 500 ? '服务暂时无法完成操作，请稍后重试' : status === 507 ? '服务器磁盘空间不足' : '请求无效，请检查输入后重试' })
  })
  app.addHook('preHandler', (req, reply, done) => {
    if (!req.isMultipart()) { done(); return }
    let received = 0, exceeded = false
    const count = (chunk: Buffer) => {
      received += chunk.length
      if (!exceeded && received > config.requestBytes + 2 * 1024 ** 2) {
        exceeded = true
        reply.code(413).send({ error: '请求总量超过上限' })
      }
    }
    // multipart 消费原始流。只旁观计数，暂停到解析器接管，避免抢先读走边界。
    req.raw.on('data', count)
    req.raw.pause()
    reply.raw.once('finish', () => { req.raw.removeListener('data', count); if (exceeded) req.raw.destroy() })
    done()
  })
  app.get('/api/health', async () => ({ ok: true, version: '0.3.0' }))
  app.get('/api/auth/status', async req => ({ setupRequired: !store.get('password'), authenticated: !!session(req), csrf: session(req)?.csrf }))
  app.post('/api/auth/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (store.get('password')) throw new HttpError(409, '管理员已经初始化')
    const body = object(req.body)
    if (!equalToken(text(body.setupToken, '初始化口令', 100), store.setupToken())) throw new HttpError(403, '初始化口令不正确')
    const password = passwordInput(body.password), displayName = text(body.displayName, '显示名称', 20)
    const hash = await hashPassword(password)
    if (store.get('password')) throw new HttpError(409, '管理员已经初始化')
    store.transaction(() => { store.set('password', hash); store.set('displayName', displayName); store.activity('完成管理员初始化') })
    await rm(join(config.dataDir, 'setup-token'), { force: true })
    return setSession(reply)
  })
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = object(req.body), stored = store.get('password')
    if (!stored || !await checkPassword(passwordInput(body.password, 1), stored)) throw new HttpError(401, '密码不正确')
    return setSession(reply)
  })
  app.post('/api/auth/logout', async (req, reply) => { store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(req.cookies.jiyu_session || '')); reply.clearCookie('jiyu_session', { path: '/' }); return { ok: true } })
  app.post('/api/auth/password', async (req, reply) => {
    const body = object(req.body)
    if (!await checkPassword(passwordInput(body.currentPassword, 1), store.get('password')!)) throw new HttpError(400, '当前密码不正确')
    const hash = await hashPassword(passwordInput(body.password))
    store.transaction(() => { store.set('password', hash); store.db.exec('DELETE FROM sessions'); store.activity('修改管理员密码，撤销全部旧会话') })
    return setSession(reply)
  })
  app.get('/api/workspace', async () => store.workspace(config.quotaBytes))
  app.patch('/api/settings', async req => { store.set('displayName', text(object(req.body).displayName, '显示名称', 20)); return store.workspace(config.quotaBytes) })
  app.post('/api/collections', async req => { const c = collectionInput(req.body); store.transaction(() => { store.saveCollection(c); store.activity(`创建了「${c.title}」`) }); return store.workspace(config.quotaBytes) })
  const getCollection = (id: string) => { const c = store.collection(id); if (!c) throw new HttpError(404, '没有找到这项收集'); return c }
  app.patch('/api/collections/:id', async req => {
    const c = collectionInput(req.body, getCollection(String(object(req.params).id)))
    store.transaction(() => { store.saveCollection(c); store.activity(`修改了「${c.title}」的规则`) })
    return store.workspace(config.quotaBytes)
  })
  app.post('/api/collections/:id/status', async req => {
    const c = getCollection(String(object(req.params).id)), status = object(req.body).status
    if (!['active', 'paused', 'completed'].includes(String(status))) throw new HttpError(400, '收集状态无效')
    if (status === 'active' && isExpired(c)) throw new HttpError(400, '请先延长截止日期')
    store.transaction(() => { store.saveCollection({ ...c, status: status as Collection['status'] }); store.activity(`将「${c.title}」设为${status === 'active' ? '收集中' : status === 'paused' ? '暂停' : '完成'}`) })
    return store.workspace(config.quotaBytes)
  })
  app.post('/api/collections/:id/rotate-token', async req => {
    const c = getCollection(String(object(req.params).id))
    store.transaction(() => { store.saveCollection({ ...c, uploadToken: token() }); store.activity(`更换了「${c.title}」的收集链接，旧链接失效`) })
    return store.workspace(config.quotaBytes)
  })
  const publicCollection = (value: string) => { const c = store.byToken(value); if (!c) throw new HttpError(404, '收集链接无效或已撤销'); return c }
  app.get('/api/public/:token', async req => {
    const { uploadToken: _secret, ...c } = publicCollection(String(object(req.params).token))
    return { collection: { ...c, requestLimitMB: config.requestBytes / 1024 ** 2 }, ownerName: store.get('displayName') || '管理员' }
  })
  app.post('/api/public/:token/upload', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const c = publicCollection(String(object(req.params).token))
    if (c.status !== 'active' || isExpired(c)) throw new HttpError(410, '这项收集已暂停、结束或超过截止时间')
    const requestId = text(req.headers['idempotency-key'], '提交编号', 36)
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new HttpError(400, '提交编号无效')
    const previous = store.db.prepare('SELECT collection_id,receipt FROM submissions WHERE id=?').get(requestId) as { collection_id: string; receipt: string } | undefined
    if (previous) { if (previous.collection_id !== c.id) throw new HttpError(409, '提交编号已使用'); return JSON.parse(previous.receipt) }
    if (uploads >= 4) throw new HttpError(429, '当前上传人数较多，请稍后重试')
    uploads++
    let owner = '', bytes = 0, committed = false
    const staged: { file: CollectedFile; key: string; path: string }[] = []
    try {
      for await (const part of req.parts({ limits: { files: c.maxFilesPerSubmission, fields: 1, parts: c.maxFilesPerSubmission + 1, fileSize: Math.min(c.maxFileSizeMB * 1024 ** 2, config.requestBytes) } })) {
        if (part.type === 'field') { if (part.fieldname !== 'owner' || owner) throw new HttpError(400, '提交者字段无效'); owner = text(part.value, '你的姓名', 30); continue }
        if (!owner || part.fieldname !== 'files') { part.file.resume(); throw new HttpError(400, '请先填写提交者姓名，再选择文件') }
        if (fileCount + reservedFiles >= 10000) { part.file.resume(); throw new HttpError(413, '已达到第一版 10000 个文件的上限，请备份后整理数据') }
        const name = safeName(part.filename), key = randomUUID(), tempPath = join(config.dataDir, 'tmp', key), hash = createHash('sha256')
        const entry = { file: { id: randomUUID(), name, originalName: name, size: 0, collectionId: c.id, owner, createdAt: new Date().toISOString(), storage: 'local', status: 'pending' } as CollectedFile, key, path: tempPath }
        staged.push(entry)
        reservedFiles++
        const invalid = submissionError(c, staged.map(s => s.file))
        if (invalid) { part.file.resume(); throw new HttpError(400, invalid) }
        await pipeline(part.file, new Transform({ transform(chunk: Buffer, _encoding, callback) {
          const collectionReserved = perCollection.get(c.id) || 0
          if (bytes + chunk.length > config.requestBytes || usedTotal + reserved + chunk.length > config.quotaBytes || (usedByCollection.get(c.id) || 0) + collectionReserved + chunk.length > (c.maxTotalSizeMB || 2048) * 1024 ** 2) { callback(new HttpError(413, '单次提交、任务或存储总容量超过上限')); return }
          bytes += chunk.length; reserved += chunk.length; perCollection.set(c.id, collectionReserved + chunk.length)
          entry.file.size += chunk.length; hash.update(chunk); callback(null, chunk)
        } }), createWriteStream(tempPath, { flags: 'wx', mode: 0o600, flush: true }))
        if (part.file.truncated) throw new HttpError(413, '文件超过大小限制')
        entry.file.sha256 = hash.digest('hex')
      }
      const latest = getCollection(c.id), invalid = submissionError(latest, staged.map(s => s.file))
      if (invalid) throw new HttpError(400, invalid)
      if (store.usedBytes(c.id) + (perCollection.get(c.id) || 0) > (latest.maxTotalSizeMB || 2048) * 1024 ** 2) throw new HttpError(413, '任务容量超过上限')
      for (const entry of staged) { const destination = join(config.dataDir, 'objects', entry.key); await rename(entry.path, destination); entry.path = destination }
      const receipt = { receiptId: randomUUID(), filesCount: staged.length, bytes, createdAt: new Date().toISOString() }
      store.transaction(() => {
        if (store.db.prepare('SELECT id FROM submissions WHERE id=?').get(requestId)) throw new HttpError(409, '该提交已完成，请重试获取回执')
        const finalCollection = getCollection(c.id)
        const finalError = submissionError(finalCollection, staged.map(s => s.file))
        if (finalError || finalCollection.uploadToken !== c.uploadToken) throw new HttpError(410, finalError || '收集链接已更换，请使用新链接')
        if (store.usedBytes(c.id) + bytes > (finalCollection.maxTotalSizeMB || 2048) * 1024 ** 2) throw new HttpError(413, '任务容量超过上限')
        for (const entry of staged) store.addFile(entry.file, entry.key)
        store.saveCollection({ ...finalCollection, received: finalCollection.received + staged.length })
        store.db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run(requestId, c.id, '', JSON.stringify(receipt))
        store.activity(`${owner}向「${finalCollection.title}」提交了 ${staged.length} 份文件`)
      })
      usedTotal += bytes; usedByCollection.set(c.id, (usedByCollection.get(c.id) || 0) + bytes); fileCount += staged.length
      committed = true
      reply.code(201)
      return receipt
    } finally {
      uploads--; reserved -= bytes; reservedFiles -= staged.length; perCollection.set(c.id, (perCollection.get(c.id) || 0) - bytes)
      if (!committed) for (const entry of staged) await rm(entry.path, { force: true }).catch(() => {})
    }
  })
  app.get('/api/files/:id/download', async (req, reply) => {
    const id = String(object(req.params).id), file = store.files().find(f => f.id === id && !f.deletedAt), key = store.fileKey(id)
    if (!file || !key) throw new HttpError(404, '文件不存在或已在回收站')
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)}`)
    reply.header('Content-Length', file.size)
    return reply.send(createReadStream(join(config.dataDir, 'objects', key)))
  })
  const chosenFiles = (ids: unknown, includeDeleted = false) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '请选择 1–500 个文件')
    const list = store.files().filter(f => ids.includes(f.id) && (includeDeleted || !f.deletedAt))
    if (list.length !== ids.length) throw new HttpError(404, '部分文件不存在，请刷新重试')
    return list
  }
  app.post('/api/files/review', async req => { const list = chosenFiles(object(req.body).ids); store.transaction(() => { for (const f of list) store.saveFile({ ...f, status: 'ready' }); store.activity(`将 ${list.length} 个文件标记为已整理`) }); return store.workspace(config.quotaBytes) })
  app.post('/api/files/trash', async req => {
    const list = chosenFiles(object(req.body).ids)
    store.transaction(() => { for (const f of list) store.saveFile({ ...f, deletedAt: new Date().toISOString() }); store.activity(`将 ${list.length} 个文件移入回收站`) })
    return store.workspace(config.quotaBytes)
  })
  app.post('/api/files/restore', async req => {
    const list = chosenFiles(object(req.body).ids, true)
    store.transaction(() => { for (const f of list) { const { deletedAt: _deleted, ...rest } = f; store.saveFile(rest) } store.activity(`从回收站恢复 ${list.length} 个文件`) })
    return store.workspace(config.quotaBytes)
  })
  app.post('/api/files/rename', async req => {
    const changes = object(req.body).changes
    if (!Array.isArray(changes)) throw new HttpError(400, '命名方案无效')
    const plan = changes.map(value => { const item = object(value); return { id: text(item.id, '文件编号', 36), name: safeName(item.name), oldName: text(item.oldName, '原文件名', 200) } })
    const selected = chosenFiles(plan.map(p => p.id)), all = store.files().filter(f => !f.deletedAt)
    const aiRunId = object(req.body).aiRunId
    if (aiRunId !== undefined) {
      const run = store.db.prepare('SELECT proposalHash,status,createdAt FROM ai_runs WHERE id=?').get(text(aiRunId, 'AI 操作编号', 36)) as { proposalHash: string; status: string; createdAt: string } | undefined
      if (!run || run.status !== 'succeeded' || Date.now() - Date.parse(run.createdAt) > 30 * 60 * 1000 || run.proposalHash !== proposalHash(plan)) throw new HttpError(409, 'AI 方案已过期、已执行或被修改，请重新生成')
    }
    if (selected.some(f => f.name !== plan.find(p => p.id === f.id)?.oldName)) throw new HttpError(409, '文件名已被其他操作修改，请刷新后重新预览')
    const names = all.map(f => (plan.find(p => p.id === f.id)?.name || f.name).toLowerCase())
    const newNames = plan.map(p => p.name.toLowerCase())
    if (newNames.some(name => names.filter(n => n === name).length > 1)) throw new HttpError(409, '命名方案产生重名，请调整规则')
    for (const f of selected) { const next = plan.find(p => p.id === f.id)!.name; if (next.slice(next.lastIndexOf('.')).toLowerCase() !== f.name.slice(f.name.lastIndexOf('.')).toLowerCase()) throw new HttpError(400, '批量命名需保留文件扩展名') }
    const operationId = randomUUID()
    store.transaction(() => { for (const f of selected) store.saveFile({ ...f, name: plan.find(p => p.id === f.id)!.name }); store.db.prepare('INSERT INTO renames(id,data) VALUES (?,?)').run(operationId, JSON.stringify(plan)); if (aiRunId) store.db.prepare('UPDATE ai_runs SET status=? WHERE id=?').run('applied', String(aiRunId)); store.activity(`${aiRunId ? '确认 AI 方案，' : ''}批量重命名 ${selected.length} 个文件`) })
    return { workspace: store.workspace(config.quotaBytes), operationId }
  })
  app.post('/api/files/rename/:id/undo', async req => {
    const id = String(object(req.params).id), row = store.db.prepare('SELECT data,undone FROM renames WHERE id=?').get(id) as { data: string; undone: number } | undefined
    if (!row || row.undone) throw new HttpError(409, '该命名操作已撤销或不存在')
    const plan = JSON.parse(row.data) as { id: string; name: string; oldName: string }[], files = chosenFiles(plan.map(p => p.id))
    if (files.some(f => f.name !== plan.find(p => p.id === f.id)!.name)) throw new HttpError(409, '文件名已有后续修改，不能直接撤销')
    const targetNames = plan.map(p => p.oldName.toLowerCase()), unchanged = store.files().filter(f => !f.deletedAt && !plan.some(p => p.id === f.id))
    if (new Set(targetNames).size !== targetNames.length || unchanged.some(f => targetNames.includes(f.name.toLowerCase()))) throw new HttpError(409, '原文件名已被占用，无法撤销')
    store.transaction(() => { for (const f of files) store.saveFile({ ...f, name: plan.find(p => p.id === f.id)!.oldName }); store.db.prepare('UPDATE renames SET undone=1 WHERE id=?').run(id); store.activity(`撤销了 ${files.length} 个文件的重命名`) })
    return store.workspace(config.quotaBytes)
  })
  app.get('/api/storage', async () => { const disk = await statfs(config.dataDir); return { usedBytes: store.usedBytes(), quotaBytes: config.quotaBytes, availableBytes: disk.bavail * disk.bsize } })
  registerAI(app, store, options.aiTransport)
  app.addHook('onClose', async () => { store.close() })
  if (options.serveFrontend !== false && existsSync(resolve('dist/index.html'))) {
    await app.register(staticFiles, { root: resolve('dist'), index: ['index.html'], cacheControl: false })
  }
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: '页面或接口不存在' }))
  return { app, store }
}
