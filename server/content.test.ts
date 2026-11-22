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
  const root = resolve('.artifacts')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'content-test-'))
  const config: Config = {
    dataDir: join(dir, 'data'),
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1',
    port: 3000,
    secureCookie: false,
    quotaBytes: 1024 ** 2,
    requestBytes: 1024 ** 2,
  }
  const { app, store } = await createApp(config, { serveFrontend: false })
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { origin: config.origin },
      payload: {
        setupToken: store.setupToken(),
        displayName: '内容',
        password: 'test-content-password',
      },
    })
    const headers = {
      origin: config.origin,
      cookie: setup.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': setup.json().csrf,
    }
    const task = await app.inject({
      method: 'POST',
      url: '/api/collections',
      headers,
      payload: {
        title: '资料',
        category: 'document',
        description: '',
        formats: 'TXT,PDF,DOCX,SVG',
        deadline: '2099-12-31',
        target: 10,
        maxFileSizeMB: 1,
        maxFilesPerSubmission: 2,
      },
    })
    const add = async (name: string, bytes: Buffer) => {
      const key = randomUUID(),
        file: CollectedFile = {
          id: randomUUID(),
          name,
          size: bytes.length,
          collectionId: task.json().collections[0].id,
          owner: '小屿',
          createdAt: new Date().toISOString(),
          storage: 'local',
          status: 'pending',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }
      await writeFile(join(config.dataDir, 'objects', key), bytes)
      store.addFile(file, key)
      return file
    }
    const file = await add(
      '无关文件名.txt',
      Buffer.from('云端合同，项目代号海边灯塔。\n<script>alert(1)</script>'),
    )
    const start = await app.inject({
      method: 'POST',
      url: '/api/content/index',
      headers,
      payload: { ids: [file.id] },
    })
    assert.equal(start.statusCode, 202)
    for (let n = 0; n < 100; n++) {
      if (
        (await app.inject({ method: 'GET', url: `/api/files/${file.id}/content`, headers })).json()
          .document?.status === 'ready'
      )
        break
      await new Promise((r) => setTimeout(r, 10))
    }
    const content = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}/content`,
      headers,
    })
    assert.equal(content.json().preview, 'text')
    assert.match(content.json().text, /海边灯塔/)
    for (const query of ['海边灯塔', '合同', '<script>', '"']) {
      const result = await app.inject({
        method: 'GET',
        url: `/api/content/search?q=${encodeURIComponent(query)}`,
        headers,
      })
      assert.equal(result.statusCode, query.length < 2 ? 400 : 200, result.body)
      if (query.length >= 2) assert.equal(result.json().matches[0].id, file.id)
    }
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/files/${file.id}/content` })).statusCode,
      401,
    )
    const svg = await add(
      '危险.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    )
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/files/${svg.id}/preview`, headers }))
        .statusCode,
      415,
    )
    const pdfBytes = Buffer.from('%PDF-1.4\n0123456789'),
      pdf = await add('可预览.pdf', pdfBytes)
    const range = await app.inject({
      method: 'GET',
      url: `/api/files/${pdf.id}/preview`,
      headers: { ...headers, range: 'bytes=0-4' },
    })
    assert.equal(range.statusCode, 206)
    assert.equal(range.body, '%PDF-')
    assert.equal(range.headers['content-type'], 'application/pdf')
    assert.equal(range.headers['x-frame-options'], 'SAMEORIGIN')
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/files/${pdf.id}/preview`,
          headers: { ...headers, range: 'bytes=999-1000' },
        })
      ).statusCode,
      416,
    )
    await app.inject({
      method: 'POST',
      url: '/api/files/trash',
      headers,
      payload: { ids: [file.id] },
    })
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/content/search?q=${encodeURIComponent('海边灯塔')}`,
          headers,
        })
      ).json().matches.length,
      0,
    )
    const zip = new ZipFile(),
      path = join(dir, 'sample.docx')
    zip.addBuffer(
      Buffer.from(
        '<w:document><w:p><w:r><w:t>项目 &amp; 集屿</w:t></w:r></w:p><w:p><w:r><w:t>第二段&#x3002;</w:t></w:r></w:p></w:document>',
      ),
      'word/document.xml',
    )
    zip.end()
    await pipeline(zip.outputStream, createWriteStream(path))
    const doc = await extractContent(
      { ...file, name: '文档.docx', size: 100 },
      path,
      new AbortController().signal,
    )
    assert.equal(doc.text.trim(), '项目 & 集屿\n第二段。')

    // 小体积 UTF-8 文本与 DOCX 无需提前后台建索引即可即时轻量预览，并保留 2 MiB 与防 XXE 上限
    const unindexedTxt = await add('即时文本.md', Buffer.from('# 标题\n无需索引即可预览'))
    const txtRes = await app.inject({
      method: 'GET',
      url: `/api/files/${unindexedTxt.id}/content`,
      headers,
    })
    assert.equal(txtRes.statusCode, 200)
    assert.equal(txtRes.json().preview, 'text')
    assert.equal(txtRes.json().instant, true)
    assert.match(txtRes.json().text, /无需索引即可预览/)

    const docxChunks: Buffer[] = []
    const zip2 = new ZipFile()
    zip2.addBuffer(
      Buffer.from('<w:document><w:p><w:r><w:t>即时 DOCX 预览内容</w:t></w:r></w:p></w:document>'),
      'word/document.xml',
    )
    zip2.end()
    for await (const chunk of zip2.outputStream) docxChunks.push(chunk as Buffer)
    const unindexedDocx = await add('即时文档.docx', Buffer.concat(docxChunks))
    const docxRes = await app.inject({
      method: 'GET',
      url: `/api/files/${unindexedDocx.id}/content`,
      headers,
    })
    assert.equal(docxRes.statusCode, 200)
    assert.equal(docxRes.json().preview, 'text')
    assert.equal(docxRes.json().instant, true)
    assert.match(docxRes.json().text, /即时 DOCX 预览内容/)

    // 包含实体声明（XXE）的 DOCX 必须被安全拒绝，不报 500 也不返回正文
    const xxeChunks: Buffer[] = []
    const xxeZip = new ZipFile()
    xxeZip.addBuffer(
      Buffer.from(
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document><w:p><w:t>&xxe;</w:t></w:p></w:document>',
      ),
      'word/document.xml',
    )
    xxeZip.end()
    for await (const chunk of xxeZip.outputStream) xxeChunks.push(chunk as Buffer)
    const xxeDocx = await add('恶意文档.docx', Buffer.concat(xxeChunks))
    const xxeRes = await app.inject({
      method: 'GET',
      url: `/api/files/${xxeDocx.id}/content`,
      headers,
    })
    assert.equal(xxeRes.statusCode, 200)
    assert.equal(xxeRes.json().preview, 'none')
    assert.equal(xxeRes.json().text, undefined)
    assert.match(xxeRes.json().previewError, /实体声明/)
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})
