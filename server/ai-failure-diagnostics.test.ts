import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { failureDiagnostics } from './ai-failure-diagnostics.ts'
test('合成失败诊断默认关闭、精确范围、脱密、private路径和两份上限', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'ai-private-diagnostic-'))
  assert(dir.startsWith(root + sep))
  try {
    const off = failureDiagnostics(undefined, join(dir, 'data'))
    await off('a'.repeat(64), randomUUID(), {}, 'synthetic-secret', Error('x'))
    assert.deepEqual(await readdir(dir), [])
    assert.throws(() =>
      failureDiagnostics(
        { directory: join(dir, 'public'), syntheticInputHash: 'a'.repeat(64) },
        join(dir, 'data'),
      ),
    )
    const capture = failureDiagnostics(
      { directory: join(dir, 'private/diagnostics'), syntheticInputHash: 'a'.repeat(64) },
      join(dir, 'data'),
    )
    const response = {
      choices: [{ finish_reason: 'stop', message: { content: 'synthetic-secret {broken JSON' } }],
    }
    await capture('b'.repeat(64), randomUUID(), response, 'synthetic-secret', Error('x'))
    assert.deepEqual(await readdir(dir), [])
    await Promise.all(
      Array.from({ length: 3 }, () =>
        capture(
          'a'.repeat(64),
          randomUUID(),
          response,
          'synthetic-secret',
          Error('synthetic-secret'),
        ),
      ),
    )
    const names = await readdir(join(dir, 'private/diagnostics'))
    assert.equal(names.length, 2)
    const saved = await readFile(join(dir, 'private/diagnostics', names[0]), 'utf8')
    assert(!saved.includes('synthetic-secret'))
    assert.equal(JSON.parse(saved).finishReason, 'stop')
    assert.equal(JSON.parse(saved).contentSHA256.length, 64)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
