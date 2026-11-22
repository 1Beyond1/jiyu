import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  encodeQrMatrix,
  qrSvgDataUrl,
  renderQrSvg,
  renderShareCardSvg,
  type QrEcLevel,
} from './qrcode.ts'

const EC_BITS_TO_LEVEL: Record<number, QrEcLevel> = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }
const EC_CODEWORDS: Record<QrEcLevel, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24],
}
const NUM_BLOCKS: Record<QrEcLevel, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18],
}
const ALIGN: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
]

function gfMul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1d
    b >>>= 1
  }
  return p
}

function gfPow(base: number, exp: number): number {
  let r = 1
  for (let i = 0; i < exp; i++) r = gfMul(r, base)
  return r
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0
    case 1:
      return r % 2 === 0
    case 2:
      return c % 3 === 0
    case 3:
      return (r + c) % 3 === 0
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }
}

// Independent ISO/IEC 18004 verifier + decoder: verifies format/version BCH, RS syndromes, and payload.
function verifyAndDecode(modules: boolean[][]): string {
  const size = modules.length
  const version = (size - 17) / 4
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 15)

  // Verify timing patterns & dark module
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at ${i}`)
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing at ${i}`)
  }
  assert.equal(modules[size - 8][8], true, 'dark module')

  // Verify format info copies match ISO/IEC 18004 Figure 25 and pass BCH(15, 5)
  let fmt1 = 0
  for (let i = 0; i <= 5; i++) fmt1 |= (modules[i][8] ? 1 : 0) << i
  fmt1 |= (modules[7][8] ? 1 : 0) << 6
  fmt1 |= (modules[8][8] ? 1 : 0) << 7
  fmt1 |= (modules[8][7] ? 1 : 0) << 8
  for (let i = 9; i < 15; i++) fmt1 |= (modules[8][14 - i] ? 1 : 0) << i

  let fmt2 = 0
  for (let i = 0; i < 8; i++) fmt2 |= (modules[8][size - 1 - i] ? 1 : 0) << i
  for (let i = 8; i < 15; i++) fmt2 |= (modules[size - 15 + i][8] ? 1 : 0) << i
  assert.equal(fmt1, fmt2, 'both format info copies must be identical')

  const unmaskedFmt = fmt1 ^ 0x5412
  let bchCheck = unmaskedFmt
  for (let i = 14; i >= 10; i--) {
    if (bchCheck & (1 << i)) bchCheck ^= 0x537 << (i - 10)
  }
  assert.equal(bchCheck, 0, 'format info BCH remainder must be 0')
  const ecLevel = EC_BITS_TO_LEVEL[(unmaskedFmt >>> 13) & 3]
  const mask = (unmaskedFmt >>> 10) & 7

  // Verify version info for V7+
  if (version >= 7) {
    let v1 = 0
    let v2 = 0
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      v1 |= (modules[a][b] ? 1 : 0) << i
      v2 |= (modules[b][a] ? 1 : 0) << i
    }
    assert.equal(v1, v2, 'both version info blocks must match')
    assert.equal(v1 >>> 12, version, 'version bits match version')
    let vbch = v1
    for (let i = 17; i >= 12; i--) {
      if (vbch & (1 << i)) vbch ^= 0x1f25 << (i - 12)
    }
    assert.equal(vbch, 0, 'version info BCH remainder must be 0')
  }

  // Mark function modules
  const isFunc = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) isFunc[r][c] = true
  for (let r = 0; r < 9; r++) for (let c = size - 8; c < size; c++) isFunc[r][c] = true
  for (let r = size - 8; r < size; r++) for (let c = 0; c < 9; c++) isFunc[r][c] = true
  for (let i = 0; i < size; i++) {
    isFunc[6][i] = true
    isFunc[i][6] = true
  }
  const align = ALIGN[version]
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0)
      )
        continue
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) isFunc[align[i] + dr][align[j] + dc] = true
    }
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        isFunc[i][size - 11 + j] = true
        isFunc[size - 11 + j][i] = true
      }
  }

  // Read unmasked bits in zigzag order
  const rawBits: number[] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const row = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (!isFunc[row][col]) {
          const bit = modules[row][col] !== maskBit(mask, row, col) ? 1 : 0
          rawBits.push(bit)
        }
      }
    }
  }

  const totalCodewords = Math.floor(rawBits.length / 8)
  const codewords = new Uint8Array(totalCodewords)
  for (let i = 0; i < totalCodewords; i++) {
    let byte = 0
    for (let b = 0; b < 8; b++) byte = (byte << 1) | rawBits[i * 8 + b]
    codewords[i] = byte
  }

  // De-interleave blocks & verify Reed-Solomon syndromes === 0 for every block
  const numBlocks = NUM_BLOCKS[ecLevel][version]
  const ecLen = EC_CODEWORDS[ecLevel][version]
  const numShort = numBlocks - (totalCodewords % numBlocks)
  const shortLen = Math.floor(totalCodewords / numBlocks)
  const dataBlocks: number[][] = Array.from({ length: numBlocks }, () => [])
  const ecBlocks: number[][] = Array.from({ length: numBlocks }, () => [])

  let idx = 0
  const maxDataLen = shortLen - ecLen + (numShort < numBlocks ? 1 : 0)
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      const len = shortLen - ecLen + (b < numShort ? 0 : 1)
      if (i < len) dataBlocks[b].push(codewords[idx++])
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < numBlocks; b++) ecBlocks[b].push(codewords[idx++])
  }

  // Check RS syndrome: evaluate polynomial at alpha^0 .. alpha^(ecLen-1)
  for (let b = 0; b < numBlocks; b++) {
    const full = [...dataBlocks[b], ...ecBlocks[b]]
    for (let s = 0; s < ecLen; s++) {
      const root = gfPow(2, s)
      let acc = 0
      for (const coef of full) acc = gfMul(acc, root) ^ coef
      assert.equal(acc, 0, `RS syndrome failed at block ${b}, root ${s}`)
    }
  }

  // Decode Byte-mode payload
  const dataStream = dataBlocks.flat()
  const bits: number[] = []
  for (const byte of dataStream) {
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1)
  }
  const readBits = (offset: number, len: number) => {
    let val = 0
    for (let i = 0; i < len; i++) val = (val << 1) | bits[offset + i]
    return val
  }
  assert.equal(readBits(0, 4), 0b0100, 'must be byte mode')
  const countLen = version <= 9 ? 8 : 16
  const byteCount = readBits(4, countLen)
  const decoded = new Uint8Array(byteCount)
  let pos = 4 + countLen
  for (let i = 0; i < byteCount; i++) {
    decoded[i] = readBits(pos, 8)
    pos += 8
  }
  return new TextDecoder().decode(decoded)
}

test('纯本地 QR 编码器覆盖多版本与中文/长 URL，格式校验、RS 纠错码与解码回环 100% 一致', () => {
  const samples = [
    'http://127.0.0.1:3000/#/submit/abc123',
    'https://files.example.com/#/submit/V1StGXR8_Z5jdHi6B-myT_abcdefghijklmnopqrstuvwxyz',
    `https://jiyu.example.org:8443/#/submit/token-中文-${'x'.repeat(120)}`,
  ]
  for (const url of samples) {
    for (const ecLevel of ['L', 'M', 'Q', 'H'] as const) {
      const qr = encodeQrMatrix(url, ecLevel)
      assert.equal(qr.size, qr.version * 4 + 17)
      assert.equal(verifyAndDecode(qr.modules), url)
    }
  }
  // 单独验证 Version 14-15 超长链接在默认纠错级别 M 下仍正确编解码
  const veryLongUrl = `https://jiyu.example.org:8443/#/submit/${'a'.repeat(340)}`
  const qrLong = encodeQrMatrix(veryLongUrl, 'M')
  assert.ok(qrLong.version >= 13)
  assert.equal(verifyAndDecode(qrLong.modules), veryLongUrl)
})

test('renderQrSvg、qrSvgDataUrl 与 renderShareCardSvg 生成合法自包含 SVG 且兼容 CSP', () => {
  const url = 'https://jiyu.example.com/#/submit/demoToken123456'
  const svg = renderQrSvg(url, { title: '测试收集 <二维码>' })
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
  assert.ok(svg.includes('<title>测试收集 &lt;二维码&gt;</title>'))
  assert.ok(svg.includes('<path d="M'))
  assert.ok(!svg.includes('<script'))

  const dataUrl = qrSvgDataUrl(url)
  assert.ok(dataUrl.startsWith('data:image/svg+xml;charset=utf-8,'))

  const card = renderShareCardSvg({
    title: '秋季作业收集',
    description: '请提交 PDF 版本',
    url,
    deadline: '2026-12-01',
    formats: 'PDF, DOCX',
    passcode: '8866',
    hasAccessCode: true,
    materials: ['报名表', '作品说明'],
  })
  assert.ok(card.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
  assert.ok(card.includes('秋季作业收集'))
  assert.ok(card.includes('访问提取码：8866'))
  assert.ok(card.includes('报名表、作品说明'))
  // 验证分享卡片采用 ISO 规范 margin: 4 与整数像素步长（无浮点 scale 细缝）
  const matrix = encodeQrMatrix(url, 'M')
  const expectedViewSize = matrix.size + 8
  assert.ok(
    card.includes(
      `<rect width="${expectedViewSize}" height="${expectedViewSize}" fill="#ffffff"/>`,
    ),
    '分享卡片二维码静区应为 ISO 规范 margin=4',
  )
  assert.match(
    card,
    /transform="translate\(\d+,\d+\) scale\(\d+\)"/,
    '分享卡片二维码应使用整数平移与整数模块缩放步长，避免 Canvas 导出细缝',
  )

  // 验证超长 URL (>412 字节) 明确抛出可捕获错误供前端优雅降级
  const oversizeUrl = `https://jiyu.example.com/#/submit/${'a'.repeat(420)}`
  assert.throws(() => qrSvgDataUrl(oversizeUrl), /过长|容量|length|字节/)
})
