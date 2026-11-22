import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { resolveRateLimits } from './config.ts'
import type { Config } from './config.ts'
import { Store } from './store.ts'
import type { FileQueryOptions } from './store.ts'
import {
  accessCodeInput,
  accessCookieName,
  checkPassword,
  digest,
  equalToken,
  hashPassword,
  HttpError,
  object,
  passwordInput,
  safeName,
  signAccessProof,
  text,
  token,
  verifyAccessProof,
} from './security.ts'
import {
  fileExtension,
  fileExtensions,
  isExpired,
  submissionError,
} from '../src/lib/collections.ts'
import type { Collection, CollectedFile, FileSortOption, TagChange } from '../src/types.ts'
import { proposalHash, registerAI } from './ai.ts'
import type { AITransport } from './ai.ts'
import type { AIFailureDiagnostics } from './ai-failure-diagnostics.ts'
import { registerArchives } from './archive.ts'
import { registerUploads } from './uploads.ts'
import type { UploadBudget } from './uploads.ts'
import { publicUser, registerUsers } from './users.ts'
import type { UserRow } from './users.ts'
import { registerBackups } from './backup-scheduler.ts'
import { registerContent } from './content.ts'
import type { ContentExtractor } from './content.ts'
import { registerStorage, requireStorage } from './storage.ts'
import type { StorageRetryPolicy } from './storage.ts'
import type { RemoteHTTP } from './remote-http.ts'
import { storageSpace } from './storage-space.ts'
import { collectionRules, registerCollectionWorkflows } from './collection-workflows.ts'
import { diagnostics } from './diagnostics.ts'
import { materialRuleKey, registerMaterials } from './materials.ts'
import { confirmCollectionDraft } from './collection-draft.ts'
import { publicSubmissionError } from './public-errors.ts'
import { hasUnsafeTagChars } from '../src/lib/text-safety.ts'

function makeEtag(...parts: (string | number | undefined)[]) {
  const hash = createHash('sha256')
    .update(parts.map((p) => (p === undefined ? '' : String(p))).join('\0'))
    .digest('base64url')
    .slice(0, 24)
  return `"${hash}"`
}

function etagMatches(header: string | string[] | undefined, etag: string) {
  if (!header) return false
  const raw = Array.isArray(header) ? header.join(',') : header
  const normalize = (value: string) => value.trim().replace(/^W\//i, '')
  const target = normalize(etag)
  return raw
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === '*' || candidate === target)
}

function parseFileQuery(raw: unknown, forcedCollectionId?: string): FileQueryOptions {
  const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (key: string) => (typeof q[key] === 'string' ? q[key].trim() : '')
  const collectionId = forcedCollectionId || str('collectionId') || undefined
  if (collectionId && collectionId.length > 64) throw new HttpError(400, '收集编号无效')
  const rawStatus = str('status') || 'all'
  if (!['all', 'ready', 'pending'].includes(rawStatus)) throw new HttpError(400, '文件状态筛选无效')
  const rawTrashed = str('trashed')
  let trashed: 'false' | 'true' | 'all' = 'false'
  if (rawTrashed === 'true' || rawTrashed === '1') trashed = 'true'
  else if (rawTrashed === 'all') trashed = 'all'
  else if (rawTrashed === '' || rawTrashed === 'false' || rawTrashed === '0') trashed = 'false'
  else throw new HttpError(400, '回收站筛选参数无效')
  const rawKind = str('kind') || 'all'
  if (!['all', 'image'].includes(rawKind)) throw new HttpError(400, '文件类型筛选无效')
  const search = str('q')
  if (search.length > 120) throw new HttpError(400, '搜索关键词过长')
  const rawPage = str('page')
  const page = rawPage ? Number(rawPage) : 1
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new HttpError(400, '页码无效')
  const rawPageSize = str('pageSize')
  const pageSize = rawPageSize ? Number(rawPageSize) : 50
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200)
    throw new HttpError(400, '每页数量需在 1–200 之间')
  const rawSort = str('sort') || 'created_desc'
  const sortAlias: Record<string, FileSortOption> = {
    desc: 'created_desc',
    asc: 'created_asc',
    created_desc: 'created_desc',
    created_asc: 'created_asc',
    name_asc: 'name_asc',
    name_desc: 'name_desc',
    size_desc: 'size_desc',
    size_asc: 'size_asc',
  }
  const sort = sortAlias[rawSort]
  if (!sort) throw new HttpError(400, '排序参数无效')
  return {
    collectionId,
    status: rawStatus as FileQueryOptions['status'],
    trashed,
    kind: rawKind as FileQueryOptions['kind'],
    q: search || undefined,
    page,
    pageSize,
    sort,
  }
}

async function collectionInput(value: unknown, current?: Collection): Promise<Collection> {
  const body = object(value)
  const integer = (key: string, max: number, fallback?: number) => {
    const n = body[key] ?? fallback
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max)
      throw new HttpError(400, `${key} 超出允许范围`)
    return n
  }
  const deadline = text(body.deadline, '截止日期', 10)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(deadline) ||
    !Number.isFinite(Date.parse(`${deadline}T00:00:00+08:00`)) ||
    new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) !== deadline
  )
    throw new HttpError(400, '截止日期无效')
  const formats = fileExtensions(text(body.formats, '文件格式', 260))
  if (formats.length > 20 || !formats.length || formats.some((f) => !/^[a-z0-9]{1,12}$/.test(f)))
    throw new HttpError(400, '文件后缀无效')
  const category = body.category
  if (category !== 'design' && category !== 'document' && category !== 'photo')
    throw new HttpError(400, '收集类型无效')
  const result: Collection = {
    ...collectionRules(body, current),
    id: current?.id || randomUUID(),
    uploadToken: current?.uploadToken || token(),
    title: text(body.title, '收集名称', 50),
    description:
      typeof body.description === 'string' ? text(body.description, '收集说明', 150, 0) : '',
    category,
    target: integer('target', 10000),
    deadline,
    formats: formats.join(', ').toUpperCase(),
    maxFileSizeMB: integer('maxFileSizeMB', 1024),
    maxFilesPerSubmission: integer('maxFilesPerSubmission', 100),
    maxTotalSizeMB: integer('maxTotalSizeMB', 1048576, current?.maxTotalSizeMB || 2048),
    storage: 'local',
    received: current?.received || 0,
    status: current?.status || 'active',
  }
  if (body.clearAccessCode === true) {
    delete result.accessCodeHash
    delete result.accessCodeVersion
  } else if (body.accessCode !== undefined && body.accessCode !== '') {
    const code = accessCodeInput(body.accessCode)
    result.accessCodeHash = await hashPassword(code)
    result.accessCodeVersion = randomUUID()
  } else if (current?.accessCodeHash) {
    result.accessCodeHash = current.accessCodeHash
    result.accessCodeVersion = current.accessCodeVersion || randomUUID()
  }
  if (result.materials?.length || current?.materials?.length || current?.materialRevision)
    result.materialRevision =
      current?.materialRevision && materialRuleKey(current) === materialRuleKey(result)
        ? current.materialRevision
        : randomUUID()
  if (current?.draftOrigin) result.draftOrigin = current.draftOrigin
  return result
}

export async function createApp(
  config: Config,
  options: {
    serveFrontend?: boolean
    aiTransport?: AITransport
    aiFailureDiagnostics?: AIFailureDiagnostics
    contentExtractor?: ContentExtractor
    storageHTTP?: RemoteHTTP
    storageRetry?: StorageRetryPolicy
    materialToolMode?: boolean
  } = {},
) {
  const store = new Store(config.dataDir)
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy || false,
    bodyLimit: 64 * 1024,
    requestTimeout: 10 * 60 * 1000,
    connectionTimeout: 30 * 1000,
  })
  const budget: UploadBudget = {
    bytes: 0,
    files: 0,
    active: 0,
    collections: new Map(),
    committedBytes: 0,
    committedCollections: new Map(),
  }
  const rateLimits = resolveRateLimits(config.rateLimits)
  await app.register(cookie)
  await app.register(rateLimit, {
    global: true,
    max: rateLimits.globalPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new HttpError(429, '操作过于频繁，请稍后重试'),
  })
  await app.register(multipart, {
    preservePath: true,
    limits: {
      fileSize: Math.min(config.requestBytes, 1024 ** 3),
      files: 100,
      fields: 1,
      fieldSize: 120,
      fieldNameSize: 30,
      parts: 101,
      headerPairs: 100,
    },
  })
  const session = (req: FastifyRequest) => {
    const value = req.cookies.jiyu_session
    if (!value || value.length > 100) return undefined
    return store.db
      .prepare(
        'SELECT s.csrf,s.expires,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.disabled=0',
      )
      .get(digest(value), Date.now()) as unknown as
      | (UserRow & { csrf: string; expires: number })
      | undefined
  }
  const setSession = (reply: FastifyReply, userId = 'primary') => {
    const value = token(),
      csrf = token()
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now())
    store.db
      .prepare('INSERT INTO sessions(hash,csrf,expires,user_id) VALUES (?,?,?,?)')
      .run(digest(value), csrf, Date.now() + 12 * 60 * 60 * 1000, userId)
    reply.setCookie('jiyu_session', value, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookie,
      maxAge: 12 * 60 * 60,
    })
    return {
      authenticated: true,
      setupRequired: false,
      csrf,
      user: publicUser(
        store.db.prepare('SELECT * FROM users WHERE id=?').get(userId) as unknown as UserRow,
      ),
    }
  }
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    const url = req.url.split('?')[0]
    if (!url.startsWith('/api/')) return
    reply.header('Cache-Control', 'no-store')
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    if (
      req.headers['content-type']?.startsWith('multipart/form-data') &&
      Number(req.headers['content-length'] || 0) > config.requestBytes + 2 * 1024 ** 2
    )
      throw new HttpError(413, '请求总量超过上限')
    if (writes && req.headers.origin !== config.origin)
      throw new HttpError(403, '请求来源不正确，请从集屿页面操作')
    const publicRoute =
      url.startsWith('/api/public/') ||
      (req.method === 'GET' && /^\/api\/storage\/oauth\/(onedrive|gdrive)\/callback$/.test(url)) ||
      ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/health'].includes(url)
    if (!publicRoute) {
      const auth = session(req)
      if (!auth) throw new HttpError(401, '登录已过期，请重新登录')
      if (
        writes &&
        (!req.headers['x-csrf-token'] ||
          !equalToken(String(req.headers['x-csrf-token']), auth.csrf))
      )
        throw new HttpError(403, '安全校验失败，请刷新页面重试')
      const adminOnly =
        url.startsWith('/api/users') ||
        url.startsWith('/api/backups') ||
        url === '/api/files/purge' ||
        (writes &&
          (url.startsWith('/api/settings') ||
            url.startsWith('/api/storage') ||
            url.startsWith('/api/ai/settings') ||
            url === '/api/ai/test'))
      if (auth.role !== 'admin' && adminOnly) throw new HttpError(403, '这项操作需要管理员权限')
      const readOperation = url === '/api/archives' || /^\/api\/archives\/[^/]+$/.test(url)
      if (
        auth.role === 'viewer' &&
        writes &&
        !readOperation &&
        !['/api/auth/logout', '/api/auth/password'].includes(url)
      )
        throw new HttpError(403, '当前账号为只读成员，无法修改工作台')
    }
  })
  app.setErrorHandler((error, _req, reply) => {
    if (reply.sent) return
    const e = error as Error & { statusCode?: number; code?: string; errcode?: number }
    const limit = e.code?.includes('LIMIT') || e.code === 'FST_REQ_FILE_TOO_LARGE'
    const full =
      e.code === 'ENOSPC' ||
      e.code === 'EDQUOT' ||
      (e.code === 'ERR_SQLITE_ERROR' && e.errcode === 13)
    const status = limit
      ? 413
      : e.statusCode &&
          e.statusCode >= 400 &&
          (e.statusCode < 500 || (error instanceof HttpError && e.statusCode <= 599))
        ? e.statusCode
        : full
          ? 507
          : 500
    const message =
      error instanceof HttpError
        ? error.message
        : limit
          ? '文件大小、数量或请求总量超过限制'
          : status === 500
            ? '服务暂时无法完成操作，请稍后重试'
            : status === 507
              ? '服务器磁盘空间不足'
              : '请求无效，请检查输入后重试'
    if (/^\/api\/archives\/[^/]+\/download$/.test(_req.url.split('?')[0])) {
      const escaped = message.replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
      )
      reply
        .code(status)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>集屿 · 下载提示</title><body><main><h1>这次下载未能开始</h1><p>${escaped}</p><p><a href="/#/files">回到集屿重新打包</a></p></main></body></html>`,
        )
    } else
      reply.code(status).send({
        error: _req.url.startsWith('/api/public/')
          ? publicSubmissionError(status, message)
          : message,
      })
  })
  app.addHook('preHandler', (req, reply, done) => {
    if (!req.isMultipart()) {
      done()
      return
    }
    let received = 0,
      exceeded = false
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
    reply.raw.once('finish', () => {
      req.raw.removeListener('data', count)
      if (exceeded) req.raw.destroy()
    })
    done()
  })
  app.get('/api/health', async () => ({ ok: true, version: '0.4.0' }))
  app.get('/api/auth/status', async (req) => {
    const auth = session(req)
    return {
      setupRequired: !store.get('password'),
      authenticated: !!auth,
      csrf: auth?.csrf,
      user: auth ? publicUser(auth) : undefined,
    }
  })
  app.post(
    '/api/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (store.get('password')) throw new HttpError(409, '管理员已经初始化')
      const body = object(req.body)
      if (!equalToken(text(body.setupToken, '初始化口令', 100), store.setupToken()))
        throw new HttpError(403, '初始化口令不正确')
      const password = passwordInput(body.password),
        displayName = text(body.displayName, '显示名称', 20)
      const hash = await hashPassword(password)
      if (store.get('password')) throw new HttpError(409, '管理员已经初始化')
      store.transaction(() => {
        store.set('password', hash)
        store.set('displayName', displayName)
        store.db
          .prepare("INSERT INTO users VALUES ('primary','admin',?,?,'admin',0)")
          .run(displayName, hash)
        store.activity('完成管理员初始化')
      })
      await rm(join(config.dataDir, 'setup-token'), { force: true })
      return setSession(reply)
    },
  )
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = object(req.body),
        username =
          body.username === undefined || body.username === ''
            ? 'admin'
            : text(body.username, '登录名', 32)
      const user = store.db
        .prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE AND disabled=0')
        .get(username) as unknown as UserRow | undefined
      const password = passwordInput(body.password, 1)
      // Unknown accounts still pay the same scrypt cost.
      const valid = await checkPassword(
        password,
        user?.password ||
          store.get('password') ||
          (await hashPassword('uninitialized-placeholder')),
      )
      if (!user || !valid) throw new HttpError(401, '登录名或密码不正确')
      return setSession(reply, user.id)
    },
  )
  app.post('/api/auth/logout', async (req, reply) => {
    store.db
      .prepare('DELETE FROM sessions WHERE hash=?')
      .run(digest(req.cookies.jiyu_session || ''))
    reply.clearCookie('jiyu_session', { path: '/' })
    return { ok: true }
  })
  app.post('/api/auth/password', async (req, reply) => {
    const body = object(req.body)
    const auth = session(req)!
    if (!(await checkPassword(passwordInput(body.currentPassword, 1), auth.password)))
      throw new HttpError(400, '当前密码不正确')
    const hash = await hashPassword(passwordInput(body.password))
    store.transaction(() => {
      store.db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, auth.id)
      if (auth.id === 'primary') store.set('password', hash)
      store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(auth.id)
      store.activity(`成员「${auth.display_name}」修改密码，撤销其旧会话`)
    })
    return setSession(reply, auth.id)
  })
  app.get('/api/workspace', async (req, reply) => {
    const role = session(req)?.role || 'viewer'
    const etag = makeEtag(
      'workspace',
      store.changeStamp(),
      role,
      config.quotaBytes,
      config.requestBytes,
    )
    reply.header('ETag', etag).header('Cache-Control', 'no-cache').header('Vary', 'Cookie')
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send()
    const workspace = store.workspace(config.quotaBytes, config.requestBytes)
    if (role === 'viewer') {
      workspace.collections = workspace.collections.map(({ uploadToken: _token, ...c }) => c)
      workspace.lastRenameId = undefined
    }
    return workspace
  })
  app.get('/api/files', async (req, reply) => {
    const role = session(req)?.role || 'viewer'
    const query = parseFileQuery(req.query)
    const etag = makeEtag('files', store.changeStamp(), role, JSON.stringify(query))
    reply.header('ETag', etag).header('Cache-Control', 'no-cache').header('Vary', 'Cookie')
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send()
    return store.queryFiles(query)
  })
  app.get('/api/collections/:id/files', async (req, reply) => {
    const id = String(object(req.params).id)
    getCollection(id)
    const role = session(req)?.role || 'viewer'
    const query = parseFileQuery(req.query, id)
    const etag = makeEtag('collection-files', store.changeStamp(), role, JSON.stringify(query))
    reply.header('ETag', etag).header('Cache-Control', 'no-cache').header('Vary', 'Cookie')
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send()
    return store.queryFiles(query)
  })
  app.patch('/api/settings', async (req) => {
    const displayName = text(object(req.body).displayName, '显示名称', 20)
    store.transaction(() => {
      store.set('displayName', displayName)
      store.db.prepare("UPDATE users SET display_name=? WHERE id='primary'").run(displayName)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  app.post(
    '/api/settings/diagnostics',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async () => diagnostics(store, config, budget.bytes),
  )
  app.post('/api/collections', async (req) => {
    const body = object(req.body),
      c = { ...(await collectionInput(body)), storage: requireStorage(store, body.storage) }
    store.transaction(() => {
      const origin = confirmCollectionDraft(store, body, c)
      if (origin) c.draftOrigin = origin
      store.saveCollection(c)
      store.activity(`创建了「${c.title}」`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  const getCollection = (id: string) => {
    const c = store.collection(id)
    if (!c) throw new HttpError(404, '没有找到这项收集')
    return c
  }
  app.patch('/api/collections/:id', async (req) => {
    if (object(req.body).draftConfirmation !== undefined)
      throw new HttpError(400, 'AI 草稿仅用于新建，不覆盖已有收集')
    const current = getCollection(String(object(req.params).id))
    const c = {
      ...(await collectionInput(req.body, current)),
      storage: requireStorage(store, object(req.body).storage ?? current.storage),
    }
    store.transaction(() => {
      store.saveCollection(c)
      store.activity(`修改了「${c.title}」的规则`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  app.post('/api/collections/:id/status', async (req) => {
    const c = getCollection(String(object(req.params).id)),
      status = object(req.body).status
    if (!['active', 'paused', 'completed'].includes(String(status)))
      throw new HttpError(400, '收集状态无效')
    if (status === 'active' && isExpired(c)) throw new HttpError(400, '请先延长截止日期')
    store.transaction(() => {
      store.saveCollection({ ...c, status: status as Collection['status'] })
      store.activity(
        `将「${c.title}」设为${status === 'active' ? '收集中' : status === 'paused' ? '暂停' : '完成'}`,
      )
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  app.post('/api/collections/:id/rotate-token', async (req) => {
    const c = getCollection(String(object(req.params).id))
    store.transaction(() => {
      store.saveCollection({ ...c, uploadToken: token() })
      store.activity(`更换了「${c.title}」的收集链接，旧链接失效`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  const publicCollection = (value: string) => {
    const c = store.byToken(value)
    if (!c) throw new HttpError(404, '收集链接无效或已撤销')
    return c
  }
  const isPublicUnlocked = (req: FastifyRequest, c: Collection) => {
    if (!c.accessCodeHash) return true
    const secret = store.publicAccessSecret()
    const version = c.accessCodeVersion || 'v1'
    const headerToken =
      typeof req.headers['x-access-token'] === 'string' ? req.headers['x-access-token'] : undefined
    if (verifyAccessProof(secret, headerToken, c.id, c.uploadToken!, version)) return true
    const cookieToken = req.cookies[accessCookieName(c.id)]
    return verifyAccessProof(secret, cookieToken, c.id, c.uploadToken!, version)
  }
  const requirePublicAccess = (req: FastifyRequest, c: Collection) => {
    if (!isPublicUnlocked(req, c)) throw new HttpError(403, '此收集需要提取码，请先验证提取码')
  }
  const publicCollectionPayload = (raw: Collection) => {
    const {
      uploadToken: _secret,
      expectedSubmitters: _roster,
      restrictToExpectedSubmitters: _restrict,
      accessCodeHash: hash,
      accessCodeVersion: _ver,
      draftOrigin: _draftOrigin,
      ...c
    } = raw
    return {
      collection: {
        ...c,
        hasAccessCode: Boolean(hash),
        activeFiles: store.activeFileCount(c.id),
        requestLimitMB: config.requestBytes / 1024 ** 2,
      },
      ownerName: store.get('displayName') || '管理员',
    }
  }
  app.get('/api/public/:token', async (req) => {
    const c = publicCollection(String(object(req.params).token))
    if (c.accessCodeHash && !isPublicUnlocked(req, c)) return { locked: true }
    return publicCollectionPayload(c)
  })
  app.post(
    '/api/public/:token/unlock',
    {
      config: {
        rateLimit: {
          max: rateLimits.unlockPerMinute,
          timeWindow: '1 minute',
          keyGenerator: (req) =>
            `${req.ip}:${String((req.params as Record<string, unknown>)?.token || '')}`,
          errorResponseBuilder: () => new HttpError(429, '提取码尝试过于频繁，请 1 分钟后重试'),
        },
      },
    },
    async (req, reply) => {
      const c = publicCollection(String(object(req.params).token))
      if (!c.accessCodeHash) return { unlocked: true, ...publicCollectionPayload(c) }
      const body = object(req.body)
      const code = typeof body.accessCode === 'string' ? body.accessCode.trim() : ''
      if (!code || code.length > 32) throw new HttpError(400, '请输入 4–8 位提取码')
      const valid = await checkPassword(code, c.accessCodeHash)
      if (!valid) throw new HttpError(403, '提取码不正确，请核对后重试')
      const expiresAt = Date.now() + 12 * 60 * 60 * 1000
      const proof = signAccessProof(
        store.publicAccessSecret(),
        c.id,
        c.uploadToken!,
        c.accessCodeVersion || 'v1',
        expiresAt,
      )
      reply.setCookie(accessCookieName(c.id), proof, {
        path: '/api/public/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.secureCookie,
        maxAge: 12 * 60 * 60,
      })
      return { unlocked: true, accessToken: proof, ...publicCollectionPayload(c) }
    },
  )
  app.post(
    '/api/public/:token/upload',
    { config: { rateLimit: { max: rateLimits.multipartPerHour, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const c = publicCollection(String(object(req.params).token))
      requirePublicAccess(req, c)
      if (c.status !== 'active' || isExpired(c))
        throw new HttpError(410, '这项收集已暂停、结束或超过截止时间')
      if (
        c.fields?.length ||
        c.materials?.length ||
        c.naming?.parts.length ||
        c.submissionMode === 'single' ||
        c.accessCodeHash ||
        c.restrictToExpectedSubmitters
      )
        throw new HttpError(400, '此任务有新提交规则，请使用新版提交页')
      const requestId = text(req.headers['idempotency-key'], '提交编号', 36)
      if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new HttpError(400, '提交编号无效')
      const previous = store.db
        .prepare('SELECT collection_id,receipt FROM submissions WHERE id=?')
        .get(requestId) as { collection_id: string; receipt: string } | undefined
      if (previous) {
        if (previous.collection_id !== c.id) throw new HttpError(409, '提交编号已使用')
        return JSON.parse(previous.receipt)
      }
      if (budget.active >= 4) throw new HttpError(429, '当前上传人数较多，请稍后重试')
      budget.active++
      let owner = '',
        bytes = 0,
        committed = false
      const staged: { file: CollectedFile; key: string; path: string }[] = []
      // Capture baseline storage usage once before streaming; chunk callbacks stay purely in-memory.
      const startCommitted = budget.committedBytes
      const startCollectionCommitted = budget.committedCollections.get(c.id) || 0
      const baseUsed = store.usedBytes() + store.pendingBytes()
      const baseCollectionUsed = store.usedBytes(c.id) + store.pendingBytes(c.id)
      const maxCollectionBytes = (c.maxTotalSizeMB || 2048) * 1024 ** 2
      try {
        for await (const part of req.parts({
          limits: {
            files: c.maxFilesPerSubmission,
            fields: 1,
            parts: c.maxFilesPerSubmission + 1,
            fileSize: Math.min(c.maxFileSizeMB * 1024 ** 2, config.requestBytes),
          },
        })) {
          if (part.type === 'field') {
            if (part.fieldname !== 'owner' || owner) throw new HttpError(400, '提交者字段无效')
            owner = text(part.value, '你的姓名', 30)
            continue
          }
          if (!owner || part.fieldname !== 'files') {
            part.file.resume()
            throw new HttpError(400, '请先填写提交者姓名，再选择文件')
          }
          if (store.fileCount() + budget.files + store.pendingFiles() >= 10000) {
            part.file.resume()
            throw new HttpError(413, '已达到第一版 10000 个文件的上限，请备份后整理数据')
          }
          const name = safeName(part.filename),
            key = randomUUID(),
            tempPath = join(config.dataDir, 'tmp', key),
            hash = createHash('sha256')
          const entry = {
            file: {
              id: randomUUID(),
              name,
              originalName: name,
              size: 0,
              collectionId: c.id,
              owner,
              createdAt: new Date().toISOString(),
              storage: c.storage,
              ...(c.storage !== 'local' ? { remoteStatus: 'queued' } : {}),
              status: 'pending',
            } as CollectedFile,
            key,
            path: tempPath,
          }
          staged.push(entry)
          budget.files++
          await pipeline(
            part.file,
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                const collectionReserved = budget.collections.get(c.id) || 0
                const globalCommittedDelta = budget.committedBytes - startCommitted
                const collectionCommittedDelta =
                  (budget.committedCollections.get(c.id) || 0) - startCollectionCommitted
                if (
                  bytes + chunk.length > config.requestBytes ||
                  baseUsed + globalCommittedDelta + budget.bytes + chunk.length >
                    config.quotaBytes ||
                  baseCollectionUsed +
                    collectionCommittedDelta +
                    collectionReserved +
                    chunk.length >
                    maxCollectionBytes
                ) {
                  callback(new HttpError(413, '单次提交、任务或存储总容量超过上限'))
                  return
                }
                bytes += chunk.length
                budget.bytes += chunk.length
                budget.collections.set(c.id, collectionReserved + chunk.length)
                entry.file.size += chunk.length
                hash.update(chunk)
                callback(null, chunk)
              },
            }),
            createWriteStream(tempPath, { flags: 'wx', mode: 0o600, flush: true }),
          )
          if (part.file.truncated) throw new HttpError(413, '文件超过大小限制')
          entry.file.sha256 = hash.digest('hex')
          const invalid = submissionError(
            c,
            staged.map((s) => s.file),
          )
          if (invalid) throw new HttpError(400, invalid)
        }
        const latest = getCollection(c.id),
          invalid = submissionError(
            latest,
            staged.map((s) => s.file),
          )
        if (invalid) throw new HttpError(400, invalid)
        if (
          store.usedBytes() + store.pendingBytes() + budget.bytes > config.quotaBytes ||
          store.usedBytes(c.id) + store.pendingBytes(c.id) + (budget.collections.get(c.id) || 0) >
            (latest.maxTotalSizeMB || 2048) * 1024 ** 2
        )
          throw new HttpError(413, '任务容量超过上限')
        for (const entry of staged) {
          const destination = join(config.dataDir, 'objects', entry.key)
          await rename(entry.path, destination)
          entry.path = destination
        }
        const receipt = {
          receiptId: randomUUID(),
          filesCount: staged.length,
          bytes,
          createdAt: new Date().toISOString(),
        }
        store.transaction(() => {
          if (store.db.prepare('SELECT id FROM submissions WHERE id=?').get(requestId))
            throw new HttpError(409, '该提交已完成，请重试获取回执')
          const finalCollection = getCollection(c.id)
          if (
            finalCollection.fields?.length ||
            finalCollection.materials?.length ||
            finalCollection.naming?.parts.length ||
            finalCollection.submissionMode === 'single' ||
            finalCollection.accessCodeHash ||
            finalCollection.restrictToExpectedSubmitters
          )
            throw new HttpError(409, '提交规则已更新，请使用新版提交页')
          const finalError = submissionError(
            finalCollection,
            staged.map((s) => s.file),
          )
          if (finalError || finalCollection.uploadToken !== c.uploadToken)
            throw new HttpError(410, finalError || '收集链接已更换，请使用新链接')
          if (
            store.usedBytes() + bytes > config.quotaBytes ||
            store.usedBytes(c.id) + bytes > (finalCollection.maxTotalSizeMB || 2048) * 1024 ** 2
          )
            throw new HttpError(413, '任务容量超过上限')
          for (const entry of staged)
            store.addFile(
              {
                ...entry.file,
                storage: finalCollection.storage,
                remoteStatus: finalCollection.storage === 'local' ? undefined : 'queued',
              },
              entry.key,
            )
          store.saveCollection({
            ...finalCollection,
            received: finalCollection.received + staged.length,
          })
          store.db
            .prepare('INSERT INTO submissions VALUES (?,?,?,?)')
            .run(requestId, c.id, '', JSON.stringify(receipt))
          store.activity(`${owner}向「${finalCollection.title}」提交了 ${staged.length} 份文件`)
        })
        budget.committedBytes += bytes
        budget.committedCollections.set(c.id, (budget.committedCollections.get(c.id) || 0) + bytes)
        committed = true
        reply.code(201)
        return receipt
      } finally {
        budget.active--
        budget.bytes -= bytes
        budget.files -= staged.length
        budget.collections.set(c.id, (budget.collections.get(c.id) || 0) - bytes)
        if (!committed)
          for (const entry of staged) await rm(entry.path, { force: true }).catch(() => {})
      }
    },
  )
  app.get('/api/files/:id/download', async (req, reply) => {
    const id = String(object(req.params).id),
      file = store.file(id),
      key = store.fileKey(id)
    if (!file || file.deletedAt || !key) throw new HttpError(404, '文件不存在或已在回收站')
    reply
      .header('Content-Type', 'application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`)}`,
      )
    reply.header('Content-Length', file.size)
    return reply.send(createReadStream(join(config.dataDir, 'objects', key)))
  })
  const chosenFiles = (ids: unknown, includeDeleted = false) => {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 500 ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    )
      throw new HttpError(400, '请选择 1–500 个文件')
    const list: CollectedFile[] = []
    for (const id of ids) {
      const f = store.file(id)
      if (!f || (!includeDeleted && f.deletedAt))
        throw new HttpError(404, '部分文件不存在，请刷新重试')
      list.push(f)
    }
    return list
  }
  app.post('/api/files/review', async (req) => {
    const list = chosenFiles(object(req.body).ids)
    store.transaction(() => {
      for (const f of list) store.saveFile({ ...f, status: 'ready' })
      store.activity(`将 ${list.length} 个文件标记为已整理`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  app.post('/api/files/trash', async (req) => {
    const list = chosenFiles(object(req.body).ids)
    store.transaction(() => {
      for (const f of list)
        store.saveFile({
          ...f,
          deletedAt: new Date().toISOString(),
          materialVersion: (f.materialVersion || 0) + 1,
        })
      store.activity(`将 ${list.length} 个文件移入回收站`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  app.post('/api/files/restore', async (req) => {
    const list = chosenFiles(object(req.body).ids, true)
    store.transaction(() => {
      for (const f of list) {
        const { deletedAt: _deleted, ...rest } = f
        store.saveFile({ ...rest, materialVersion: (f.materialVersion || 0) + 1 })
      }
      store.activity(`从回收站恢复 ${list.length} 个文件`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  app.post('/api/files/rename', async (req) => {
    const body = object(req.body),
      changes = body.changes
    if (!Array.isArray(changes)) throw new HttpError(400, '命名方案无效')
    const namesPlan = changes.map((value) => {
      const item = object(value)
      return {
        id: text(item.id, '文件编号', 36),
        name: safeName(item.name),
        oldName: text(item.oldName, '原文件名', 240),
      }
    })
    if (
      body.tags !== undefined &&
      (!Array.isArray(body.tags) || body.tags.length > 30 || !body.aiRunId)
    )
      throw new HttpError(400, '分类方案无效')
    const tagPlan = (body.tags || []) as TagChange[]
    for (const value of tagPlan) {
      const tag = object(value)
      if (
        typeof tag.id !== 'string' ||
        typeof tag.name !== 'string' ||
        !Array.isArray(tag.tags) ||
        !Array.isArray(tag.oldTags) ||
        tag.tags.length > 5 ||
        tag.oldTags.length > 5 ||
        [...tag.tags, ...tag.oldTags].some(
          (t) => typeof t !== 'string' || !t.trim() || t.length > 20 || hasUnsafeTagChars(t),
        )
      )
        throw new HttpError(400, '分类标签无效')
    }
    if (
      new Set(tagPlan.map((t) => t.id)).size !== tagPlan.length ||
      new Set(namesPlan.map((t) => t.id)).size !== namesPlan.length
    )
      throw new HttpError(400, '方案包含重复文件')
    const selected = chosenFiles([
        ...new Set([...namesPlan.map((p) => p.id), ...tagPlan.map((p) => p.id)]),
      ]),
      all = store.files().filter((f) => !f.deletedAt)
    const plan = selected.map((file) => {
      const name = namesPlan.find((p) => p.id === file.id),
        tag = tagPlan.find((p) => p.id === file.id)
      return {
        id: file.id,
        oldName: name?.oldName || tag!.name,
        name: name?.name || tag!.name,
        ...(tag ? { oldTags: tag.oldTags, tags: tag.tags } : {}),
      }
    })
    const aiRunId = body.aiRunId
    if (aiRunId !== undefined) {
      const run = store.db
        .prepare('SELECT proposalHash,status,createdAt FROM ai_runs WHERE id=?')
        .get(text(aiRunId, 'AI 操作编号', 36)) as
        | { proposalHash: string; status: string; createdAt: string }
        | undefined
      if (
        !run ||
        run.status !== 'succeeded' ||
        Date.now() - Date.parse(run.createdAt) > 30 * 60 * 1000 ||
        run.proposalHash !== proposalHash(namesPlan, tagPlan)
      )
        throw new HttpError(409, 'AI 方案已过期、已执行或被修改，请重新生成')
    }
    if (selected.some((f) => f.name !== plan.find((p) => p.id === f.id)?.oldName))
      throw new HttpError(409, '文件名已被其他操作修改，请刷新后重新预览')
    if (
      selected.some((f) => {
        const tag = tagPlan.find((t) => t.id === f.id)
        return tag && JSON.stringify(tag.oldTags) !== JSON.stringify(f.tags || [])
      })
    )
      throw new HttpError(409, '分类已有后续修改，请重新生成建议')
    const finalNameById = new Map(plan.map((p) => [p.id, p.name]))
    const renamedIds = new Set(namesPlan.map((p) => p.id))
    const touchedCollections = new Set(
      selected.filter((f) => renamedIds.has(f.id)).map((f) => f.collectionId),
    )
    for (const cid of touchedCollections) {
      const seen = new Map<string, number>()
      for (const f of all) {
        if (f.collectionId !== cid) continue
        const key = (finalNameById.get(f.id) || f.name).toLowerCase()
        seen.set(key, (seen.get(key) || 0) + 1)
      }
      for (const f of selected) {
        if (f.collectionId !== cid || !renamedIds.has(f.id)) continue
        if ((seen.get(finalNameById.get(f.id)!.toLowerCase()) || 0) > 1)
          throw new HttpError(409, '命名方案产生重名，请调整规则')
      }
    }
    for (const f of selected) {
      const next = finalNameById.get(f.id)!
      if (fileExtension(next) !== fileExtension(f.name))
        throw new HttpError(400, '批量命名需保留文件扩展名')
    }
    const operationId = randomUUID()
    store.transaction(() => {
      for (const f of selected) {
        const change = plan.find((p) => p.id === f.id)!
        store.saveFile({
          ...f,
          name: change.name,
          materialVersion: (f.materialVersion || 0) + 1,
          ...(change.tags ? { tags: change.tags } : {}),
        })
      }
      store.db
        .prepare('INSERT INTO renames(id,data) VALUES (?,?)')
        .run(operationId, JSON.stringify(plan))
      if (aiRunId)
        store.db.prepare('UPDATE ai_runs SET status=? WHERE id=?').run('applied', String(aiRunId))
      store.activity(
        `${aiRunId ? '确认 AI 方案，' : ''}整理 ${selected.length} 个文件的名称${tagPlan.length ? '与分类' : ''}`,
      )
    })
    return { workspace: store.workspace(config.quotaBytes, config.requestBytes), operationId }
  })
  app.post('/api/files/rename/:id/undo', async (req) => {
    const id = String(object(req.params).id),
      row = store.db.prepare('SELECT data,undone FROM renames WHERE id=?').get(id) as
        | { data: string; undone: number }
        | undefined
    if (!row || row.undone) throw new HttpError(409, '该命名操作已撤销或不存在')
    const plan = JSON.parse(row.data) as {
        id: string
        name: string
        oldName: string
        tags?: string[]
        oldTags?: string[]
      }[],
      files = chosenFiles(plan.map((p) => p.id))
    if (files.some((f) => f.name !== plan.find((p) => p.id === f.id)!.name))
      throw new HttpError(409, '文件名已有后续修改，不能直接撤销')
    if (
      files.some((f) => {
        const p = plan.find((p) => p.id === f.id)!
        return p.tags && JSON.stringify(p.tags) !== JSON.stringify(f.tags || [])
      })
    )
      throw new HttpError(409, '分类已有后续修改，不能直接撤销')
    const planMap = new Map(plan.map((p) => [p.id, p]))
    const allActive = store.files().filter((f) => !f.deletedAt)
    for (const cid of new Set(files.map((f) => f.collectionId))) {
      const targets = files
        .filter((f) => f.collectionId === cid)
        .map((f) => planMap.get(f.id)!.oldName.toLowerCase())
      const unchangedNames = new Set(
        allActive
          .filter((f) => f.collectionId === cid && !planMap.has(f.id))
          .map((f) => f.name.toLowerCase()),
      )
      if (
        new Set(targets).size !== targets.length ||
        targets.some((name) => unchangedNames.has(name))
      )
        throw new HttpError(409, '原文件名已被占用，无法撤销')
    }
    store.transaction(() => {
      for (const f of files) {
        const p = plan.find((p) => p.id === f.id)!
        store.saveFile({
          ...f,
          name: p.oldName,
          materialVersion: (f.materialVersion || 0) + 1,
          ...(p.oldTags ? { tags: p.oldTags } : {}),
        })
      }
      store.db.prepare('UPDATE renames SET undone=1 WHERE id=?').run(id)
      store.activity(`撤销了 ${files.length} 个文件的整理操作`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
  app.get('/api/storage', async () =>
    storageSpace(
      config.dataDir,
      store.usedBytes(),
      config.quotaBytes,
      store.pendingBytes() + budget.bytes,
    ),
  )
  registerAI(
    app,
    store,
    options.aiTransport,
    options.aiFailureDiagnostics,
    options.materialToolMode === true,
  )
  const archives = registerArchives(app, store)
  registerCollectionWorkflows(app, store, requirePublicAccess)
  registerMaterials(app, store, config, session)
  await registerUploads(app, store, config, budget, requirePublicAccess)
  registerUsers(app, store, (req) => session(req)?.id)
  const backups = await registerBackups(
    app,
    store,
    config.backupDir || resolve(config.dataDir, '..', 'backups'),
  )
  app.post('/api/files/purge', async (req) => {
    const body = object(req.body)
    if (body.confirm !== 'PERMANENT_DELETE')
      throw new HttpError(400, '请先完成二次确认后再执行永久清理')
    const list = chosenFiles(body.ids, true)
    if (list.some((f) => !f.deletedAt))
      throw new HttpError(409, '仅可永久清理回收站中的文件，请刷新重试')
    const idSet = new Set(list.map((f) => f.id))
    if (backups.isRunning())
      throw new HttpError(409, '当前有在线备份正在执行，请等待备份完成后再永久清理')
    if (archives.hasReferencedFiles(idSet))
      throw new HttpError(409, '部分文件正被活跃打包任务引用，请等待打包结束或取消后再清理')
    const auth = session(req)!
    let keys: string[] = []
    let freedBytes = 0
    store.transaction(() => {
      const fresh = list.map((f) => {
        const current = store.file(f.id)
        if (!current || !current.deletedAt)
          throw new HttpError(409, '部分文件状态已变化或已恢复，请刷新后重试')
        const key = store.fileKey(f.id)
        if (!key || !/^[a-f0-9-]{36}$/.test(key)) throw new HttpError(409, '文件存储记录无效')
        return { file: current, key }
      })
      keys = fresh.map((item) => item.key)
      freedBytes = fresh.reduce((sum, item) => sum + item.file.size, 0)
      for (const { file } of fresh) {
        store.db.prepare('DELETE FROM content_search WHERE file_id=?').run(file.id)
        store.db.prepare('DELETE FROM files WHERE id=?').run(file.id)
      }
      store.activity(
        `管理员「${auth.display_name}」在线永久清理了回收站中的 ${fresh.length} 个文件`,
      )
    })
    for (const key of keys) {
      await rm(join(config.dataDir, 'objects', key), { force: true }).catch(() => {})
    }
    return {
      workspace: store.workspace(config.quotaBytes, config.requestBytes),
      purged: keys.length,
      freedBytes,
    }
  })
  const stopContent = registerContent(app, store, options.contentExtractor)
  const stopStorage = registerStorage(
    app,
    store,
    options.storageHTTP,
    config.origin,
    (req) => session(req)?.role,
    options.storageRetry,
  )
  app.addHook('onClose', async () => {
    await stopStorage()
    await stopContent()
    await backups.stop()
    store.close()
  })
  if (options.serveFrontend !== false && existsSync(resolve('dist/index.html'))) {
    await app.register(staticFiles, {
      root: resolve('dist'),
      index: ['index.html'],
      cacheControl: false,
    })
  }
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: '页面或接口不存在' }))
  return { app, store }
}
