import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type {
  Collection,
  CollectedFile,
  CollectionTemplate,
  DeadlineReminderConfig,
  ExportedCollectionTemplate,
  Participant,
  UploadReceipt,
} from '../src/types.ts'
import type { Store } from './store.ts'
import { digest, equalToken, HttpError, object, text } from './security.ts'
import { fileExtensions } from '../src/lib/collections.ts'
import { sanitizeFilenameChars } from '../src/lib/text-safety.ts'
import { fileNameKey, submissionFileName } from '../src/lib/submission-naming.ts'
import { collectionParticipants } from '../src/lib/participants.ts'
import { materialParticipants, materialReviewState } from '../src/lib/materials.ts'
import type { ReceiptMaterialOverview } from '../src/types.ts'

const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
const uuid = /^[a-f0-9-]{36}$/
export interface SubmissionContext {
  fields: Record<string, string>
  replace?: { receiptId: string; keyHash: string }
  parentReceipt?: { receiptId: string; keyHash: string }
  materialIds?: string[]
}
interface SubmissionRecord {
  owner: string
  fields: Record<string, string>
  identity: string
  superseded?: boolean
  parentReceiptId?: string
  receipt: UploadReceipt
}

export function collectionRules(
  body: Record<string, unknown>,
  current?: Collection,
): Partial<Collection> {
  const rawFields = body.fields ?? current?.fields ?? []
  if (!Array.isArray(rawFields) || rawFields.length > 8)
    throw new HttpError(400, '最多设置 8 个提交字段')
  const fields = rawFields.map((value) => {
    const f = object(value),
      id = text(f.id, '字段编号', 40)
    if (!/^field_[a-zA-Z0-9_-]{1,34}$/.test(id) || typeof f.required !== 'boolean')
      throw new HttpError(400, '提交字段配置无效')
    return { id, label: text(f.label, '字段名称', 20), required: f.required }
  })
  if (
    new Set(fields.map((f) => f.id)).size !== fields.length ||
    new Set(fields.map((f) => f.label)).size !== fields.length
  )
    throw new HttpError(400, '字段编号和名称不能重复')
  const identityField = String(body.identityField ?? current?.identityField ?? 'owner')
  if (identityField !== 'owner' && !fields.some((f) => f.id === identityField && f.required))
    throw new HttpError(400, '提交人标识须选择姓名或一个必填字段')
  if (current?.received && identityField !== (current.identityField || 'owner'))
    throw new HttpError(409, '已有提交后不能更换提交人标识，请新建收集')
  const expected = body.expectedSubmitters ?? current?.expectedSubmitters ?? []
  if (!Array.isArray(expected) || expected.length > 1000)
    throw new HttpError(400, '应交名单最多 1000 人')
  const expectedSubmitters = expected.map((v) => text(v, '名单标识', 80))
  if (new Set(expectedSubmitters.map(normalized)).size !== expectedSubmitters.length)
    throw new HttpError(400, '应交名单存在重复标识')
  const restrictToExpectedSubmitters =
    body.restrictToExpectedSubmitters ?? current?.restrictToExpectedSubmitters ?? false
  if (typeof restrictToExpectedSubmitters !== 'boolean')
    throw new HttpError(400, '名单准入开关无效')
  if (restrictToExpectedSubmitters && !expectedSubmitters.length)
    throw new HttpError(400, '开启仅允许名单内提交前，请先填写应交名单')
  const mode = body.submissionMode ?? current?.submissionMode ?? 'append'
  if (mode !== 'append' && mode !== 'single') throw new HttpError(400, '重复提交规则无效')
  const allowReplacement = body.allowReplacement ?? current?.allowReplacement ?? true
  if (typeof allowReplacement !== 'boolean') throw new HttpError(400, '替换规则无效')
  const rawMaterials = body.materials ?? current?.materials ?? []
  if (!Array.isArray(rawMaterials) || rawMaterials.length > 8)
    throw new HttpError(400, '最多设置 8 项材料')
  const materials = rawMaterials.map((value) => {
    const m = object(value),
      id = text(m.id, '材料编号', 40)
    if (!/^mat_[a-zA-Z0-9_-]{1,34}$/.test(id) || typeof m.required !== 'boolean')
      throw new HttpError(400, '材料项配置无效')
    return {
      id,
      name: text(m.name, '材料名称', 30),
      description: text(m.description ?? '', '材料要求', 200, 0),
      required: m.required,
    }
  })
  if (
    new Set(materials.map((m) => m.id)).size !== materials.length ||
    new Set(materials.map((m) => normalized(m.name))).size !== materials.length
  )
    throw new HttpError(400, '材料编号和名称不能重复')
  if (materials.length && !materials.some((m) => m.required))
    throw new HttpError(400, '材料清单至少设置一项必需材料')
  const rawNaming = body.naming ?? current?.naming ?? { parts: [], separator: '_' }
  const naming = object(rawNaming)
  if (
    !Array.isArray(naming.parts) ||
    naming.parts.length > 6 ||
    !naming.parts.every(
      (p) =>
        typeof p === 'string' &&
        [
          'owner',
          'collection',
          'material',
          'date',
          'sequence',
          'original',
          ...fields.map((f) => f.id),
        ].includes(p),
    ) ||
    !['_', '-'].includes(String(naming.separator))
  )
    throw new HttpError(400, '命名规则无效')
  let deadlineReminder: DeadlineReminderConfig | undefined = current?.deadlineReminder
  if (body.deadlineReminder === null) {
    deadlineReminder = {
      enabled: false,
      hoursBefore: current?.deadlineReminder?.hoursBefore ?? 24,
      desensitizeNames: current?.deadlineReminder?.desensitizeNames ?? true,
      ...(current?.deadlineReminder?.lastSentDeadline
        ? { lastSentDeadline: current.deadlineReminder.lastSentDeadline }
        : {}),
      ...(current?.deadlineReminder?.lastSentAt
        ? { lastSentAt: current.deadlineReminder.lastSentAt }
        : {}),
    }
  } else if (body.deadlineReminder !== undefined) {
    const rawReminder = object(body.deadlineReminder)
    if (typeof rawReminder.enabled !== 'boolean') {
      throw new HttpError(400, '定时截止预警开关无效')
    }
    const rawHours = rawReminder.hoursBefore ?? current?.deadlineReminder?.hoursBefore ?? 24
    if (
      typeof rawHours !== 'number' ||
      !Number.isInteger(rawHours) ||
      rawHours < 1 ||
      rawHours > 168
    ) {
      throw new HttpError(400, '预警提前时长需为 1–168 小时之间的整数')
    }
    const rawDesensitize =
      rawReminder.desensitizeNames ?? current?.deadlineReminder?.desensitizeNames ?? true
    if (typeof rawDesensitize !== 'boolean') {
      throw new HttpError(400, '缺交名单脱敏设置无效')
    }
    deadlineReminder = {
      enabled: rawReminder.enabled,
      hoursBefore: rawHours,
      desensitizeNames: rawDesensitize,
      ...(current?.deadlineReminder?.lastSentDeadline
        ? { lastSentDeadline: current.deadlineReminder.lastSentDeadline }
        : {}),
      ...(current?.deadlineReminder?.lastSentAt
        ? { lastSentAt: current.deadlineReminder.lastSentAt }
        : {}),
    }
  } else if (!current) {
    deadlineReminder = {
      enabled: false,
      hoursBefore: 24,
      desensitizeNames: true,
    }
  }
  return {
    fields,
    identityField,
    expectedSubmitters,
    restrictToExpectedSubmitters,
    submissionMode: mode,
    allowReplacement,
    materials,
    naming: { parts: naming.parts as string[], separator: naming.separator as '_' | '-' },
    ...(deadlineReminder ? { deadlineReminder } : {}),
  }
}

function record(store: Store, collectionId: string, receiptId: string, keyHash: string) {
  const row = store.db
    .prepare('SELECT collection_id,key_hash,data FROM submission_records WHERE id=?')
    .get(receiptId) as { collection_id: string; key_hash: string; data: string } | undefined
  if (!row || row.collection_id !== collectionId || !equalToken(row.key_hash, keyHash))
    throw new HttpError(403, '回执或私密凭证不匹配，请检查或联系发起人')
  return JSON.parse(row.data) as SubmissionRecord
}

export function submissionContext(
  store: Store,
  c: Collection,
  owner: string,
  body: Record<string, unknown>,
): SubmissionContext {
  const values = body.fields === undefined ? {} : object(body.fields)
  if (Object.keys(values).some((id) => !(c.fields || []).some((f) => f.id === id)))
    throw new HttpError(400, '提交字段已变更，请刷新收集规则')
  const fields: Record<string, string> = {}
  for (const f of c.fields || [])
    fields[f.id] = text(values[f.id] ?? '', f.label, 80, f.required ? 1 : 0)
  let replace: SubmissionContext['replace']
  if (body.replace !== undefined) {
    const r = object(body.replace),
      receiptId = text(r.receiptId, '回执编号', 36),
      key = text(r.key, '回执凭证', 100)
    if (!uuid.test(receiptId) || !/^[a-zA-Z0-9_-]{32,100}$/.test(key))
      throw new HttpError(400, '回执格式无效')
    replace = { receiptId, keyHash: digest(key) }
  }
  let parentReceipt: SubmissionContext['parentReceipt']
  if (body.parentReceipt !== undefined) {
    if (replace) throw new HttpError(400, '不能同时指定替换与续交回执')
    const p = object(body.parentReceipt),
      receiptId = text(p.receiptId, '回执编号', 36),
      key = text(p.key, '回执凭证', 100)
    if (!uuid.test(receiptId) || !/^[a-zA-Z0-9_-]{32,100}$/.test(key))
      throw new HttpError(400, '回执格式无效')
    parentReceipt = { receiptId, keyHash: digest(key) }
  }
  let materialIds: string[] | undefined
  if (body.materialIds !== undefined) {
    if (
      !Array.isArray(body.materialIds) ||
      !Array.isArray(body.files) ||
      body.materialIds.length !== body.files.length
    )
      throw new HttpError(400, '请为本批每个文件设置材料归属，或选择未分类')
    materialIds = body.materialIds.map((value) => text(value, '材料归属', 40, 0))
  }
  const context = {
    fields,
    ...(replace ? { replace } : {}),
    ...(parentReceipt ? { parentReceipt } : {}),
    ...(materialIds ? { materialIds } : {}),
  }
  validateSubmission(store, c, owner, context)
  return context
}

export function participantIdentity(c: Collection, owner: string, fields: Record<string, string>) {
  return c.identityField && c.identityField !== 'owner' ? fields[c.identityField] || '' : owner
}
export function validateSubmission(
  store: Store,
  c: Collection,
  owner: string,
  context: SubmissionContext,
) {
  // Recheck the latest rules after uploads and before the atomic commit.
  for (const f of c.fields || []) text(context.fields[f.id] ?? '', f.label, 80, f.required ? 1 : 0)
  if (context.materialIds?.some((id) => id && !c.materials?.some((m) => m.id === id)))
    throw new HttpError(400, '材料清单已变更，请刷新后重新选择归属')
  const value = participantIdentity(c, owner, context.fields)
  if (!value) throw new HttpError(400, '请填写提交人标识')
  if (c.restrictToExpectedSubmitters) {
    const allowed = new Set((c.expectedSubmitters || []).map(normalized))
    if (!allowed.has(normalized(value)))
      throw new HttpError(403, '提交信息未通过准入校验，请核对姓名或标识后重试，或联系发起人')
  }
  if (context.replace) {
    if (c.allowReplacement === false) throw new HttpError(403, '发起人未开放替换，请联系发起人')
    const old = record(store, c.id, context.replace.receiptId, context.replace.keyHash)
    if (old.superseded) throw new HttpError(409, '这份回执已被替换，请使用最新回执')
    if (normalized(old.identity) !== normalized(value))
      throw new HttpError(403, '替换时须保持原提交人标识')
  } else {
    if (context.parentReceipt) {
      const parent = record(
        store,
        c.id,
        context.parentReceipt.receiptId,
        context.parentReceipt.keyHash,
      )
      if (parent.superseded) throw new HttpError(409, '这份回执已被替换，请使用最新回执')
      if (normalized(parent.identity) !== normalized(value))
        throw new HttpError(403, '补交时须保持原提交人标识')
    }
    if (
      c.submissionMode === 'single' &&
      store
        .collectionFiles(c.id, false)
        .some((f) => normalized(f.participant || f.owner) === normalized(value))
    )
      throw new HttpError(409, '此标识已提交，请使用本人回执替换，或联系发起人')
  }
}

// Called inside the same transaction that adds the files. No file-system rename.
export function commitSubmission(
  store: Store,
  c: Collection,
  owner: string,
  context: SubmissionContext,
  receipt: UploadReceipt,
  keyHash: string,
  files: CollectedFile[],
) {
  validateSubmission(store, c, owner, context)
  const person = participantIdentity(c, owner, context.fields)
  if (context.replace) {
    const old = record(store, c.id, context.replace.receiptId, context.replace.keyHash)
    for (const f of store.submissionFiles(c.id, context.replace.receiptId))
      store.saveFile({
        ...f,
        deletedAt: receipt.createdAt,
        materialVersion: (f.materialVersion || 0) + 1,
      })
    store.db
      .prepare('UPDATE submission_records SET data=? WHERE id=?')
      .run(JSON.stringify({ ...old, superseded: true }), context.replace.receiptId)
  }
  const occupied = new Set(store.collectionFiles(c.id, false).map((f) => fileNameKey(f.name)))
  files.forEach((f, i) => {
    f.submissionId = receipt.receiptId
    f.submissionFields = context.fields
    f.fieldLabels = Object.fromEntries((c.fields || []).map((v) => [v.id, v.label]))
    f.participant = person
    if (c.materials?.length || context.materialIds) {
      f.materialId = context.materialIds?.[i] || undefined
      f.materialVersion = 1
    }
    f.name = submissionFileName(
      c,
      f.name,
      owner,
      context.fields,
      c.received + i + 1,
      receipt.createdAt,
      occupied,
      f.materialId,
    )
  })
  const parentReceiptId = context.replace?.receiptId || context.parentReceipt?.receiptId
  const data: SubmissionRecord = {
    owner,
    fields: context.fields,
    identity: person,
    ...(parentReceiptId ? { parentReceiptId } : {}),
    receipt,
  }
  store.db
    .prepare('INSERT INTO submission_records VALUES (?,?,?,?)')
    .run(receipt.receiptId, c.id, keyHash, JSON.stringify(data))
}

export function participants(store: Store, c: Collection): Participant[] {
  return collectionParticipants(c, store.collectionFiles(c.id, false))
}

/**
 * 仅沿着已验权的凭证信任链（同一 key_hash 或显式验权写入的 parentReceiptId 链，且同规范化标识）
 * 收集允许汇总的回执 ID，彻底杜绝按未认证明文 participant 跨用户聚合他人文件或管理员线下补录文件。
 */
function resolveTrustedReceiptIds(
  store: Store,
  collectionId: string,
  currentReceiptId: string,
  identityValue: string,
): Set<string> {
  const personKey = normalized(identityValue)
  const rows = store.db
    .prepare('SELECT id, key_hash, data FROM submission_records WHERE collection_id=?')
    .all(collectionId) as { id: string; key_hash: string; data: string }[]

  const sameIdentity = new Map<string, { keyHash: string; parentReceiptId?: string }>()
  for (const row of rows) {
    let parsed: SubmissionRecord
    try {
      parsed = JSON.parse(row.data) as SubmissionRecord
    } catch {
      continue
    }
    if (normalized(parsed.identity || parsed.owner) !== personKey) continue
    sameIdentity.set(row.id, {
      keyHash: row.key_hash,
      parentReceiptId: parsed.parentReceiptId,
    })
  }
  if (!sameIdentity.has(currentReceiptId)) return new Set([currentReceiptId])

  const neighbors = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (a === b) return
    let setA = neighbors.get(a)
    if (!setA) {
      setA = new Set()
      neighbors.set(a, setA)
    }
    setA.add(b)
    let setB = neighbors.get(b)
    if (!setB) {
      setB = new Set()
      neighbors.set(b, setB)
    }
    setB.add(a)
  }

  const byKeyHash = new Map<string, string[]>()
  for (const [id, meta] of sameIdentity) {
    if (meta.parentReceiptId && sameIdentity.has(meta.parentReceiptId)) {
      link(id, meta.parentReceiptId)
    }
    if (meta.keyHash) {
      const list = byKeyHash.get(meta.keyHash)
      if (list) list.push(id)
      else byKeyHash.set(meta.keyHash, [id])
    }
  }
  for (const ids of byKeyHash.values()) {
    for (let i = 1; i < ids.length; i++) link(ids[0], ids[i])
  }

  const visited = new Set<string>([currentReceiptId])
  const queue = [currentReceiptId]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const next of neighbors.get(id) || []) {
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return visited
}

function buildReceiptMaterialOverview(
  c: Collection,
  identityValue: string,
  receiptId: string,
  colActiveFiles: CollectedFile[],
  trustedReceiptIds: Set<string>,
): ReceiptMaterialOverview {
  const trustedFiles = colActiveFiles.filter(
    (f) => Boolean(f.submissionId) && trustedReceiptIds.has(f.submissionId!),
  )
  const linkedBatches = new Set([
    receiptId,
    ...trustedFiles.map((f) => f.submissionId).filter((id): id is string => Boolean(id)),
  ]).size
  const computed = materialParticipants({ ...c, expectedSubmitters: undefined }, trustedFiles)[0]
  const rawSlots =
    computed?.slots ||
    (c.materials || []).map((requirement) => ({
      requirement,
      files: [] as CollectedFile[],
      state: 'missing' as const,
      duplicate: false,
    }))
  const slots = rawSlots.map((slot) => {
    const slotFiles = slot.files.map((f) => {
      const state = materialReviewState(c, f)
      const isStale = state === 'stale'
      return {
        id: f.id,
        name: f.name,
        size: f.size,
        materialState: state,
        latestNote: isStale ? '' : f.materialReview?.note || '',
        ...(f.materialReview?.reviewedAt && !isStale
          ? { reviewedAt: f.materialReview.reviewedAt }
          : {}),
        inCurrentBatch: f.submissionId === receiptId,
      }
    })
    const sortedByReviewed = [...slotFiles].sort((a, b) =>
      (b.reviewedAt || '').localeCompare(a.reviewedAt || ''),
    )
    const latestNeedsChangesNote = sortedByReviewed.find(
      (f) => f.materialState === 'needs_changes' && f.latestNote,
    )?.latestNote
    const latestActiveNote = sortedByReviewed.find((f) => f.latestNote)?.latestNote
    return {
      materialId: slot.requirement.id,
      name: slot.requirement.name,
      required: slot.requirement.required,
      description: slot.requirement.description,
      state: slot.state as 'missing' | ReturnType<typeof materialReviewState>,
      duplicate: slot.duplicate,
      fileCount: slot.files.length,
      files: slotFiles,
      latestNote: latestNeedsChangesNote || latestActiveNote || '',
    }
  })
  const requiredSlots = slots.filter((s) => s.required)
  return {
    identity: identityValue,
    linkedBatches,
    receivedComplete: computed?.receivedComplete ?? false,
    reviewComplete: computed?.reviewComplete ?? false,
    status: computed?.status ?? 'missing',
    requiredTotal: requiredSlots.length,
    requiredSubmitted: requiredSlots.filter((s) => s.fileCount > 0).length,
    requiredAccepted: requiredSlots.filter((s) => s.state === 'accepted').length,
    missingRequired: requiredSlots.filter((s) => s.state === 'missing').map((s) => s.name),
    needsChangesCount: slots.filter((s) => s.state === 'needs_changes').length,
    pendingCount: slots.filter((s) => s.state === 'pending' || s.state === 'stale').length,
    acceptedCount: slots.filter((s) => s.state === 'accepted').length,
    unclassifiedFiles: (computed?.unclassified || []).map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      inCurrentBatch: f.submissionId === receiptId,
    })),
    slots,
  }
}

const TEMPLATE_SCHEMA_V1 = 'jiyu-template-v1' as const
const MAX_IMPORT_RULES_BYTES = 32 * 1024

export function sanitizeTemplateRules(source: Partial<Collection>): Partial<Collection> {
  const rules: Partial<Collection> = {}
  const portableKeys = [
    'title',
    'description',
    'category',
    'target',
    'formats',
    'maxFileSizeMB',
    'maxFilesPerSubmission',
    'maxTotalSizeMB',
    'fields',
    'identityField',
    'naming',
    'submissionMode',
    'allowReplacement',
    'materials',
  ] as const
  for (const k of portableKeys) {
    if (source[k] !== undefined) Object.assign(rules, { [k]: source[k] })
  }
  if (source.deadlineReminder) {
    rules.deadlineReminder = {
      enabled: Boolean(source.deadlineReminder.enabled),
      hoursBefore: source.deadlineReminder.hoursBefore,
      desensitizeNames: source.deadlineReminder.desensitizeNames,
    }
  }
  return rules
}

function parseImportedTemplate(raw: unknown): { name: string; rules: Partial<Collection> } {
  const body = object(raw)
  if (body.schema !== TEMPLATE_SCHEMA_V1) {
    throw new HttpError(400, `模板格式不受支持，仅支持 ${TEMPLATE_SCHEMA_V1} 标准 JSON`)
  }
  const name = text(body.name, '模板名称', 40)
  const rawRules = object(body.rules)
  if (Buffer.byteLength(JSON.stringify(rawRules), 'utf8') > MAX_IMPORT_RULES_BYTES) {
    throw new HttpError(400, '模板规则内容过长，请精简后再导入')
  }
  const optInt = (key: string, max: number) => {
    const val = rawRules[key]
    if (val === undefined) return undefined
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > max) {
      throw new HttpError(400, `模板字段 ${key} 超出允许范围`)
    }
    return val
  }
  const out: Partial<Collection> = {}
  if (rawRules.title !== undefined) out.title = text(rawRules.title, '收集名称', 50, 0)
  if (rawRules.description !== undefined)
    out.description = text(rawRules.description, '收集说明', 150, 0)
  if (rawRules.category !== undefined) {
    if (
      rawRules.category !== 'design' &&
      rawRules.category !== 'document' &&
      rawRules.category !== 'photo'
    ) {
      throw new HttpError(400, '模板收集类型无效')
    }
    out.category = rawRules.category
  }
  const target = optInt('target', 10000)
  if (target !== undefined) out.target = target
  if (rawRules.formats !== undefined) {
    const formats = fileExtensions(text(rawRules.formats, '文件格式', 260))
    if (
      !formats.length ||
      formats.length > 20 ||
      formats.some((f) => !/^[a-z0-9]{1,12}$/.test(f))
    ) {
      throw new HttpError(400, '模板文件格式后缀无效')
    }
    out.formats = formats.join(', ').toUpperCase()
  }
  const maxFileSizeMB = optInt('maxFileSizeMB', 1024)
  if (maxFileSizeMB !== undefined) out.maxFileSizeMB = maxFileSizeMB
  const maxFilesPerSubmission = optInt('maxFilesPerSubmission', 100)
  if (maxFilesPerSubmission !== undefined) out.maxFilesPerSubmission = maxFilesPerSubmission
  const maxTotalSizeMB = optInt('maxTotalSizeMB', 1048576)
  if (maxTotalSizeMB !== undefined) out.maxTotalSizeMB = maxTotalSizeMB

  const validatedRules = collectionRules({
    fields: rawRules.fields,
    identityField: rawRules.identityField,
    submissionMode: rawRules.submissionMode,
    allowReplacement: rawRules.allowReplacement,
    materials: rawRules.materials,
    naming: rawRules.naming,
    deadlineReminder: rawRules.deadlineReminder,
    expectedSubmitters: [],
    restrictToExpectedSubmitters: false,
  })
  const {
    expectedSubmitters: _ignoredRoster,
    restrictToExpectedSubmitters: _ignoredRestrict,
    ...portableValidated
  } = validatedRules
  return {
    name,
    rules: sanitizeTemplateRules({ ...out, ...portableValidated }),
  }
}

export function registerCollectionWorkflows(
  app: FastifyInstance,
  store: Store,
  requirePublicAccess: (req: FastifyRequest, c: Collection) => void = () => {},
  isDemoRequest: (req: FastifyRequest) => boolean = () => false,
) {
  app.get('/api/collections/:id/participants', async (req) => {
    const c = store.collection(String(object(req.params).id))
    if (!c) throw new HttpError(404, '收集不存在')
    const scoped = isDemoRequest(req) && !c.createdByDemo ? { ...c, expectedSubmitters: [] } : c
    return { participants: participants(store, scoped) }
  })
  app.get('/api/public/:token/receipts/:receiptId', async (req) => {
    const p = object(req.params),
      c = store.byToken(String(p.token))
    if (!c) throw new HttpError(404, '收集链接已失效')
    requirePublicAccess(req, c)
    const key = text(req.headers['x-receipt-key'], '回执凭证', 100),
      r = record(store, c.id, String(p.receiptId), digest(key))
    const colActive = store.collectionFiles(c.id, false)
    const batchFiles = colActive.filter((f) => f.submissionId === r.receipt.receiptId)
    const trustedReceiptIds = c.materials?.length
      ? resolveTrustedReceiptIds(store, c.id, r.receipt.receiptId, r.identity || r.owner)
      : undefined
    return {
      receipt: r.receipt,
      owner: r.owner,
      fields: r.fields,
      superseded: !!r.superseded,
      files: batchFiles.map((f) => {
        const matState = c.materials?.length ? materialReviewState(c, f) : undefined
        return {
          id: f.id,
          name: f.name,
          size: f.size,
          ...(matState
            ? {
                materialId: f.materialId,
                materialState: matState,
                materialNote: matState === 'stale' ? '' : f.materialReview?.note || '',
              }
            : {}),
        }
      }),
      ...(c.materials?.length && trustedReceiptIds
        ? {
            materialOverview: buildReceiptMaterialOverview(
              c,
              r.identity || r.owner,
              r.receipt.receiptId,
              colActive,
              trustedReceiptIds,
            ),
          }
        : {}),
    }
  })
  app.get('/api/templates', async () => ({
    templates: (
      store.db.prepare('SELECT data FROM collection_templates ORDER BY rowid DESC').all() as {
        data: string
      }[]
    ).map((r) => JSON.parse(r.data)),
  }))
  app.post('/api/templates', async (req) => {
    const b = object(req.body),
      c = store.collection(String(b.collectionId))
    if (!c) throw new HttpError(404, '收集不存在')
    if (
      (store.db.prepare('SELECT COUNT(*) AS n FROM collection_templates').get() as { n: number })
        .n >= 50
    )
      throw new HttpError(400, '最多保存 50 个模板，请重用现有模板')
    const rules = sanitizeTemplateRules(c)
    const template: CollectionTemplate = {
      id: randomUUID(),
      name: text(b.name, '模板名称', 40),
      rules,
      archived: false,
    }
    store.transaction(() => {
      store.db
        .prepare('INSERT INTO collection_templates VALUES (?,?)')
        .run(template.id, JSON.stringify(template))
      store.activity(`保存了收集模板「${template.name}」`)
    })
    return template
  })
  app.get('/api/templates/:id/export', async (req, reply) => {
    const id = String(object(req.params).id)
    const row = store.db.prepare('SELECT data FROM collection_templates WHERE id=?').get(id) as
      | { data: string }
      | undefined
    if (!row) throw new HttpError(404, '模板不存在')
    const t = JSON.parse(row.data) as CollectionTemplate
    const exported: ExportedCollectionTemplate = {
      schema: TEMPLATE_SCHEMA_V1,
      exportedAt: new Date().toISOString(),
      name: t.name,
      rules: sanitizeTemplateRules(t.rules || {}),
    }
    const cleanBase =
      sanitizeFilenameChars(t.name.normalize('NFC'), '_', { stripBidi: true })
        .trim()
        .replace(/^\.+|[. ]+$/g, '') || 'jiyu-template'
    const downloadName = `${cleanBase}.jiyu-template.json`
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="jiyu-template.json"; filename*=UTF-8''${encodeURIComponent(downloadName).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`)}`,
      )
    return exported
  })
  app.post('/api/templates/import', async (req, reply) => {
    if (
      (store.db.prepare('SELECT COUNT(*) AS n FROM collection_templates').get() as { n: number })
        .n >= 50
    )
      throw new HttpError(400, '最多保存 50 个模板，请重用现有模板')
    const { name, rules } = parseImportedTemplate(req.body)
    const template: CollectionTemplate = {
      id: randomUUID(),
      name,
      rules,
      archived: false,
    }
    store.transaction(() => {
      store.db
        .prepare('INSERT INTO collection_templates VALUES (?,?)')
        .run(template.id, JSON.stringify(template))
      store.activity(`导入了收集模板「${template.name}」`)
    })
    reply.code(201)
    return template
  })
  app.patch('/api/templates/:id', async (req) => {
    const id = String(object(req.params).id),
      row = store.db.prepare('SELECT data FROM collection_templates WHERE id=?').get(id) as
        | { data: string }
        | undefined
    if (!row) throw new HttpError(404, '模板不存在')
    const b = object(req.body),
      t = JSON.parse(row.data) as CollectionTemplate
    if (typeof b.archived !== 'boolean') throw new HttpError(400, '模板状态无效')
    t.archived = b.archived
    store.transaction(() => {
      store.db
        .prepare('UPDATE collection_templates SET data=? WHERE id=?')
        .run(JSON.stringify(t), id)
      store.activity(`${t.archived ? '归档' : '恢复'}了模板「${t.name}」`)
    })
    return t
  })
}
