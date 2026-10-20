import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { collectionState, defaultCollectionLimits, fileExtensions, isExpired, localDate, submissionError } from './collections.ts'
import type { Collection } from '../types.ts'

const collection: Collection = { id: 'test', title: '测试收集', description: '', category: 'document', received: 0, target: 1, deadline: '2030-01-20', storage: 'local', status: 'active', formats: 'PDF, JPG', ...defaultCollectionLimits }
const now = Date.parse('2030-01-20T12:00:00+08:00')
const file = { name: '资料.PDF', size: 1024 }

test('格式兼容中文分隔、点前缀与大小写，并去重', () => {
  assert.deepEqual(fileExtensions('.PDF，jpg、PDF; ZIP'), ['pdf', 'jpg', 'zip'])
  assert.equal(submissionError(collection, [file], now), '')
  assert.match(submissionError(collection, [{ ...file, name: '资料.exe' }], now), /格式不符合/)
})

test('截止当天最后一毫秒仍可提交，下一毫秒拒绝', () => {
  const end = Date.parse('2030-01-20T23:59:59.999+08:00')
  assert.equal(isExpired(collection, end), false)
  assert.equal(isExpired(collection, end + 1), true)
  assert.equal(submissionError(collection, [file], end), '')
  assert.match(submissionError(collection, [file], end + 1), /超过截止时间/)
  assert.equal(localDate(new Date('2030-01-20T16:00:00Z')), '2030-01-21')
})

test('暂停和结束都阻止提交', () => {
  for (const status of ['paused', 'completed'] as const) {
    assert.match(submissionError({ ...collection, status }, [file], now), /暂停、结束/)
    assert.equal(collectionState({ ...collection, status }), status)
  }
  assert.equal(collectionState({ ...collection, deadline: '2000-01-01' }), 'expired')
})

test('单文件大小边界按 MiB 计算', () => {
  const limited = { ...collection, maxFileSizeMB: 1 }
  assert.equal(submissionError(limited, [{ ...file, size: 1024 * 1024 }], now), '')
  assert.match(submissionError(limited, [{ ...file, size: 1024 * 1024 + 1 }], now), /超过单文件 1 MB/)
})

test('每次提交数量独立于进度目标，空提交不可通过', () => {
  const limited = { ...collection, target: 1, received: 10, maxFilesPerSubmission: 2 }
  assert.equal(submissionError(limited, [file, { ...file, name: '第二份.pdf' }], now), '')
  assert.match(submissionError(limited, [file, file, file], now), /最多提交 2 个文件/)
  assert.match(submissionError(limited, [], now), /请先选择/)
})
