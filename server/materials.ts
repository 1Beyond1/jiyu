import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Collection, CollectedFile, UserRole } from '../src/types.ts'
import type { Store } from './store.ts'
import type { Config } from './config.ts'
import { digest, HttpError, object, text } from './security.ts'
import { materialStateVersion, materialFileVersion, materialReportCsv } from '../src/lib/materials.ts'

export function materialRuleKey(c: Collection) {
  return JSON.stringify([c.title, c.description, c.formats, c.maxFileSizeMB, c.identityField || 'owner', c.fields || [], c.materials || []])
}

export function registerMaterials(app: FastifyInstance, store: Store, config: Config, who: (req: FastifyRequest) => { id: string; display_name: string; role: UserRole } | undefined) {
  app.get('/api/collections/:id/materials/export', async (req, reply) => {
    const c = store.collection(String(object(req.params).id))
    if (!c?.materials?.length) throw new HttpError(404, '此任务未配置材料清单')
    if (String(object(req.query).revision) !== c.materialRevision) throw new HttpError(409, '材料规则已改变，请刷新后重新导出台账')
    reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="jiyu-materials.csv"')
    return materialReportCsv(c, store.files())
  })
  for (const kind of ['classify', 'review'] as const) app.post(`/api/materials/${kind}`, async req => {
    const user = who(req)
    if (!user || user.role === 'viewer') throw new HttpError(403, '材料分类和核对需要编辑权限')
    const body = object(req.body), collectionId = text(body.collectionId, '任务编号', 36)
    const c = store.collection(collectionId)
    if (!c?.materials?.length) throw new HttpError(400, '此任务未配置材料清单')
    const revision = text(body.rulesRevision, '规则版本', 100), requestId = text(body.requestId, '操作编号', 36)
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new HttpError(400, '操作编号无效')
    if (c.materialRevision !== revision) throw new HttpError(409, '材料规则已改变，请刷新后重新核对')
    if (!Array.isArray(body.files) || !body.files.length || body.files.length > 50) throw new HttpError(400, '每次选择 1–50 个文件')
    const changes = body.files.map(value => {
      const item = object(value)
      return { id: text(item.id, '文件编号', 36), expectedVersion: text(item.expectedVersion, '文件版本', 2000), ...(kind === 'classify' ? { materialId: text(item.materialId, '材料归属', 40, 0) } : {}) }
    })
    if (new Set(changes.map(v => v.id)).size !== changes.length) throw new HttpError(400, '操作包含重复文件')
    const decision = kind === 'review' ? body.decision : undefined
    if (kind === 'review' && decision !== 'accepted' && decision !== 'needs_changes') throw new HttpError(400, '请选择核对通过或需补充')
    const note = kind === 'review' ? text(body.note ?? '', '核对说明', 300, decision === 'needs_changes' ? 1 : 0) : ''
    const signature = digest(JSON.stringify([kind, collectionId, revision, changes, decision, note]))
    store.transaction(() => {
      const all = store.files(), selected = changes.map(change => {
        const f = all.find(f => f.id === change.id && f.collectionId === c.id && !f.deletedAt)
        if (!f) throw new HttpError(409, '文件不存在、已移入回收站或不属于此任务，请刷新')
        return f
      })
      const reused = all.some(f => f.materialAction?.id === requestId)
      if (reused) {
        if (selected.every(f => f.materialAction?.id === requestId && f.materialAction.signature === signature && f.materialAction.resultVersion === materialStateVersion(f))) return
        throw new HttpError(409, '该操作已有后续变化或编号已使用，请刷新后重新操作')
      }
      for (let i = 0; i < selected.length; i++) {
        const f = selected[i], change = changes[i]
        if (change.expectedVersion !== materialStateVersion(f)) throw new HttpError(409, '文件分类或核对已有后续变化，请刷新后重新确认')
        if (kind === 'classify' && change.materialId && !c.materials!.some(m => m.id === change.materialId)) throw new HttpError(400, '材料项已移除，请刷新材料清单')
        if (kind === 'review' && decision === 'accepted' && !c.materials!.some(m => m.id === f.materialId)) throw new HttpError(400, '未分类文件不能直接标记核对通过')
      }
      selected.forEach((f, i) => {
        let next: CollectedFile
        if (kind === 'classify') {
          const materialId = changes[i].materialId || undefined
          next = { ...f, materialId, materialVersion: (f.materialVersion || 0) + (materialId !== f.materialId ? 1 : 0) }
        } else next = { ...f, materialReview: { decision: decision as 'accepted' | 'needs_changes', note, rulesRevision: revision, fileVersion: materialFileVersion(f), operationId: requestId, reviewerId: user.id, reviewerName: user.display_name, reviewedAt: new Date().toISOString() } }
        next.materialAction = { id: requestId, signature, resultVersion: materialStateVersion(next) }
        store.saveFile(next)
      })
      store.activity(`${user.display_name}对「${c.title}」${selected.length} 份文件${kind === 'classify' ? '调整材料归属' : decision === 'accepted' ? '完成人工核对' : '标记需补充'}`)
    })
    return store.workspace(config.quotaBytes, config.requestBytes)
  })
}
