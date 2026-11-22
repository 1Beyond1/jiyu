import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { ZipFile } from 'yazl'
import { createApp } from './app.ts'
import { decodeXml, extractContent, extractDocxXmlText } from './content.ts'
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

    // 对抗性测试：高膨胀比 ZIP 炸弹（解压 1 MiB、压缩约 1 KiB，膨胀比 > 100x）必须被 413 拒绝
    const bombChunks: Buffer[] = []
    const bombZip = new ZipFile()
    bombZip.addBuffer(
      Buffer.from(`<w:document><w:p><w:t>${'A'.repeat(1024 * 1024)}</w:t></w:p></w:document>`),
      'word/document.xml',
    )
    bombZip.end()
    for await (const chunk of bombZip.outputStream) bombChunks.push(chunk as Buffer)
    const bombBytes = Buffer.concat(bombChunks)
    assert.ok(bombBytes.length < 10 * 1024, 'ZIP 炸弹压缩包应很小')
    const bombPath = join(dir, 'bomb.docx')
    await writeFile(bombPath, bombBytes)
    await assert.rejects(
      () =>
        extractContent(
          { ...file, name: '炸弹.docx', size: bombBytes.length },
          bombPath,
          new AbortController().signal,
        ),
      (err: unknown) =>
        (err as { statusCode?: number; message?: string })?.statusCode === 413 &&
        /膨胀比/.test((err as { message?: string })?.message || ''),
    )
    const bombDocx = await add('炸弹.docx', bombBytes)
    const bombRes = await app.inject({
      method: 'GET',
      url: `/api/files/${bombDocx.id}/content`,
      headers,
    })
    assert.equal(bombRes.statusCode, 200)
    assert.equal(bombRes.json().preview, 'none')
    assert.equal(bombRes.json().text, undefined)
    assert.match(bombRes.json().previewError, /膨胀比/)

    // 对抗性测试：45,000 个未闭合 <w:t> 的恶意 DOCX（~225 KiB，未触发 256 KiB 膨胀比门限）必须在 100ms 内线性完成
    const redosXml = `<w:document><w:p>${'<w:t>'.repeat(45_000)}<w:t>合法尾段</w:t></w:p></w:document>`
    const redosChunks: Buffer[] = []
    const redosZip = new ZipFile()
    redosZip.addBuffer(Buffer.from(redosXml), 'word/document.xml')
    redosZip.end()
    for await (const chunk of redosZip.outputStream) redosChunks.push(chunk as Buffer)
    const redosBytes = Buffer.concat(redosChunks)
    const redosPath = join(dir, 'redos.docx')
    await writeFile(redosPath, redosBytes)
    const t0 = performance.now()
    const redosExtracted = await extractContent(
      { ...file, name: '恶意回溯.docx', size: redosBytes.length },
      redosPath,
      new AbortController().signal,
    )
    const elapsedMs = performance.now() - t0
    assert.ok(
      elapsedMs < 100,
      `45,000 未闭合 <w:t> 解析应为线性时间 (<100ms)，实际耗时 ${elapsedMs.toFixed(2)}ms`,
    )
    assert.equal(redosExtracted.text.trim(), '合法尾段')

    const redosDocx = await add('恶意回溯.docx', redosBytes)
    const tApi0 = performance.now()
    const redosApiRes = await app.inject({
      method: 'GET',
      url: `/api/files/${redosDocx.id}/content`,
      headers,
    })
    const apiElapsedMs = performance.now() - tApi0
    assert.equal(redosApiRes.statusCode, 200)
    assert.equal(redosApiRes.json().text.trim(), '合法尾段')
    assert.ok(apiElapsedMs < 100, `即时预览解析耗时应 <100ms，实际 ${apiElapsedMs.toFixed(2)}ms`)

    // 即时预览端点并发护栏：同时发起 12 个请求触发 429，结束后名额立即释放
    const burst = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({
          method: 'GET',
          url: `/api/files/${unindexedDocx.id}/content`,
          headers,
        }),
      ),
    )
    assert.ok(
      burst.some((r) => r.statusCode === 200),
      '并发预览中应有正常放行的请求',
    )
    assert.ok(
      burst.some((r) => r.statusCode === 429),
      '超出并发上限的即时预览请求应返回 429',
    )
    const afterBurst = await app.inject({
      method: 'GET',
      url: `/api/files/${unindexedDocx.id}/content`,
      headers,
    })
    assert.equal(afterBurst.statusCode, 200)
  } finally {
    await app.close()
    if (!relative(root, dir).startsWith('..')) await rm(dir, { recursive: true, force: true })
  }
})

test('DOCX XML 线性解析：大小写实体解码、表格/制表符/换行防粘连与 20 万未闭合标签线性耗时', () => {
  assert.equal(
    decodeXml('&AMP;&LT;&GT;&QUOT;&APOS;&#X3002;&#x4E2D;&#65;&#xD800;'),
    '&<>"\'。中A&#xD800;',
  )
  const tableXml =
    '<w:document><w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>成绩</w:t></w:r></w:p></w:tc>' +
    '</w:tr><w:tr>' +
    '<w:tc><w:p><w:r><w:t>小屿</w:t><w:tab/><w:t>一班</w:t><w:br/><w:t>备注&AMP;说明&#X3002;</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>98</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl><!-- <w:t>注释内不应提取</w:t> --></w:document>'
  assert.equal(extractDocxXmlText(tableXml).trim(), '姓名\t成绩\n小屿\t一班\n备注&说明。\t98')

  const hugeUnclosed = `<w:document><w:p>${'<w:t>'.repeat(200_000)}<w:t>尾部</w:t></w:p></w:document>`
  const t0 = performance.now()
  const out = extractDocxXmlText(hugeUnclosed)
  const elapsed = performance.now() - t0
  assert.equal(out.trim(), '尾部')
  assert.ok(elapsed < 100, `20 万未闭合 <w:t> 解析耗时应 <100ms，实际 ${elapsed.toFixed(2)}ms`)
})
