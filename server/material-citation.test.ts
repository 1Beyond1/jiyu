import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMaterialFindings } from './material-ai.ts'
import type { MaterialAIPreview } from '../src/types.ts'

const preview = (excerpt: string) =>
  ({
    materials: [],
    sources: [{ id: 'a', alias: 'F1', excerpt, start: 0, end: excerpt.length, coverage: 'full' }],
  }) as unknown as MaterialAIPreview
const result = (evidence: object) => [
  {
    file: 'F1',
    assessment: 'uncertain',
    materialId: '',
    message: '请核对',
    suggestion: '人工确认',
    evidence: [evidence],
  },
]
const parse = (p: MaterialAIPreview, e: object) =>
  parseMaterialFindings(result(e), p, 'fixture-secret')

test('引用仅在同文件唯一出现且同时省略两端时自动定位', () => {
  const p = preview('作品：木桥。\n活动：模型交流。')
  assert.deepEqual(parse(p, { file: 'F1', quote: '作品：木桥。' })[0].evidence[0], {
    fileId: 'a',
    start: 0,
    end: 6,
    quote: '作品：木桥。',
  })
  assert.deepEqual(
    parse(p, { file: 'F1', start: 7, end: 15, quote: '活动：模型交流。' })[0].evidence[0],
    { fileId: 'a', start: 7, end: 15, quote: '活动：模型交流。' },
  )
  assert.throws(() => parse(p, { file: 'F1', start: 0, end: 5, quote: '作品：木桥。' }))
  assert.throws(() => parse(p, { file: 'F1', start: 0, quote: '作品：木桥。' }))
  assert.throws(() => parse(p, { file: 'F2', quote: '作品：木桥。' }))
  assert.throws(() => parse(p, { file: 'F1', quote: '未授权的文本' }))
  assert.throws(() => parse(preview('纸塔纸塔'), { file: 'F1', quote: '纸塔' }))
  assert.throws(() => parse(preview('aaa'), { file: 'F1', quote: 'aa' }))
})

test('未读材料不能借引用得出结论', () => {
  const p = preview('')
  p.sources[0].coverage = 'unread'
  assert.throws(() => parse(p, { file: 'F1', quote: '文字' }))
})

test('仅片段未见问题可无补充建议，其他判断仍须填写', () => {
  const p = preview('唯一原文'),
    e = { file: 'F1', start: 0, end: 4, quote: '唯一原文' }
  const finding = { ...result(e)[0], assessment: 'no_issue_in_excerpt', suggestion: '' }
  assert.equal(parseMaterialFindings([finding], p, 'fixture-secret')[0].suggestion, '')
  assert.throws(() =>
    parseMaterialFindings([{ ...finding, assessment: 'attention' }], p, 'fixture-secret'),
  )
  assert.throws(() =>
    parseMaterialFindings([{ ...finding, assessment: 'uncertain' }], p, 'fixture-secret'),
  )
  assert.throws(() =>
    parseMaterialFindings([{ ...finding, suggestion: null }], p, 'fixture-secret'),
  )
  assert.throws(() =>
    parseMaterialFindings([{ ...finding, suggestion: 'a'.repeat(301) }], p, 'fixture-secret'),
  )
  assert.throws(() =>
    parseMaterialFindings([{ ...finding, evidence: [{ ...e, file: 'F2' }] }], p, 'fixture-secret'),
  )
})
