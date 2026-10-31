import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const [major, minor] = process.versions.node.split('.').map(Number)
if (major !== 24 || minor < 11) throw new Error('请安装 Node.js 24.11 或更新的 24.x 版本。')
const port = Number(process.argv[2] || 3014)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口须为 1024–65535 的整数。')
if (!existsSync(join(root, 'node_modules/fastify'))) throw new Error('请先在解包目录运行 npm ci --omit=dev（首次需要联网）。')
if (!existsSync(join(root, 'dist/index.html'))) throw new Error('缺少包内 dist/index.html，请核对 ZIP 完整性。')
const dataDir = join(root, '.review-data')
console.log(`本机独立体验：http://127.0.0.1:${port}/`)
console.log(`数据仅在本包目录：${dataDir}`)
console.log('首次使用读取 .review-data/setup-token，在网页自行设置管理员；没有内置密码或模型 Key。')
console.log('按 Ctrl+C 停止。端口占用时停止本次启动；可指定其他空闲端口，不会终止已有服务。')
const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, JIYU_HOST: '127.0.0.1', JIYU_PORT: String(port), JIYU_ORIGIN: `http://127.0.0.1:${port}`, JIYU_DATA_DIR: dataDir, JIYU_BACKUP_DIR: join(root, '.review-backups'), JIYU_QUOTA_MB: '64', JIYU_REQUEST_MB: '32', JIYU_TRUST_PROXY: 'false' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal) })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
