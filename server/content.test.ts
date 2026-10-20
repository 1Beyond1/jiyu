import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { ZipFile } from 'yazl'
import { createApp } from './app.ts'
import { extractContent } from './content.ts'
import type { Config } from './config.ts'
import type { CollectedFile } from '../src/types.ts'

test('本机正文索引、中文检索、DOCX 解包、范围预览与权限边界', async () => {
  const root = resolve('.artifacts'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'content-test-'))
  const config: Config = { dataDir: join(dir, 'data'), origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, secureCookie: false, quotaBytes: 1024 ** 2, requestBytes: 1024 ** 2 }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: config.origin }, payload: { setupToken: store.setupToken(), displayName: '内容', password: 'test-content-password' } })
    const headers = { origin: config.origin, cookie: setup.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': setup.json().csrf }
    const task = await app.inject({ method: 'POST', url: '/api/collections', headers, payload: { title: '资料', category: 'document', description: '', formats: 'TXT,PDF,DOCX,SVG', deadline: '2099-12-31', target: 10, maxFileSizeMB: 1, maxFilesPerSubmission: 2 } })
    const add = async (name: string, bytes: Buffer) => { const key = randomUUID(), file: CollectedFile = { id: randomUUID(), name, size: bytes.length, collectionId: task.json().collections[0].id, owner: '小屿', createdAt: new Date().toISOString(), storage: 'local', status: 'pending', sha256: createHash('sha256').update(bytes).digest('hex') }; await writeFile(join(config.dataDir, 'objects', key), bytes); store.addFile(file, key); return file }
    const file = await add('无关文件名.txt', Buffer.from('云端合同，项目代号海边灯塔。\n<script>alert(1)</script>'))
    const start = await app.inject({ method: 'POST', url: '/api/content/index', headers, payload: { ids: [file.id] } }); assert.equal(start.statusCode, 202)
    for (let n = 0; n < 100; n++) { if ((await app.inject({ method: 'GET', url: `/api/files/${file.id}/content`, headers })).json().document?.status === 'ready') break; await new Promise(r => setTimeout(r, 10)) }
    const content = await app.inject({ method: 'GET', url: `/api/files/${file.id}/content`, headers })
    assert.equal(content.json().preview, 'text'); assert.match(content.json().text, /海边灯塔/)
    for (const query of ['海边灯塔', '合同', '<script>', '"']) {
      const result = await app.inject({ method: 'GET', url: `/api/content/search?q=${encodeURIComponent(query)}`, headers })
      assert.equal(result.statusCode, query.length < 2 ? 400 : 200, result.body)
      if (query.length >= 2) assert.equal(result.json().matches[0].id, file.id)
    }
    assert.equal((await app.inject({ method: 'GET', url: `/api/files/${file.id}/content` })).statusCode, 401)
    const svg = await add('危险.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
    assert.equal((await app.inject({ method: 'GET', url: `/api/files/${svg.id}/preview`, headers })).statusCode, 415)
    const pdfBytes = Buffer.from('%PDF-1.4\n0123456789'), pdf = await add('可预览.pdf', pdfBytes)
    const range = await app.inject({ method: 'GET', url: `/api/files/${pdf.id}/preview`, headers: { ...headers, range: 'bytes=0-4' } })
    assert.equal(range.statusCode, 206); assert.equal(range.body, '%PDF-'); assert.equal(range.headers['content-type'], 'application/pdf')
    assert.equal(range.headers['x-frame-options'], 'SAMEORIGIN')
    assert.equal((await app.inject({ method: 'GET', url: `/api/files/${pdf.id}/preview`, headers: { ...headers, range: 'bytes=999-1000' } })).statusCode, 416)
    await app.inject({ method: 'POST', url: '/api/files/trash', headers, payload: { ids: [file.id] } })
    assert.equal((await app.inject({ method: 'GET', url: `/api/content/search?q=${encodeURIComponent('海边灯塔')}`, headers })).json().matches.length, 0)
    const zip = new ZipFile(), path = join(dir, 'sample.docx'); zip.addBuffer(Buffer.from('<w:document><w:p><w:r><w:t>项目 &amp; 集屿</w:t></w:r></w:p><w:p><w:r><w:t>第二段&#x3002;</w:t></w:r></w:p></w:document>'), 'word/document.xml'); zip.end(); await pipeline(zip.outputStream, createWriteStream(path))
    const doc = await extractContent({ ...file, name: '文档.docx', size: 100 }, path, new AbortController().signal)
    assert.equal(doc.text.trim(), '项目 & 集屿\n第二段。')
  } finally { await app.close(); if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true }) }
})
