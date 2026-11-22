import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildMetadataExport } from './metadata-export.ts'
import type { Workspace } from '../types.ts'

const sampleWorkspace: Workspace = {
  version: 1,
  displayName: '测试工作台',
  collections: [
    {
      id: 'c-1',
      title: '期末作业',
      description: '请按规范命名',
      category: 'document',
      received: 2,
      target: 10,
      deadline: '2099-12-31',
      storage: 'local',
      status: 'active',
      formats: 'PDF',
      maxFileSizeMB: 10,
      maxFilesPerSubmission: 5,
      uploadToken: 'secret-upload-token-xyz',
      expectedSubmitters: ['2026001 张三', '2026002 李四'],
    },
  ],
  files: [
    {
      id: 'f-1',
      name: '作业.pdf',
      size: 1024,
      collectionId: 'c-1',
      owner: '张三',
      createdAt: '2026-11-20T00:00:00.000Z',
      storage: 'local',
      status: 'pending',
    },
  ],
  activities: [{ id: '1', text: '创建任务', time: '2026/11/20 08:00:00' }],
  trash: [],
}

test('默认元数据导出自动脱敏 uploadToken 与 expectedSubmitters，且不修改原对象', () => {
  const exported = buildMetadataExport(sampleWorkspace, {
    exportedAt: '2026-11-22T00:00:00.000Z',
  })
  assert.equal(exported.exportMeta.mode, 'sanitized')
  assert.deepEqual(exported.exportMeta.redactedFields, [
    'collections[].uploadToken',
    'collections[].expectedSubmitters',
  ])
  assert.equal('uploadToken' in exported.collections[0], false)
  assert.equal('expectedSubmitters' in exported.collections[0], false)
  const serialized = JSON.stringify(exported)
  assert.equal(serialized.includes('secret-upload-token-xyz'), false)
  assert.equal(serialized.includes('2026001 张三'), false)

  // 原对象不受影响
  assert.equal(sampleWorkspace.collections[0].uploadToken, 'secret-upload-token-xyz')
  assert.deepEqual(sampleWorkspace.collections[0].expectedSubmitters, [
    '2026001 张三',
    '2026002 李四',
  ])
})

test('显式确认完整导出时保留 uploadToken 与 expectedSubmitters 并标注 full 模式', () => {
  const exported = buildMetadataExport(sampleWorkspace, {
    includeSensitive: true,
    exportedAt: '2026-11-22T00:00:00.000Z',
  })
  assert.equal(exported.exportMeta.mode, 'full')
  assert.deepEqual(exported.exportMeta.redactedFields, [])
  assert.equal(exported.collections[0].uploadToken, 'secret-upload-token-xyz')
  assert.deepEqual(exported.collections[0].expectedSubmitters, ['2026001 张三', '2026002 李四'])
})
