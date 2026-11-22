import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

test('首次启动仅回环监听时输出初始化口令', async () => {
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'startup-test-'))
  try {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const server = createServer()
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      await new Promise<void>((r) => server.close(() => r()))
      const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
        env: {
          ...process.env,
          JIYU_HOST: host,
          JIYU_PORT: String(port),
          JIYU_DATA_DIR: join(dir, host),
          JIYU_ORIGIN: `http://127.0.0.1:${port}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('服务启动超时')), 10000)
          child.stdout.on('data', (chunk) => {
            output += chunk.toString()
            if (output.includes('首次使用请读取')) {
              clearTimeout(timeout)
              setTimeout(resolve, 30)
            }
          })
          child.once('error', reject)
          child.once('exit', (code) => reject(Error(`启动退出 ${code}`)))
        })
        assert.equal(output.includes('初始化口令：'), host === '127.0.0.1')
      } finally {
        child.kill()
        await new Promise<void>((r) => child.once('exit', () => r()))
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
