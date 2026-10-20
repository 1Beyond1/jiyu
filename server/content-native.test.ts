import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { extractContent } from './content.ts'
import type { CollectedFile } from '../src/types.ts'

function installed(binary: string) { if (process.env.JIYU_REQUIRE_NATIVE_TESTS === '1') return true; try { execFileSync(binary, [binary.includes('pdf') ? '-v' : '--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }); return true } catch { return false } }
const file = (name: string, size: number): CollectedFile => ({ id: 'fixture', name, size, collectionId: 'fixture', owner: 'fixture', createdAt: '', storage: 'local', status: 'pending' })
const pdfBinary = process.env.JIYU_PDFTOTEXT || 'pdftotext', ocrBinary = process.env.JIYU_TESSERACT || 'tesseract'

test('容器原生 Poppler 提取真实 PDF 文字', { skip: !installed(pdfBinary) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jiyu-native-pdf-'))
  try {
    const stream = 'BT /F1 24 Tf 70 700 Td (Jiyu native PDF search) Tj ET'
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
    let source = '%PDF-1.4\n'; const offsets = [0]
    objects.forEach((body, i) => { offsets.push(Buffer.byteLength(source)); source += `${i + 1} 0 obj\n${body}\nendobj\n` })
    const xref = Buffer.byteLength(source)
    source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const path = join(dir, 'text.pdf'); await writeFile(path, source)
    assert.match((await extractContent(file('text.pdf', Buffer.byteLength(source)), path, new AbortController().signal)).text, /Jiyu native PDF search/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('容器原生 Tesseract 从真实 PNG 识别文字', { skip: !installed(ocrBinary) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jiyu-native-ocr-'))
  try {
    const glyphs: Record<string, string[]> = { H: ['10001','10001','10001','11111','10001','10001','10001'], E: ['11111','10000','10000','11110','10000','10000','11111'], L: ['10000','10000','10000','10000','10000','10000','11111'], O: ['01110','10001','10001','10001','10001','10001','01110'] }
    const scale = 10, width = 660, height = 140, pixels = Buffer.alloc((width + 1) * height, 255)
    for (let y = 0; y < height; y++) pixels[y * (width + 1)] = 0
    ;[...'HELLO HELLO'].forEach((letter, index) => { glyphs[letter]?.forEach((row, y) => [...row].forEach((bit, x) => { if (bit === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) pixels[(30 + y * scale + dy) * (width + 1) + 1 + 10 + index * 55 + x * scale + dx] = 0 })) })
    const chunk = (type: string, data: Buffer) => { const kind = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([kind, data]))); return Buffer.concat([size, kind, data, crc]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
    const path = join(dir, 'words.png'); await writeFile(path, png)
    assert.match((await extractContent(file('words.png', png.length), path, new AbortController().signal)).text, /HELLO/i)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
