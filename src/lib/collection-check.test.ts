import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { checkCollection, filesForAction } from './collection-check.ts'
import type { Collection, CollectedFile } from '../types.ts'

test('任务检查按规范化标识核对名单，重复统计排除回收站与其他任务', () => {
  const c: Collection = { id: 'c', title: '作业', description: '', category: 'document', received: 5, target: 30, deadline: '2099-12-31', storage: 'local', status: 'active', formats: 'TXT', maxFileSizeMB: 1, maxFilesPerSubmission: 5, identityField: 'field_student', expectedSubmitters: ['Ａ01', 'A02'] }
  const f: CollectedFile = { id: 'f', name: '作业.txt', size: 3, collectionId: 'c', owner: '同名学生', participant: 'a01', createdAt: '2026-10-22', storage: 'local', status: 'pending', sha256: 'same' }
  const r = checkCollection(c, [f, { ...f, id: 'f2', name: '作业.TXT' }, { ...f, id: 'trash', participant: 'A02', deletedAt: '2026-10-22' }, { ...f, id: 'other', collectionId: 'other', participant: 'A02' }])
  assert.equal(r.files, 2); assert.equal(r.submitted, 1); assert.deepEqual(r.missing, ['A02']); assert.equal(r.contentGroups.length, 1); assert.equal(r.nameGroups.length, 1)
  const noRoster = checkCollection({ ...c, expectedSubmitters: [] }, [f]); assert.equal(noRoster.hasRoster, false); assert.deepEqual(noRoster.missing, [])
  // A historical action stays bound to its original IDs after the user switches scope.
  assert.deepEqual(filesForAction(['f'], [f, { ...f, id: 'other', collectionId: 'other' }]).map(v => v.id), ['f'])
  assert.deepEqual(filesForAction(['f'], [{ ...f, deletedAt: '2026-10-23' }]), [])
})

test('材料任务的检查结果按必需项收齐统计，单份已整理文件不等于核对通过', () => {
  const c = { id: 'c', expectedSubmitters: ['A01', 'A02'], materials: [{ id: 'mat_form', name: '报名表', required: true }, { id: 'mat_statement', name: '作品说明', required: true }] } as Collection
  const f = { id: 'f', collectionId: 'c', name: '报名表.txt', owner: '同名', participant: 'A01', materialId: 'mat_form', sha256: 'form', size: 3, createdAt: '2026-10-24', storage: 'local', status: 'ready' } as CollectedFile
  const r = checkCollection(c, [f])
  assert.deepEqual(r.missing, ['A01', 'A02'])
  assert.deepEqual(r.materials, { received: 0, reviewed: 0, unclassified: 0 })
  const complete = checkCollection(c, [f, { ...f, id: 's', materialId: 'mat_statement', sha256: 'statement' }])
  assert.deepEqual(complete.materials, { received: 1, reviewed: 0, unclassified: 0 })
  assert.deepEqual(complete.missing, ['A02'])
})
