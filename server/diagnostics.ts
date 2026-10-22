import { execFile } from 'node:child_process'
import { writeFile, readFile, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { Config } from './config.ts'
import type { Store } from './store.ts'
import type { DiagnosticItem, Diagnostics } from '../src/types.ts'
import { storageSpace } from './storage-space.ts'

const tool = (name: string, args: string[]) => new Promise<boolean>(resolve => execFile(name, args, { timeout: 3000, maxBuffer: 65536, windowsHide: true }, error => resolve(!error)))
export async function diagnostics(store: Store, config: Config, uploadingBytes = 0): Promise<Diagnostics> {
  const items: DiagnosticItem[] = [], probe = join(config.dataDir, 'tmp', randomUUID())
  try { await writeFile(probe, 'jiyu-check', { flag: 'wx', mode: 0o600, flush: true }); if (await readFile(probe, 'utf8') !== 'jiyu-check') throw new Error(); items.push({ id: 'data', label: '文件读写', state: 'ok', detail: '数据目录实际写入与读回校验成功。' }) } catch { items.push({ id: 'data', label: '文件读写', state: 'attention', detail: '数据目录写入或读回失败。', action: '检查持久卷权限、磁盘空间及运行用户。' }) } finally { await rm(probe, { force: true }).catch(() => {}) }
  const integrity = Object.values(store.db.prepare('PRAGMA quick_check').get() || {})[0] === 'ok'
  items.push({ id: 'database', label: '数据库', state: integrity ? 'ok' : 'attention', detail: integrity ? 'SQLite 快速完整性检查通过。' : '数据库检查异常，请停止写入并检查备份。' })
  const space = await storageSpace(config.dataDir, store.usedBytes(), config.quotaBytes, store.pendingBytes() + uploadingBytes)
  items.push({ id: 'space', label: '接收容量', state: space.receiveRemainingBytes !== null && space.receiveRemainingBytes > 100 * 1024 ** 2 ? 'ok' : 'attention', detail: space.receiveRemainingBytes === null ? '无法读取磁盘剩余。' : `当前最多可再接收 ${Math.floor(space.receiveRemainingBytes / 1024 ** 2)} MB（取磁盘与工作台配额的较小值）。`, action: '容量不足时先备份，再清理回收站或调整部署配额。' })
  items.push({ id: 'origin', label: '访问地址与 HTTPS', state: config.origin.startsWith('https:') ? 'ok' : 'attention', detail: `当前地址：${config.origin}`, action: config.origin.startsWith('https:') ? undefined : '本机调试可使用 HTTP；VPS 对外使用前请配置域名、Caddy HTTPS 与 JIYU_ORIGIN。' })
  let backupWritable = false
  const backupDir = config.backupDir || resolve(config.dataDir, '..', 'backups')
  try { await access(backupDir, constants.W_OK); backupWritable = true } catch { /* The first backup may create the destination. */ }
  const settings = JSON.parse(store.get('backup.settings') || '{"enabled":false}') as { enabled?: boolean }
  items.push({ id: 'backup', label: '自动备份', state: backupWritable && !!settings.enabled ? 'ok' : 'attention', detail: !backupWritable ? '备份目录尚未创建或不可写；未配置路径时使用数据目录旁的 backups。' : settings.enabled ? '备份目录可写，计划已开启；仍请定期验证恢复。' : '目录可写，自动备份尚未开启。', action: '在备份设置中开启计划并完成一次备份；副本建议再保存到另一台设备。' })
  const [pdf, ocr] = await Promise.all([tool('pdftotext', ['-v']), tool('tesseract', ['--version'])])
  items.push({ id: 'pdf', label: 'PDF 文字提取', state: pdf ? 'ok' : 'attention', detail: pdf ? 'Poppler 命令可运行。' : '没有可运行的 pdftotext。', action: pdf ? undefined : '使用官方 Docker 镜像，或安装 Poppler；不影响普通文件收集。' })
  items.push({ id: 'ocr', label: '图片 OCR', state: ocr ? 'ok' : 'attention', detail: ocr ? 'Tesseract 命令可运行；识别语言仍取决于已安装语言包。' : '没有可运行的 Tesseract。', action: ocr ? undefined : '使用官方 Docker 镜像，或安装 Tesseract 与中文语言包。' })
  return { checkedAt: new Date().toISOString(), items }
}
