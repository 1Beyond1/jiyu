import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = resolve(root, process.argv[2] || '.artifacts/submission-ready-20261025/package')
if (!output.startsWith(join(root, '.artifacts') + sep)) throw new Error('输出须位于本仓库 .artifacts 内。')
await mkdir(output, { recursive: true })
const zipPath = join(output, 'jiyu-0.4.0-dev-submission.zip')
try { await lstat(zipPath); throw new Error('ZIP 已存在；请另选输出目录以保留已有成果。') } catch (error) { if (error.code !== 'ENOENT') throw error }
const selected = []
async function select(path) {
  const full = join(root, path), info = await lstat(full)
  if (info.isSymbolicLink()) throw new Error(`拒绝符号链接：${path}`)
  if (!(await realpath(full)).startsWith(root + sep)) throw new Error('选中文件超出仓库')
  if (info.isDirectory()) {
    for (const name of (await readdir(full)).sort()) await select(join(path, name))
  } else {
    if (/(^|[\\/])(node_modules|data|uploads|backups|\.git|\.env|\.artifacts)([\\/]|$)|\.(sqlite|db|key|pem|log)$/i.test(path)) throw new Error(`拒绝运行数据：${path}`)
    selected.push(path)
  }
}
for (const name of ['src', 'server', 'public', 'dist', 'examples/submission', 'docs/submission']) await select(name)
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'LICENSE', 'scripts/review-start.mjs']) await select(name)
const allowed = /\.(ts|tsx|css|svg|js|json|html|md|txt|mjs)$/i
const entries = []
const zip = new ZipFile()
for (const name of selected.sort()) {
  if (!allowed.test(name) && name !== 'LICENSE') throw new Error(`未审查的文件类型：${name}`)
  const bytes = await readFile(join(root, name)), path = name.split(sep).join('/')
  entries.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  zip.addBuffer(bytes, `jiyu/${path}`, { mtime: new Date('2026-10-25T00:00:00Z'), mode: 0o100644 })
}
const manifest = { packageVersion: '0.4.0-dev.0', license: 'MIT', source: 'current working tree; includes uncommitted approved work', scope: 'local loopback source and prebuilt frontend; no runtime database or credentials', firstInstallNeedsNetwork: true, modelConfigured: false, payloadInventoryExcludes: ['PACKAGE_MANIFEST.json itself'], files: entries }
zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'jiyu/PACKAGE_MANIFEST.json')
zip.end()
await pipeline(zip.outputStream, createWriteStream(zipPath, { flags: 'wx' }))
const bytes = await readFile(zipPath)
const result = { zip: relative(root, zipPath).split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), payloadFiles: entries.length, firstInstallNeedsNetwork: true, containsRuntimeData: false }
await writeFile(join(output, 'PACKAGE_RESULT.json'), JSON.stringify(result, null, 2))
await writeFile(join(output, 'PACKAGE_MANIFEST.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(result, null, 2))
