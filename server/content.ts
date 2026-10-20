import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'node:fs'
import { open, readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as yauzl from 'yauzl'
import type { Store } from './store.ts'
import type { CollectedFile, DocumentInfo, FileContent } from '../src/types.ts'
import { HttpError, object, text } from './security.ts'

const execute = promisify(execFile)
const MAX_TEXT = 64000
export interface Extraction { text: string; kind: string; truncated?: boolean }
export type ContentExtractor = (file: CollectedFile, path: string, signal: AbortSignal) => Promise<Extraction>

export function detectPreview(header: Buffer): { preview: FileContent['preview']; mime?: string } {
  if (header.subarray(0, 5).toString() === '%PDF-') return { preview: 'pdf', mime: 'application/pdf' }
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { preview: 'image', mime: 'image/png' }
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return { preview: 'image', mime: 'image/jpeg' }
  if (['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString())) return { preview: 'image', mime: 'image/gif' }
  if (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP') return { preview: 'image', mime: 'image/webp' }
  return { preview: 'none' }
}
async function header(path: string) { const file = await open(path, 'r'); try { const b = Buffer.alloc(65536); const { bytesRead } = await file.read(b, 0, b.length, 0); return b.subarray(0, bytesRead) } finally { await file.close() } }
function imagePixels(b: Buffer, mime: string) {
  if (mime === 'image/png' && b.length >= 24) return b.readUInt32BE(16) * b.readUInt32BE(20)
  if (mime === 'image/gif' && b.length >= 10) return b.readUInt16LE(6) * b.readUInt16LE(8)
  if (mime === 'image/jpeg') {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i++] !== 0xff) break
      while (b[i] === 0xff) i++
      const marker = b[i++], length = b.readUInt16BE(i)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return b.readUInt16BE(i + 3) * b.readUInt16BE(i + 5)
      if (length < 2) break; i += length
    }
  }
  if (mime === 'image/webp' && b.length >= 30) {
    const kind = b.subarray(12, 16).toString()
    if (kind === 'VP8X') return (b.readUIntLE(24, 3) + 1) * (b.readUIntLE(27, 3) + 1)
    if (kind === 'VP8 ' && b.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) return (b.readUInt16LE(26) & 0x3fff) * (b.readUInt16LE(28) & 0x3fff)
    if (kind === 'VP8L' && b[20] === 0x2f) { const bits = b.readUInt32LE(21); return ((bits & 0x3fff) + 1) * (((bits >>> 14) & 0x3fff) + 1) }
  }
  return 0
}
function decodeXml(value: string) { return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => { const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }; if (entity in named) return named[entity]; const n = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole }) }
async function docxText(path: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new HttpError(422, 'DOCX 容器无效')); return }
      let finished = false, entries = 0
      const done = (error?: Error, value = '') => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); zip.close(); if (error) reject(error); else resolve(value) }
      const abort = () => done(new Error('aborted'))
      signal.addEventListener('abort', abort, { once: true })
      zip.on('error', () => done(new HttpError(422, 'DOCX 内容无法读取')))
      zip.on('end', () => done(new HttpError(422, 'DOCX 缺少文档正文')))
      zip.on('entry', entry => {
        if (++entries > 2000) { done(new HttpError(413, 'DOCX 内部条目过多')); return }
        if (entry.fileName !== 'word/document.xml') { zip.readEntry(); return }
        if (entry.uncompressedSize > 2 * 1024 ** 2 || entry.generalPurposeBitFlag & 1) { done(new HttpError(413, 'DOCX 正文过大或已加密')); return }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { done(new HttpError(422, 'DOCX 无法解压')); return }
          let size = 0; const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 ** 2) { stream.destroy(); done(new HttpError(413, 'DOCX 正文过大')) } else chunks.push(chunk) })
          stream.on('error', () => done(new HttpError(422, 'DOCX 解压失败')))
          stream.on('end', () => { const xml = Buffer.concat(chunks).toString('utf8'); if (/<!DOCTYPE|<!ENTITY/i.test(xml)) { done(new HttpError(422, '不支持包含实体声明的 DOCX')); return }; const paragraphs = xml.split(/<\/w:p>/); done(undefined, paragraphs.map(p => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => decodeXml(m[1])).join('')).join('\n')) })
        })
      })
      if (signal.aborted) abort(); else zip.readEntry()
    })
  })
}

async function command(binary: string, args: string[], signal: AbortSignal) {
  try { const result = await execute(binary, args, { signal, timeout: 90000, maxBuffer: 512 * 1024, encoding: 'utf8', windowsHide: true, env: { ...process.env, OMP_THREAD_LIMIT: '1' } }); return result.stdout }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(503, '缺少本机识别工具。Docker 镜像已包含 Poppler / Tesseract；本机运行请按部署指南安装。'); if (signal.aborted) throw e; throw new HttpError(422, '正文识别未完成，文件可能已加密、损坏、过大或超过处理时限') }
}
export const extractContent: ContentExtractor = async (file, path, signal) => {
  if (file.size > 64 * 1024 ** 2) throw new HttpError(413, '正文识别支持 64 MB 以内的文件')
  const b = await header(path), kind = detectPreview(b)
  if (kind.preview === 'pdf') {
    const result = await command(process.env.JIYU_PDFTOTEXT || 'pdftotext', ['-f', '1', '-l', '50', '-enc', 'UTF-8', '-nopgbrk', path, '-'], signal)
    if (result.trim()) return { text: result, kind: 'PDF 文本（前 50 页）' }
    const tmp = await mkdtemp(join(path, '..', '..', 'tmp', 'ocr-'))
    try {
      // Scanned PDFs are bounded to ten pages, with a hard per-page raster size.
      await command(process.env.JIYU_PDFTOPPM || 'pdftoppm', ['-f', '1', '-l', '10', '-r', '140', '-scale-to', '2500', '-png', path, join(tmp, 'page')], signal)
      const pages = (await readdir(tmp)).filter(name => /^page-\d+\.png$/.test(name)).sort()
      let output = ''
      for (const page of pages) { output += await command(process.env.JIYU_TESSERACT || 'tesseract', [join(tmp, page), 'stdout', '-l', 'chi_sim+eng', '--psm', '3'], signal); if (output.length > MAX_TEXT) break }
      return { text: output, kind: '扫描 PDF · 本机 OCR（前 10 页）' }
    } finally { await rm(tmp, { recursive: true, force: true }) }
  }
  if (kind.preview === 'image') {
    const pixels = imagePixels(b, kind.mime!)
    if (!pixels || pixels > 40 * 1000 ** 2) throw new HttpError(413, 'OCR 支持尺寸明确且不超过 4000 万像素的图片')
    return { text: await command(process.env.JIYU_TESSERACT || 'tesseract', [path, 'stdout', '-l', 'chi_sim+eng', '--psm', '3'], signal), kind: '图片 · 本机 OCR' }
  }
  if (extname(file.name).toLowerCase() === '.docx' && b[0] === 0x50 && b[1] === 0x4b) return { text: await docxText(path, signal), kind: 'DOCX 文本' }
  if (['.txt', '.md', '.csv', '.json', '.log'].includes(extname(file.name).toLowerCase()) && file.size <= 2 * 1024 ** 2 && !b.includes(0)) return { text: (await readFile(path)).toString('utf8'), kind: 'UTF-8 文本' }
  throw new HttpError(415, '暂不支持识别此类型，支持 PDF、DOCX、UTF-8 文本与常见图片')
}

export function contentExcerpt(store: Store, fileId: string, limit: number) { const doc = store.db.prepare("SELECT status FROM documents WHERE file_id=?").get(fileId) as { status: string } | undefined; if (doc?.status !== 'ready') return ''; return String((store.db.prepare('SELECT body FROM content_search WHERE file_id=?').get(fileId) as { body?: string } | undefined)?.body || '').slice(0, limit) }

export function registerContent(app: FastifyInstance, store: Store, extractor: ContentExtractor = extractContent) {
  let running: Promise<void> | undefined, stopping = false
  const controller = new AbortController()
  const selected = (ids: unknown) => { if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new HttpError(400, '请选择 1–50 个文件'); const files = store.files().filter(f => ids.includes(f.id) && !f.deletedAt); if (files.length !== ids.length) throw new HttpError(404, '部分文件已不存在'); return files }
  const work = async () => {
    while (!stopping) {
      const next = store.db.prepare("SELECT file_id FROM documents WHERE status='queued' ORDER BY rowid LIMIT 1").get() as { file_id: string } | undefined
      if (!next) return
      const f = store.files().find(f => f.id === next.file_id && !f.deletedAt), key = store.fileKey(next.file_id)
      if (!f || !key) { store.db.prepare("UPDATE documents SET status='failed',error='文件已移除' WHERE file_id=?").run(next.file_id); continue }
      store.db.prepare("UPDATE documents SET status='processing',error=NULL WHERE file_id=?").run(f.id)
      try {
        const result = await extractor(f, join(store.dataDir, 'objects', key), controller.signal)
        const body = result.text.replace(/[\x00-\x08\x0b\x0e-\x1f]/g, '').slice(0, MAX_TEXT)
        store.transaction(() => {
          store.db.prepare('DELETE FROM content_search WHERE file_id=?').run(f.id)
          store.db.prepare('INSERT INTO content_search(file_id,body) VALUES (?,?)').run(f.id, body)
          store.db.prepare("UPDATE documents SET status='ready',kind=?,chars=?,truncated=?,updated_at=?,error=NULL WHERE file_id=?").run(result.kind, body.length, result.text.length > MAX_TEXT || result.truncated ? 1 : 0, new Date().toISOString(), f.id)
        })
      } catch (error) {
        store.db.prepare('UPDATE documents SET status=?,updated_at=?,error=? WHERE file_id=?').run(stopping ? 'queued' : (error as HttpError).statusCode === 415 ? 'unsupported' : 'failed', new Date().toISOString(), error instanceof HttpError ? error.message : stopping ? null : '文件无法识别，请稍后重试', f.id)
      }
    }
  }
  const tick = () => { if (!running && !stopping) running = work().finally(() => { running = undefined }) }
  const timer = setInterval(tick, 1000); timer.unref()
  app.post('/api/content/index', async (req, reply) => {
    const files = selected(object(req.body).ids)
    store.transaction(() => { for (const f of files) store.db.prepare("INSERT INTO documents(file_id,status) VALUES (?,'queued') ON CONFLICT(file_id) DO UPDATE SET status=CASE WHEN documents.status='processing' THEN 'processing' ELSE 'queued' END,error=NULL").run(f.id); store.activity(`已安排 ${files.length} 个文件的本机正文识别`) })
    tick(); reply.code(202); return { queued: files.length }
  })
  app.get('/api/content/status', async () => ({ documents: store.db.prepare('SELECT * FROM documents').all() }))
  app.get('/api/content/search', async req => {
    const q = text(object(req.query).q, '搜索内容', 100, 2), active = new Set(store.files().filter(f => !f.deletedAt).map(f => f.id))
    const rows = q.length >= 3 ? store.db.prepare('SELECT file_id,body FROM content_search WHERE content_search MATCH ? LIMIT 500').all(`"${q.replaceAll('"', '""')}"`) : store.db.prepare('SELECT file_id,body FROM content_search WHERE instr(lower(body),lower(?))>0 LIMIT 500').all(q)
    return { matches: (rows as { file_id: string; body: string }[]).filter(r => active.has(r.file_id)).map(r => { const i = r.body.toLowerCase().indexOf(q.toLowerCase()); return { id: r.file_id, excerpt: r.body.slice(Math.max(0, i - 35), Math.max(0, i - 35) + 180) } }) }
  })
  const getFile = async (id: string) => {
    const file = store.files().find(f => f.id === id && !f.deletedAt), key = store.fileKey(id)
    if (!file || !key) throw new HttpError(404, '文件不存在或已在回收站')
    const path = join(store.dataDir, 'objects', key), kind = detectPreview(await header(path))
    return { file, path, kind }
  }
  app.get('/api/files/:id/content', async req => {
    const id = String(object(req.params).id), { file, kind } = await getFile(id)
    const document = store.db.prepare('SELECT * FROM documents WHERE file_id=?').get(id) as unknown as DocumentInfo | undefined
    const text = contentExcerpt(store, id, MAX_TEXT)
    return { ...kind, ...(file.size > 32 * 1024 ** 2 ? { preview: 'none' } : {}), ...(text ? { text, ...(kind.preview === 'none' ? { preview: 'text' } : {}) } : {}), document }
  })
  app.get('/api/files/:id/preview', async (req, reply) => {
    const { file, path, kind } = await getFile(String(object(req.params).id))
    if (kind.preview === 'none' || file.size > 32 * 1024 ** 2) throw new HttpError(415, '此文件暂不支持在线预览，请下载查看')
    reply.header('X-Frame-Options', 'SAMEORIGIN').header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; base-uri 'none'")
    reply.type(kind.mime!).header('Content-Disposition', 'inline').header('Accept-Ranges', 'bytes')
    let start = 0, end = file.size - 1
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
      if (!range) { reply.header('Content-Range', `bytes */${file.size}`); return reply.code(416).send() }
      start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) { reply.header('Content-Range', `bytes */${file.size}`); return reply.code(416).send() }
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${file.size}`)
    }
    reply.header('Content-Length', end - start + 1)
    return reply.send(createReadStream(path, { start, end }))
  })
  tick()
  return async () => { stopping = true; clearInterval(timer); controller.abort(); await running }
}
