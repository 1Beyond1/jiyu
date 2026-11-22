import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { submissionFileName } from './submission-naming.ts'
import { collectionPresets } from './collection-presets.ts'
import { collectionRules } from '../../server/collection-workflows.ts'

test('内置模板能通过正式规则校验，示例命名保留扩展名并遵守 UTC+8 日期', () => {
  for (const preset of collectionPresets)
    assert.doesNotThrow(() => collectionRules(preset.rules as Record<string, unknown>))
  const homework = collectionPresets.find((p) => p.id === 'builtin-homework')!.rules
  assert.equal(
    submissionFileName(
      { title: '作业', naming: homework.naming },
      '报告.PDF',
      '小/屿',
      { field_student: 'A01' },
      1,
      '2026-10-22T16:00:00Z',
    ),
    'A01_小-屿_报告.PDF',
  )
  assert.equal(
    submissionFileName(
      { title: '交付', naming: { parts: ['date', 'sequence'], separator: '-' } },
      '原文.zip',
      '',
      {},
      9,
      '2026-10-22T16:00:00Z',
    ),
    '20261023-009.zip',
  )
})

test('命名示例与实际提交共用去重、空字段、保留名和长度限制', () => {
  const c = { title: '资料', naming: { parts: ['owner'], separator: '_' as const } },
    occupied = new Set<string>(['a.txt'])
  assert.equal(submissionFileName(c, '原文.txt', 'A', {}, 1, '2026-10-22', occupied), 'A_2.txt')
  assert.equal(submissionFileName(c, '原文.txt', 'CON', {}, 1, '2026-10-22'), '_CON.txt')
  assert.equal(submissionFileName(c, '原文.txt', '', {}, 1, '2026-10-22'), '未填写.txt')
  assert.equal(
    submissionFileName({ title: '资料' }, '原文.txt', '', {}, 1, '2026-10-22'),
    '原文.txt',
  )
  assert.ok(submissionFileName(c, '原文.txt', '长'.repeat(200), {}, 1, '2026-10-22').length < 200)
})

test('自动命名与规则校验支持材料项占位符，未分类时优雅回退', () => {
  const rules = collectionRules({
    materials: [{ id: 'mat_form', name: '报名表', required: true, description: '' }],
    naming: { parts: ['material', 'owner', 'original'], separator: '_' },
  })
  assert.deepEqual(rules.naming?.parts, ['material', 'owner', 'original'])
  assert.equal(
    submissionFileName(
      {
        title: '征集',
        materials: [{ id: 'mat_form', name: '报名表', required: true, description: '' }],
        naming: { parts: ['material', 'owner'], separator: '_' },
      },
      'scan.pdf',
      '张三',
      {},
      1,
      '2026-11-22T00:00:00Z',
      new Set(),
      'mat_form',
    ),
    '报名表_张三.pdf',
  )
  assert.equal(
    submissionFileName(
      {
        title: '征集',
        materials: [{ id: 'mat_form', name: '报名表', required: true, description: '' }],
        naming: { parts: ['material', 'owner'], separator: '-' },
      },
      'scan.pdf',
      '张三',
      {},
      1,
      '2026-11-22T00:00:00Z',
      new Set(),
      undefined,
    ),
    '未分类-张三.pdf',
  )
})
