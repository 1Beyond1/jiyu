import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID, createHash } from 'node:crypto'
import { uploadFiles, recoverUploadReceipt } from './api.ts'
import type { UploadFeedback, UploadReceipt } from '../types.ts'

function environment(t: TestContext) {
  const values = new Map<string, string>(), original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => values.get(k) || null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage') })
  const parts = new Map<string, { file_index: number; part_index: number; sha256: string; size: number }>(), puts = new Map<string, number>()
  const files = [new File(['abcdef'], '一.txt', { lastModified: 1 }), new File(['1234'], '二.txt', { lastModified: 2 })]
  let receipt: UploadReceipt | undefined, fail = '', abort: AbortController | undefined, completions = 0, deletes = 0
  const feedback: UploadFeedback[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), headers = new Headers(init?.headers)
    if (!init?.method || init.method === 'GET') return Response.json(receipt ? { receipt } : { chunkBytes: 3, parts: [...parts.values()] })
    if (init?.method === 'DELETE') { deletes++; return Response.json({ ok: true }) }
    if (path.endsWith('/complete')) {
      completions++; receipt ||= { receiptId: randomUUID(), filesCount: files.length, bytes: 10, createdAt: new Date().toISOString() }
      if (fail === 'receipt') return Response.json({ error: '保存结果响应中断' }, { status: 500 })
      if (fail === 'invalid-receipt') return Response.json({ ok: true })
      return Response.json(receipt)
    }
    if (init?.method === 'POST') return Response.json(receipt ? { receipt } : { chunkBytes: 3, parts: [...parts.values()] })
    const match = path.match(/\/(\d+)\/(\d+)$/)!, key = `${match[1]}/${match[2]}`
    if (fail === 'transient' && key === '1/0') { fail = ''; return Response.json({ error: '暂时繁忙' }, { status: 503 }) }
    if (abort && key === '1/0') { abort.abort(); throw new Error('aborted') }
    if (fail === key) return Response.json({ error: '此分片未通过校验，请重试' }, { status: 409 })
    const bytes = Buffer.from(await (init!.body as Blob).arrayBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex'); assert.equal(headers.get('X-Chunk-SHA256'), sha256)
    puts.set(key, (puts.get(key) || 0) + 1); parts.set(key, { file_index: Number(match[1]), part_index: Number(match[2]), sha256, size: bytes.length })
    return Response.json({ sha256 })
  }
  t.mock.method(globalThis, 'fetch', fetch as typeof globalThis.fetch)
  const run = (signal = new AbortController().signal, metadata = {}) => uploadFiles('fixture', files, '测试者', randomUUID(), () => {}, signal, metadata, f => feedback.push(f))
  return { values, files, puts, feedback, run, setFail: (v: string) => { fail = v }, setAbort: (v: AbortController) => { abort = v }, completions: () => completions, deletes: () => deletes }
}

test('逐文件失败位置准确，重试只补未确认分片，收到整批回执才报告成功', async t => {
  const e = environment(t); e.setFail('1/0')
  await assert.rejects(e.run(), /此分片未通过/)
  assert.equal(e.feedback.at(-1)!.files[0].state, 'uploaded'); assert.equal(e.feedback.at(-1)!.files[1].state, 'failed')
  assert.equal(e.feedback.some(f => f.phase === 'received'), false)
  e.setFail(''); const receipt = await e.run()
  assert.equal(receipt.filesCount, 2); assert.equal(e.feedback.at(-1)!.phase, 'received'); assert.equal(e.completions(), 1)
  assert.equal(e.puts.get('0/0'), 1); assert.equal(e.puts.get('0/1'), 1); assert.equal(e.deletes(), 0)
})

test('保存响应失败保留续传凭证，再次确认回执不会重复传输或提交', async t => {
  const e = environment(t); e.setFail('receipt')
  await assert.rejects(e.run(), /保存结果/)
  assert.ok(e.values.has('jiyu:upload:fixture')); assert.equal(e.feedback.at(-1)!.phase, 'failed')
  assert.ok(e.feedback.at(-1)!.files.every(f => f.state === 'uploaded'))
  e.setFail(''); await e.run()
  assert.equal(e.completions(), 1); assert.equal([...e.puts.values()].reduce((a, b) => a + b, 0), 4)
  assert.equal(e.values.has('jiyu:upload:fixture'), false); assert.ok(e.values.has('jiyu:receipt:fixture'))
})

test('暂停保留已上传文件状态，旧版不含字段的续传签名仍可继续', async t => {
  const e = environment(t), controller = new AbortController()
  e.values.set('jiyu:upload:fixture', JSON.stringify({ id: randomUUID(), key: 'x'.repeat(64), savedAt: Date.now(), signature: JSON.stringify({ owner: '测试者', files: e.files.map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified })) }) }))
  e.setAbort(controller)
  await assert.rejects(e.run(controller.signal, { fields: {} }), /上传已暂停/)
  assert.equal(e.deletes(), 0); assert.equal(e.feedback.at(-1)!.files[0].state, 'uploaded'); assert.equal(e.feedback.at(-1)!.files[1].state, 'paused')
})

test('无效回执不能将文件标记为已收到', async t => {
  const e = environment(t); e.setFail('invalid-receipt')
  await assert.rejects(e.run(), /有效提交回执/)
  assert.equal(e.feedback.some(f => f.phase === 'received'), false); assert.ok(e.values.has('jiyu:upload:fixture'))
})

test('临时失败显示自动重试，恢复后继续并取得回执', async t => {
  const e = environment(t); e.setFail('transient'); await e.run()
  assert.ok(e.feedback.some(f => f.files[1].state === 'retrying' && f.files[1].message?.includes('自动重试')))
  assert.equal(e.feedback.at(-1)!.phase, 'received'); assert.equal(e.puts.get('0/0'), 1)
})

test('不重选文件也能确认已保存回执，未完成批次不能假报成功', async t => {
  const e = environment(t); e.setFail('1/0'); await assert.rejects(e.run())
  assert.equal(await recoverUploadReceipt('fixture'), null)
  e.setFail('receipt'); await assert.rejects(e.run())
  const puts = [...e.puts.values()].reduce((a, b) => a + b, 0)
  const r = await recoverUploadReceipt('fixture')
  assert.equal(r!.filesCount, 2); assert.equal(e.completions(), 1); assert.equal([...e.puts.values()].reduce((a, b) => a + b, 0), puts)
  assert.equal(e.values.has('jiyu:upload:fixture'), false)
})
