import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { ZipFile } from 'yazl'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type {
  ArchiveLayout,
  ArchivePlan,
  ArchiveStatus,
  CollectedFile,
  Collection,
} from '../src/types.ts'
import type { Store } from './store.ts'
import { digest, HttpError, object } from './security.ts'
import { sanitizeFilenameChars } from '../src/lib/text-safety.ts'
import { materialReviewState } from '../src/lib/materials.ts'

const ttl = 10 * 60 * 1000,
  maxBytes = 10 * 1024 ** 3
const layoutAliases: Record<string, ArchiveLayout> = {
  flat: 'flat',
  collection: 'collection',
  owner: 'owner',
  'collection-owner': 'collection-owner',
  'material-owner': 'material-owner',
  'material/owner': 'material-owner',
  'owner-material': 'owner-material',
  'owner/material': 'owner-material',
}
function shorten(value: string, bytes: number) {
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character) > bytes) break
    result += character
  }
  return result
}
function component(value: string, bytes: number) {
  let name =
    sanitizeFilenameChars(value.normalize('NFC'), '_', { stripBidi: true })
      .trim()
      .replace(/^\.+|[. ]+$/g, '') || '未命名'
  name = shorten(name, bytes).replace(/[. ]+$/g, '') || '未命名'
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`
  return name
}
function unique(name: string, used: Set<string>, bytes: number, file = false) {
  const ext = file ? posix.extname(name) : '',
    stem = ext ? name.slice(0, -ext.length) : name
  let candidate = name,
    count = 1
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${++count})`
    candidate = `${shorten(stem, bytes - Buffer.byteLength(suffix + ext))}${suffix}${ext}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export function archiveEntries(
  files: CollectedFile[],
  collections: Collection[],
  layout: ArchiveLayout,
) {
  const directories = new Map<string, string>(),
    children = new Map<string, Set<string>>()
  const used = (parent: string) => {
    if (!children.has(parent)) children.set(parent, new Set())
    return children.get(parent)!
  }
  const folder = (parent: string, identity: string, title: string) => {
    const key = JSON.stringify([parent, identity])
    if (!directories.has(key)) directories.set(key, unique(component(title, 80), used(parent), 80))
    return [parent, directories.get(key)!].filter(Boolean).join('/')
  }
  return files.map((file) => {
    const col = collections.find((c) => c.id === file.collectionId)
    const mat = file.materialId ? col?.materials?.find((m) => m.id === file.materialId) : undefined
    let parent = ''
    if (layout === 'collection' || layout === 'collection-owner')
      parent = folder('', file.collectionId, col?.title || '未分类')
    if (layout === 'material-owner') {
      parent = folder(
        '',
        mat ? `${file.collectionId}:${mat.id}` : 'unclassified',
        mat?.name || '未分类',
      )
      parent = folder(parent, file.owner, file.owner || '未填写提交人')
    } else if (layout === 'owner-material') {
      parent = folder('', file.owner, file.owner || '未填写提交人')
      parent = folder(
        parent,
        mat ? `${file.collectionId}:${mat.id}` : 'unclassified',
        mat?.name || '未分类',
      )
    } else if (layout === 'owner' || layout === 'collection-owner')
      parent = folder(parent, file.owner, file.owner || '未填写提交人')
    const extension = component(posix.extname(file.name).slice(1), 20)
    const name = posix.extname(file.name)
      ? `${component(file.name.slice(0, -posix.extname(file.name).length), 150)}.${extension}`
      : component(file.name, 180)
    return {
      id: file.id,
      name: file.name,
      path: [parent, unique(name, used(parent), 180, true)].filter(Boolean).join('/'),
      size: file.size,
    }
  })
}

interface StoredPlan extends ArchivePlan {
  session: string
  files: { file: CollectedFile; key: string }[]
  expires: number
  collectionId?: string
  stop?: () => void
}
export function registerArchives(app: FastifyInstance, store: Store) {
  const plans = new Map<string, StoredPlan>()
  let active = 0
  const prune = () => {
    for (const [id, plan] of plans)
      if (plan.status !== 'streaming' && plan.expires <= Date.now()) plans.delete(id)
  }
  const cleanup = setInterval(prune, 30000)
  cleanup.unref()
  const session = (req: FastifyRequest) => digest(req.cookies.jiyu_session || '')
  const get = (req: FastifyRequest) => {
    prune()
    const plan = plans.get(String(object(req.params).id))
    if (!plan || plan.session !== session(req))
      throw new HttpError(404, '打包计划已失效，请重新生成')
    return plan
  }
  app.post(
    '/api/archives',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (req) => {
      prune()
      const body = object(req.body)
      const { ids } = body
      const resolvedLayout =
        typeof body.layout === 'string' ? layoutAliases[body.layout] : undefined
      const acceptedOnly = body.acceptedOnly === true
      if (body.acceptedOnly !== undefined && typeof body.acceptedOnly !== 'boolean')
        throw new HttpError(400, '审核筛选参数无效')
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 500 ||
        ids.some((id) => typeof id !== 'string') ||
        new Set(ids).size !== ids.length
      )
        throw new HttpError(400, '每次请选择 1–500 个文件')
      if (!resolvedLayout) throw new HttpError(400, '请选择有效的归档方式')
      const all = new Map(
        store
          .files()
          .filter((f) => !f.deletedAt)
          .map((f) => [f.id, f]),
      )
      const files = ids.map((id) => all.get(id))
      if (files.some((file) => !file))
        throw new HttpError(404, '部分文件不存在或已移入回收站，请刷新重试')
      let chosen = files as CollectedFile[]
      let excludedCount = 0
      let boundCollectionId: string | undefined
      let boundRulesRevision: string | undefined
      if (acceptedOnly) {
        const collectionIds = new Set(chosen.map((f) => f.collectionId))
        if (collectionIds.size !== 1)
          throw new HttpError(400, '仅打包人工核对通过文件须在单个材料任务内操作')
        boundCollectionId = [...collectionIds][0]
        const targetCollection = store.collection(boundCollectionId)
        if (!targetCollection?.materials?.length || !targetCollection.materialRevision)
          throw new HttpError(400, '该收集任务未配置材料清单，无法按人工核对通过筛选')
        const suppliedRevision =
          typeof body.rulesRevision === 'string' ? body.rulesRevision.trim() : ''
        if (!suppliedRevision) throw new HttpError(400, '按人工核对通过打包必须提供材料规则版本')
        if (suppliedRevision !== targetCollection.materialRevision)
          throw new HttpError(409, '材料规则已变更，请刷新后再生成打包计划')
        boundRulesRevision = targetCollection.materialRevision
        const beforeCount = chosen.length
        chosen = chosen.filter((f) => materialReviewState(targetCollection, f) === 'accepted')
        excludedCount = beforeCount - chosen.length
        if (!chosen.length)
          throw new HttpError(400, '所选文件中没有当前规则版本下人工核对通过的文件')
      }
      const totalBytes = chosen.reduce((sum, f) => sum + f.size, 0)
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes)
        throw new HttpError(413, '单个归档最多包含 10 GiB 内容，请分批下载')
      if (plans.size >= 20) throw new HttpError(429, '短期打包计划过多，请关闭旧预览或稍后重试')
      const stamp = new Date(Date.now() + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 16)
        .replace(/[-:]/g, '')
        .replace('T', '_')
      const result: ArchivePlan = {
        id: randomUUID(),
        fileName: `集屿归档_${stamp}.zip`,
        layout: resolvedLayout,
        totalBytes,
        entries: archiveEntries(chosen, store.collections(), resolvedLayout),
        expiresAt: new Date(Date.now() + ttl).toISOString(),
        status: 'ready',
        ...(acceptedOnly
          ? { acceptedOnly: true, rulesRevision: boundRulesRevision, excludedCount }
          : {}),
      }
      const snapshots = chosen.map((file) => {
        const key = store.fileKey(file.id)
        if (
          !key ||
          !/^[a-f0-9-]{36}$/.test(key) ||
          !file.sha256 ||
          !/^[a-f0-9]{64}$/.test(file.sha256)
        )
          throw new HttpError(409, '文件存储或校验记录无效，请检查文件后重试')
        return { file, key }
      })
      plans.set(result.id, {
        ...result,
        collectionId: boundCollectionId,
        files: snapshots,
        session: session(req),
        expires: Date.now() + ttl,
      })
      return result
    },
  )
  app.get('/api/archives/:id', async (req) => {
    const plan = get(req)
    return { status: plan.status, error: plan.error }
  })
  app.delete('/api/archives/:id', async (req) => {
    const plan = get(req)
    if (plan.status === 'streaming') plan.stop?.()
    else plans.delete(plan.id)
    return { ok: true }
  })
  app.get(
    '/api/archives/:id/download',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const plan = get(req)
      if (plan.status !== 'ready') throw new HttpError(409, '该计划已使用，请重新生成打包计划')
      if (active >= 2) {
        plan.status = 'failed'
        plan.error = '已有两个归档正在传输，请稍后重新生成预览'
        throw new HttpError(429, plan.error)
      }
      plan.status = 'streaming'
      active++
      let input: Readable | undefined,
        verifier: Transform | undefined,
        output: Readable | undefined,
        timer: ReturnType<typeof setTimeout> | undefined,
        finished = false
      const finish = (status: ArchiveStatus, error?: string) => {
        if (finished) return
        finished = true
        active--
        clearTimeout(timer)
        plan.status = status
        plan.error = error
        plan.expires = Date.now() + ttl
        plan.stop = undefined
        if (status !== 'completed') {
          input?.destroy()
          verifier?.destroy()
          output?.destroy(new Error('archive-stopped'))
        }
      }
      plan.stop = () => finish('cancelled', '打包下载已取消，请重新生成计划后重试')
      reply.raw.once('finish', () => finish('completed'))
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) finish('cancelled', '下载连接已中断，可重新生成计划后重试')
      })
      try {
        const current = () => {
          const all = new Map(store.files().map((f) => [f.id, f]))
          if (
            plan.files.some(({ file, key }) => {
              const now = all.get(file.id)
              return (
                !now ||
                now.deletedAt ||
                now.name !== file.name ||
                now.size !== file.size ||
                now.sha256 !== file.sha256 ||
                store.fileKey(file.id) !== key
              )
            })
          )
            throw new HttpError(409, '文件已变化，请重新生成预览后下载')
          if (plan.acceptedOnly) {
            const col = plan.collectionId ? store.collection(plan.collectionId) : undefined
            if (!col || !plan.rulesRevision || col.materialRevision !== plan.rulesRevision)
              throw new HttpError(409, '材料规则已变化，请重新生成预览后下载')
            if (
              plan.files.some(({ file }) => {
                const now = all.get(file.id)
                return !now || materialReviewState(col, now) !== 'accepted'
              })
            )
              throw new HttpError(409, '部分文件的人工核对状态已变化，请重新生成预览后下载')
          }
        }
        current()
        for (const { file, key } of plan.files) {
          if (finished) throw new HttpError(409, '打包下载已取消，请重新生成计划后重试')
          const stat = await lstat(join(store.dataDir, 'objects', key)).catch(() => {
            throw new HttpError(409, '部分文件内容缺失，请检查存储后重试')
          })
          if (!stat.isFile() || stat.size !== file.size)
            throw new HttpError(409, '部分文件内容异常，请检查存储后重试')
        }
        current()
        if (finished) throw new HttpError(409, '打包下载已取消，请重新生成计划后重试')
        const zip = new ZipFile()
        output = zip.outputStream as Readable
        output.on('error', () => finish('failed', '归档传输失败，请重新生成计划后重试'))
        zip.on('error', () => {
          finish('failed', '读取或校验文件失败，归档未完整生成；请检查存储后重试')
        })
        for (const [index, { file, key }] of plan.files.entries())
          zip.addReadStreamLazy(
            plan.entries[index].path,
            { size: file.size, compress: false, mode: 0o100644, mtime: new Date(file.createdAt) },
            (callback) => {
              if (finished) {
                callback(new Error('archive-stopped'), Readable.from([]))
                return
              }
              const hash = createHash('sha256')
              const source = createReadStream(join(store.dataDir, 'objects', key))
              const check = new Transform({
                transform(chunk, _encoding, done) {
                  hash.update(chunk)
                  done(null, chunk)
                },
                flush(done) {
                  done(
                    file.sha256 && hash.digest('hex') !== file.sha256
                      ? new Error('checksum-mismatch')
                      : undefined,
                  )
                },
              })
              input = source
              verifier = check
              source.on('error', (error) => check.destroy(error))
              check.on('error', () => {
                source.destroy()
                zip.emit('error', new Error('file-unreadable'))
              })
              callback(null, source.pipe(check))
            },
          )
        timer = setTimeout(
          () => finish('failed', '归档传输超过 30 分钟，请减少文件数量后重试'),
          30 * 60 * 1000,
        )
        timer.unref()
        store.activity(`开始打包下载 ${plan.entries.length} 个文件`)
        reply
          .header('Content-Type', 'application/zip')
          .header(
            'Content-Disposition',
            `attachment; filename="jiyu-archive.zip"; filename*=UTF-8''${encodeURIComponent(plan.fileName)}`,
          )
        zip.end()
        return reply.send(output)
      } catch (error) {
        finish(
          'failed',
          error instanceof HttpError ? error.message : '归档准备失败，请重新生成计划后重试',
        )
        throw error
      }
    },
  )
  app.addHook('onClose', async () => {
    clearInterval(cleanup)
    for (const plan of plans.values()) plan.stop?.()
    plans.clear()
  })
  return {
    hasReferencedFiles(ids: Set<string>) {
      prune()
      for (const plan of plans.values()) {
        if (!['ready', 'streaming'].includes(plan.status)) continue
        if (plan.files.some(({ file }) => ids.has(file.id))) return true
      }
      return false
    },
  }
}
