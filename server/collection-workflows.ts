import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Collection, CollectedFile, CollectionTemplate, Participant, UploadReceipt } from '../src/types.ts'
import type { Store } from './store.ts'
import { digest, equalToken, HttpError, object, text } from './security.ts'

const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
const uuid = /^[a-f0-9-]{36}$/
export interface SubmissionContext { fields: Record<string, string>; replace?: { receiptId: string; keyHash: string } }
interface SubmissionRecord { owner: string; fields: Record<string, string>; identity: string; superseded?: boolean; receipt: UploadReceipt }

export function collectionRules(body: Record<string, unknown>, current?: Collection): Partial<Collection> {
  const rawFields = body.fields ?? current?.fields ?? []
  if (!Array.isArray(rawFields) || rawFields.length > 8) throw new HttpError(400, '最多设置 8 个提交字段')
  const fields = rawFields.map(value => {
    const f = object(value), id = text(f.id, '字段编号', 40)
    if (!/^field_[a-zA-Z0-9_-]{1,34}$/.test(id) || typeof f.required !== 'boolean') throw new HttpError(400, '提交字段配置无效')
    return { id, label: text(f.label, '字段名称', 20), required: f.required }
  })
  if (new Set(fields.map(f => f.id)).size !== fields.length || new Set(fields.map(f => f.label)).size !== fields.length) throw new HttpError(400, '字段编号和名称不能重复')
  const identityField = String(body.identityField ?? current?.identityField ?? 'owner')
  if (identityField !== 'owner' && !fields.some(f => f.id === identityField && f.required)) throw new HttpError(400, '提交人标识须选择姓名或一个必填字段')
  if (current?.received && identityField !== (current.identityField || 'owner')) throw new HttpError(409, '已有提交后不能更换提交人标识，请新建收集')
  const expected = body.expectedSubmitters ?? current?.expectedSubmitters ?? []
  if (!Array.isArray(expected) || expected.length > 1000) throw new HttpError(400, '应交名单最多 1000 人')
  const expectedSubmitters = expected.map(v => text(v, '名单标识', 80))
  if (new Set(expectedSubmitters.map(normalized)).size !== expectedSubmitters.length) throw new HttpError(400, '应交名单存在重复标识')
  const mode = body.submissionMode ?? current?.submissionMode ?? 'append'
  if (mode !== 'append' && mode !== 'single') throw new HttpError(400, '重复提交规则无效')
  const allowReplacement = body.allowReplacement ?? current?.allowReplacement ?? true
  if (typeof allowReplacement !== 'boolean') throw new HttpError(400, '替换规则无效')
  const rawNaming = body.naming ?? current?.naming ?? { parts: [], separator: '_' }
  const naming = object(rawNaming)
  if (!Array.isArray(naming.parts) || naming.parts.length > 6 || !naming.parts.every(p => typeof p === 'string' && ['owner', 'collection', 'date', 'sequence', 'original', ...fields.map(f => f.id)].includes(p)) || !['_', '-'].includes(String(naming.separator))) throw new HttpError(400, '命名规则无效')
  return { fields, identityField, expectedSubmitters, submissionMode: mode, allowReplacement, naming: { parts: naming.parts as string[], separator: naming.separator as '_' | '-' } }
}

function record(store: Store, collectionId: string, receiptId: string, keyHash: string) {
  const row = store.db.prepare('SELECT collection_id,key_hash,data FROM submission_records WHERE id=?').get(receiptId) as { collection_id: string; key_hash: string; data: string } | undefined
  if (!row || row.collection_id !== collectionId || !equalToken(row.key_hash, keyHash)) throw new HttpError(403, '回执或私密凭证不匹配，请检查或联系发起人')
  return JSON.parse(row.data) as SubmissionRecord
}

export function submissionContext(store: Store, c: Collection, owner: string, body: Record<string, unknown>): SubmissionContext {
  const values = body.fields === undefined ? {} : object(body.fields)
  if (Object.keys(values).some(id => !(c.fields || []).some(f => f.id === id))) throw new HttpError(400, '提交字段已变更，请刷新收集规则')
  const fields: Record<string, string> = {}
  for (const f of c.fields || []) fields[f.id] = text(values[f.id] ?? '', f.label, 80, f.required ? 1 : 0)
  let replace: SubmissionContext['replace']
  if (body.replace !== undefined) {
    const r = object(body.replace), receiptId = text(r.receiptId, '回执编号', 36), key = text(r.key, '回执凭证', 100)
    if (!uuid.test(receiptId) || !/^[a-zA-Z0-9_-]{32,100}$/.test(key)) throw new HttpError(400, '回执格式无效')
    replace = { receiptId, keyHash: digest(key) }
  }
  const context = { fields, ...(replace ? { replace } : {}) }
  validateSubmission(store, c, owner, context)
  return context
}

function identity(c: Collection, owner: string, fields: Record<string, string>) { return c.identityField && c.identityField !== 'owner' ? fields[c.identityField] || '' : owner }
export function validateSubmission(store: Store, c: Collection, owner: string, context: SubmissionContext) {
  // Recheck the latest rules after uploads and before the atomic commit.
  for (const f of c.fields || []) text(context.fields[f.id] ?? '', f.label, 80, f.required ? 1 : 0)
  const value = identity(c, owner, context.fields)
  if (!value) throw new HttpError(400, '请填写提交人标识')
  if (context.replace) {
    if (c.allowReplacement === false) throw new HttpError(403, '发起人未开放替换，请联系发起人')
    const old = record(store, c.id, context.replace.receiptId, context.replace.keyHash)
    if (old.superseded) throw new HttpError(409, '这份回执已被替换，请使用最新回执')
    if (normalized(old.identity) !== normalized(value)) throw new HttpError(403, '替换时须保持原提交人标识')
  } else if (c.submissionMode === 'single' && store.files().some(f => f.collectionId === c.id && !f.deletedAt && normalized(f.participant || f.owner) === normalized(value))) throw new HttpError(409, '此标识已提交，请使用本人回执替换，或联系发起人')
}

const segment = (value: string) => value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 45) || '未填写'
// Called inside the same transaction that adds the files. No file-system rename.
export function commitSubmission(store: Store, c: Collection, owner: string, context: SubmissionContext, receipt: UploadReceipt, keyHash: string, files: CollectedFile[]) {
  validateSubmission(store, c, owner, context)
  const person = identity(c, owner, context.fields)
  if (context.replace) {
    const old = record(store, c.id, context.replace.receiptId, context.replace.keyHash)
    for (const f of store.files()) if (f.submissionId === context.replace.receiptId && !f.deletedAt) store.saveFile({ ...f, deletedAt: receipt.createdAt })
    store.db.prepare('UPDATE submission_records SET data=? WHERE id=?').run(JSON.stringify({ ...old, superseded: true }), context.replace.receiptId)
  }
  const occupied = new Set(store.files().filter(f => f.collectionId === c.id && !f.deletedAt).map(f => normalized(f.name)))
  files.forEach((f, i) => {
    f.submissionId = receipt.receiptId; f.submissionFields = context.fields; f.fieldLabels = Object.fromEntries((c.fields || []).map(v => [v.id, v.label])); f.participant = person
    if (!c.naming?.parts.length) return
    const dot = f.name.lastIndexOf('.'), ext = dot > 0 ? f.name.slice(dot) : '', original = dot > 0 ? f.name.slice(0, dot) : f.name
    const values: Record<string, string> = { ...context.fields, owner, collection: c.title, date: new Date(receipt.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).replaceAll('-', ''), sequence: String(c.received + i + 1).padStart(3, '0'), original }
    let base = c.naming.parts.map(p => segment(values[p] || '')).join(c.naming.separator).slice(0, 150)
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `_${base}`
    let name = base + ext, n = 2
    while (occupied.has(normalized(name))) name = `${base}_${n++}${ext}`
    f.name = name; occupied.add(normalized(name))
  })
  const data: SubmissionRecord = { owner, fields: context.fields, identity: person, receipt }
  store.db.prepare('INSERT INTO submission_records VALUES (?,?,?,?)').run(receipt.receiptId, c.id, keyHash, JSON.stringify(data))
}

export function participants(store: Store, c: Collection): Participant[] {
  const groups = new Map<string, Participant>()
  for (const name of c.expectedSubmitters || []) groups.set(normalized(name), { identity: name, owner: '', expected: true, fileIds: [], bytes: 0, submissions: 0, latestAt: '', duplicates: 0 })
  const hashes = new Map<string, Set<string>>(), submissions = new Map<string, Set<string>>()
  for (const f of store.files().filter(f => f.collectionId === c.id && !f.deletedAt)) {
    const name = f.participant || f.owner, key = normalized(name)
    const p = groups.get(key) || { identity: name, owner: f.owner, expected: false, fileIds: [], bytes: 0, submissions: 0, latestAt: '', duplicates: 0 }
    p.owner = f.owner; p.fileIds.push(f.id); p.bytes += f.size; p.latestAt = p.latestAt > f.createdAt ? p.latestAt : f.createdAt
    const seen = hashes.get(key) || new Set<string>(); if (f.sha256 && seen.has(f.sha256)) p.duplicates++; if (f.sha256) seen.add(f.sha256); hashes.set(key, seen)
    const batches = submissions.get(key) || new Set<string>(); batches.add(f.submissionId || f.createdAt); submissions.set(key, batches); p.submissions = batches.size; groups.set(key, p)
  }
  return [...groups.values()]
}

export function registerCollectionWorkflows(app: FastifyInstance, store: Store) {
  app.get('/api/collections/:id/participants', async req => {
    const c = store.collection(String(object(req.params).id)); if (!c) throw new HttpError(404, '收集不存在')
    return { participants: participants(store, c) }
  })
  app.get('/api/public/:token/receipts/:receiptId', async req => {
    const p = object(req.params), c = store.byToken(String(p.token)); if (!c) throw new HttpError(404, '收集链接已失效')
    const key = text(req.headers['x-receipt-key'], '回执凭证', 100), r = record(store, c.id, String(p.receiptId), digest(key))
    return { receipt: r.receipt, owner: r.owner, fields: r.fields, superseded: !!r.superseded, files: store.files().filter(f => f.submissionId === r.receipt.receiptId && !f.deletedAt).map(({ id, name, size }) => ({ id, name, size })) }
  })
  app.get('/api/templates', async () => ({ templates: (store.db.prepare('SELECT data FROM collection_templates ORDER BY rowid DESC').all() as { data: string }[]).map(r => JSON.parse(r.data)) }))
  app.post('/api/templates', async req => {
    const b = object(req.body), c = store.collection(String(b.collectionId)); if (!c) throw new HttpError(404, '收集不存在')
    if ((store.db.prepare('SELECT COUNT(*) AS n FROM collection_templates').get() as { n: number }).n >= 50) throw new HttpError(400, '最多保存 50 个模板，请重用现有模板')
    const rules: Partial<Collection> = {}
    for (const k of ['title', 'description', 'category', 'target', 'formats', 'maxFileSizeMB', 'maxFilesPerSubmission', 'maxTotalSizeMB', 'fields', 'identityField', 'naming', 'submissionMode', 'allowReplacement'] as const) Object.assign(rules, { [k]: c[k] })
    const template: CollectionTemplate = { id: randomUUID(), name: text(b.name, '模板名称', 40), rules, archived: false }
    store.transaction(() => { store.db.prepare('INSERT INTO collection_templates VALUES (?,?)').run(template.id, JSON.stringify(template)); store.activity(`保存了收集模板「${template.name}」`) }); return template
  })
  app.patch('/api/templates/:id', async req => {
    const id = String(object(req.params).id), row = store.db.prepare('SELECT data FROM collection_templates WHERE id=?').get(id) as { data: string } | undefined
    if (!row) throw new HttpError(404, '模板不存在')
    const b = object(req.body), t = JSON.parse(row.data) as CollectionTemplate
    if (typeof b.archived !== 'boolean') throw new HttpError(400, '模板状态无效')
    t.archived = b.archived
    store.transaction(() => { store.db.prepare('UPDATE collection_templates SET data=? WHERE id=?').run(JSON.stringify(t), id); store.activity(`${t.archived ? '归档' : '恢复'}了模板「${t.name}」`) }); return t
  })
}
