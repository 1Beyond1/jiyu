import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { shareAddress } from './share-address.ts'
import { parseReceiptFile } from './receipt-file.ts'
import { effectiveFileLimit, submissionError } from './collections.ts'
import { collectionParticipants } from './participants.ts'
import type { Collection, CollectedFile } from '../types.ts'

test('分享提示区分本机、局域网、HTTP 与仍需外部实测的 HTTPS', () => {
  for (const address of ['http://localhost:3000', 'http://127.0.0.1', 'http://[::1]', 'https://test.localhost']) assert.equal(shareAddress(address).kind, 'local')
  for (const address of ['http://192.168.1.2', 'http://10.1.2.3', 'https://172.31.1.2', 'http://[fd00::1]']) assert.equal(shareAddress(address).kind, 'lan')
  assert.equal(shareAddress('http://files.example.com').kind, 'http')
  assert.equal(shareAddress('https://files.example.com').kind, 'external')
  assert.equal(shareAddress('https://172.32.1.2').kind, 'external')
})

test('旧版文本回执可导入，错误收集、外部地址及伪造字段不得发送凭证', () => {
  const id = '12345678-1234-1234-1234-123456789abc', key = 'x'.repeat(64)
  const text = `\uFEFF集屿 · 作业\r\n收集链接：http://localhost:3000/#/submit/task\r\n回执编号：${id}\r\n私密凭证：${key}\r\n`
  assert.deepEqual(parseReceiptFile(text, 'http://localhost:3000', 'task'), { receiptId: id, key })
  for (const bad of [text.replace('/task', '/other'), text.replace('http://localhost:3000', 'https://elsewhere.example'), text + `私密凭证：${key}`, text.replace(id, 'invalid'), text.repeat(200)]) assert.throws(() => parseReceiptFile(bad, 'http://localhost:3000', 'task'))
})

test('有效单文件上限与表单校验一致，旧后端规则不被默认值缩小', () => {
  const c: Collection = { id: 'c', title: '收集', description: '', category: 'document', received: 0, target: 2, deadline: '2099-01-01', storage: 'local', status: 'active', formats: 'TXT', maxFileSizeMB: 1024, maxFilesPerSubmission: 2 }
  assert.equal(effectiveFileLimit(c), 1024)
  assert.equal(effectiveFileLimit({ ...c, requestLimitMB: 32 }), 32)
  assert.equal(effectiveFileLimit({ ...c, requestLimitMB: 2048 }), 1024)
  assert.match(submissionError({ ...c, requestLimitMB: 32 }, [{ name: 'a.txt', size: 33 * 1024 ** 2 }]), /单文件 32 MB/)
  const f: CollectedFile = { id: 'f', collectionId: 'c', owner: '张同学', participant: 'a01', name: 'a.txt', size: 3, storage: 'local', status: 'pending', createdAt: '2026-10-24', sha256: 'hash' }
  const rows = collectionParticipants({ ...c, expectedSubmitters: ['Ａ01', 'A02'] }, [f, { ...f, id: 'g', deletedAt: '2026-10-24' }, { ...f, id: 'other', collectionId: 'elsewhere' }])
  assert.equal(rows.length, 2); assert.equal(rows[0].fileIds.length, 1); assert.equal(rows[1].fileIds.length, 0)
})
