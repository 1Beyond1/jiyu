export type QrEcLevel = 'L' | 'M' | 'Q' | 'H'

export interface QrMatrix {
  version: number
  size: number
  ecLevel: QrEcLevel
  mask: number
  modules: boolean[][]
}

export interface QrSvgOptions {
  size?: number
  margin?: number
  dark?: string
  light?: string
  title?: string
  ecLevel?: QrEcLevel
}

export interface ShareCardOptions {
  title: string
  url: string
  deadline: string
  formats: string
  description?: string
  passcode?: string
  hasAccessCode?: boolean
  materials?: string[]
  ownerName?: string
}

const EC_FORMAT_BITS: Record<QrEcLevel, number> = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2,
}

// ISO/IEC 18004 Table 9: [ecCodewordsPerBlock, numBlocks] for versions 1..15
const EC_CODEWORDS_PER_BLOCK: Record<QrEcLevel, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24],
}

const NUM_EC_BLOCKS: Record<QrEcLevel, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18],
}

const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
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

const MAX_VERSION = 15

function totalRawDataModules(version: number): number {
  const size = version * 4 + 17
  let count = size * size
  // Three 7x7 finder patterns + separators (three 8x8 corners)
  count -= 3 * 64
  // Timing patterns (two lines between finder separators)
  count -= 2 * (size - 16)
  // Format info (2 x 15 bits) + dark module (1 bit)
  count -= 31
  // Alignment patterns
  const align = ALIGNMENT_POSITIONS[version]
  if (align.length > 0) {
    const numAlign = align.length * align.length - 3
    count -= numAlign * 25
    // Overlap between alignment patterns and timing patterns (2 per middle alignment)
    count += (align.length - 2) * 2 * 5
  }
  // Version info (two 6x3 blocks for version >= 7)
  if (version >= 7) count -= 36
  return count
}

function dataCodewordCapacity(version: number, ecLevel: QrEcLevel): number {
  const totalCodewords = Math.floor(totalRawDataModules(version) / 8)
  return totalCodewords - EC_CODEWORDS_PER_BLOCK[ecLevel][version] * NUM_EC_BLOCKS[ecLevel][version]
}

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsGenerator(degree: number): Uint8Array {
  const coeffs = new Uint8Array(degree)
  coeffs[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      coeffs[j] = gfMultiply(coeffs[j], root)
      if (j + 1 < degree) coeffs[j] ^= coeffs[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return coeffs
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length)
  for (const byte of data) {
    const factor = byte ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMultiply(divisor[i], factor)
    }
  }
  return result
}

function appendBits(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1)
  }
}

function buildCodewords(payload: Uint8Array, version: number, ecLevel: QrEcLevel): Uint8Array {
  const dataCapacity = dataCodewordCapacity(version, ecLevel)
  const countBits = version <= 9 ? 8 : 16
  const bits: number[] = []
  // Byte mode indicator: 0100
  appendBits(bits, 0b0100, 4)
  appendBits(bits, payload.length, countBits)
  for (const byte of payload) appendBits(bits, byte, 8)
  const capacityBits = dataCapacity * 8
  const terminatorLen = Math.min(4, capacityBits - bits.length)
  appendBits(bits, 0, terminatorLen)
  while (bits.length % 8 !== 0) bits.push(0)
  const padBytes = [0xec, 0x11]
  let padIdx = 0
  while (bits.length < capacityBits) {
    appendBits(bits, padBytes[padIdx % 2], 8)
    padIdx++
  }
  const dataBytes = new Uint8Array(dataCapacity)
  for (let i = 0; i < dataCapacity; i++) {
    let byte = 0
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]
    dataBytes[i] = byte
  }

  const totalCodewords = Math.floor(totalRawDataModules(version) / 8)
  const numBlocks = NUM_EC_BLOCKS[ecLevel][version]
  const ecLen = EC_CODEWORDS_PER_BLOCK[ecLevel][version]
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks)
  const shortBlockLen = Math.floor(totalCodewords / numBlocks)
  const divisor = rsGenerator(ecLen)

  const blocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - ecLen + (i < numShortBlocks ? 0 : 1)
    const block = dataBytes.subarray(offset, offset + datLen)
    offset += datLen
    blocks.push(block)
    ecBlocks.push(rsRemainder(block, divisor))
  }

  const interleaved = new Uint8Array(totalCodewords)
  let out = 0
  const maxDataLen = shortBlockLen - ecLen + (numShortBlocks < numBlocks ? 1 : 0)
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blocks[b].length) interleaved[out++] = blocks[b][i]
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      interleaved[out++] = ecBlocks[b][i]
    }
  }
  return interleaved
}

function drawFunctionPatterns(version: number): { modules: boolean[][]; isFunction: boolean[][] } {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const isFunction = Array.from({ length: size }, () => Array<boolean>(size).fill(false))

  const setFunc = (row: number, col: number, dark: boolean) => {
    modules[row][col] = dark
    isFunction[row][col] = true
  }

  // Timing patterns
  for (let i = 0; i < size; i++) {
    setFunc(6, i, i % 2 === 0)
    setFunc(i, 6, i % 2 === 0)
  }

  // Finder patterns + 1px white separators
  const drawFinder = (centerRow: number, centerCol: number) => {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const r = centerRow + dr
        const c = centerCol + dc
        if (r < 0 || r >= size || c < 0 || c >= size) continue
        const dist = Math.max(Math.abs(dr), Math.abs(dc))
        setFunc(r, c, dist !== 2 && dist !== 4)
      }
    }
  }
  drawFinder(3, 3)
  drawFinder(3, size - 4)
  drawFinder(size - 4, 3)

  // Alignment patterns
  const align = ALIGNMENT_POSITIONS[version]
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const skip =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0)
      if (skip) continue
      const cr = align[i]
      const cc = align[j]
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFunc(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
        }
      }
    }
  }

  // Reserve format info area & draw dark module
  drawFormatBits(modules, isFunction, size, 'M', 0)

  // Draw version info for version >= 7
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunc(a, b, bit)
      setFunc(b, a, bit)
    }
  }

  return { modules, isFunction }
}

function drawFormatBits(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  ecLevel: QrEcLevel,
  mask: number,
) {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412

  const setFunc = (r: number, c: number, dark: boolean) => {
    modules[r][c] = dark
    isFunction[r][c] = true
  }

  // Copy 1 (around top-left finder: bit 0 LSB at (0,8) .. bit 14 MSB at (8,0))
  for (let i = 0; i <= 5; i++) setFunc(i, 8, ((bits >>> i) & 1) !== 0)
  setFunc(7, 8, ((bits >>> 6) & 1) !== 0)
  setFunc(8, 8, ((bits >>> 7) & 1) !== 0)
  setFunc(8, 7, ((bits >>> 8) & 1) !== 0)
  for (let i = 9; i < 15; i++) setFunc(8, 14 - i, ((bits >>> i) & 1) !== 0)

  // Copy 2 (top-right row 8: bits 0..7; bottom-left col 8: bits 8..14)
  for (let i = 0; i < 8; i++) setFunc(8, size - 1 - i, ((bits >>> i) & 1) !== 0)
  for (let i = 8; i < 15; i++) setFunc(size - 15 + i, 8, ((bits >>> i) & 1) !== 0)
  // Always-dark module at (4*version + 9, 8) === (size - 8, 8)
  setFunc(size - 8, 8, true)
}

function drawCodewords(modules: boolean[][], isFunction: boolean[][], codewords: Uint8Array) {
  const size = modules.length
  let bitIdx = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vert : vert
        if (!isFunction[row][col] && bitIdx < codewords.length * 8) {
          modules[row][col] = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0
          bitIdx++
        }
      }
    }
  }
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number) {
  const size = modules.length
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunction[r][c] && maskBit(mask, r, c)) {
        modules[r][c] = !modules[r][c]
      }
    }
  }
}

function penaltyScore(modules: boolean[][]): number {
  const size = modules.length
  let score = 0

  // Rule 1: adjacent modules in row/column in same color
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0]
    let runLen = 1
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen++
        if (runLen === 5) score += 3
        else if (runLen > 5) score += 1
      } else {
        runColor = modules[r][c]
        runLen = 1
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c]
    let runLen = 1
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen++
        if (runLen === 5) score += 3
        else if (runLen > 5) score += 1
      } else {
        runColor = modules[r][c]
        runLen = 1
      }
    }
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = modules[r][c]
      if (
        color === modules[r][c + 1] &&
        color === modules[r + 1][c] &&
        color === modules[r + 1][c + 1]
      ) {
        score += 3
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with 4 light modules on either side
  const isFinderLike = (line: boolean[]) => {
    let hits = 0
    for (let i = 0; i <= line.length - 11; i++) {
      const p1 =
        line[i] &&
        !line[i + 1] &&
        line[i + 2] &&
        line[i + 3] &&
        line[i + 4] &&
        !line[i + 5] &&
        line[i + 6] &&
        !line[i + 7] &&
        !line[i + 8] &&
        !line[i + 9] &&
        !line[i + 10]
      const p2 =
        !line[i] &&
        !line[i + 1] &&
        !line[i + 2] &&
        !line[i + 3] &&
        line[i + 4] &&
        !line[i + 5] &&
        line[i + 6] &&
        line[i + 7] &&
        line[i + 8] &&
        !line[i + 9] &&
        line[i + 10]
      if (p1 || p2) hits++
    }
    return hits * 40
  }
  for (let r = 0; r < size; r++) score += isFinderLike(modules[r])
  for (let c = 0; c < size; c++) {
    const col = Array.from({ length: size }, (_, r) => modules[r][c])
    score += isFinderLike(col)
  }

  // Rule 4: balance of dark and light modules
  let darkCount = 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) darkCount++
    }
  }
  const total = size * size
  const k = Math.floor(Math.abs(darkCount * 20 - total * 10) / total)
  score += k * 10

  return score
}

export function encodeQrMatrix(text: string, ecLevel: QrEcLevel = 'M'): QrMatrix {
  if (!text) throw new Error('二维码内容不能为空')
  const payload = new TextEncoder().encode(text)
  let version = 0
  for (let v = 1; v <= MAX_VERSION; v++) {
    const headerBits = 4 + (v <= 9 ? 8 : 16)
    const maxBytes = Math.floor((dataCodewordCapacity(v, ecLevel) * 8 - headerBits) / 8)
    if (payload.length <= maxBytes) {
      version = v
      break
    }
  }
  if (!version) throw new Error('二维码内容超出最大容量')

  const codewords = buildCodewords(payload, version, ecLevel)
  const { modules, isFunction } = drawFunctionPatterns(version)
  drawCodewords(modules, isFunction, codewords)

  let bestMask = 0
  let bestScore = Number.POSITIVE_INFINITY
  const size = modules.length
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunction, mask)
    drawFormatBits(modules, isFunction, size, ecLevel, mask)
    const score = penaltyScore(modules)
    if (score < bestScore) {
      bestScore = score
      bestMask = mask
    }
    applyMask(modules, isFunction, mask)
  }

  applyMask(modules, isFunction, bestMask)
  drawFormatBits(modules, isFunction, size, ecLevel, bestMask)

  return { version, size, ecLevel, mask: bestMask, modules }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function qrPathData(modules: boolean[][], margin: number): string {
  const parts: string[] = []
  for (let r = 0; r < modules.length; r++) {
    const row = modules[r]
    let c = 0
    while (c < row.length) {
      if (!row[c]) {
        c++
        continue
      }
      const start = c
      while (c < row.length && row[c]) c++
      const run = c - start
      parts.push(`M${start + margin},${r + margin}h${run}v1h-${run}z`)
    }
  }
  return parts.join('')
}

export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
  const ecLevel = options.ecLevel || 'M'
  const margin = Math.max(0, Math.min(8, options.margin ?? 4))
  const dark = options.dark || '#2a211c'
  const light = options.light || '#ffffff'
  const matrix = encodeQrMatrix(text, ecLevel)
  const viewSize = matrix.size + margin * 2
  const pixelSize = options.size ?? 240
  const title = escapeXml(options.title || '集屿收集二维码')
  const path = qrPathData(matrix.modules, margin)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${pixelSize}" height="${pixelSize}" role="img" shape-rendering="crispEdges"><title>${title}</title><rect width="${viewSize}" height="${viewSize}" fill="${escapeXml(light)}"/><path d="${path}" fill="${escapeXml(dark)}"/></svg>`
}

export function qrSvgDataUrl(text: string, options: QrSvgOptions = {}): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderQrSvg(text, options))}`
}

function truncateLine(text: string, maxChars: number): string {
  const chars = [...text.trim()]
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`
}

export function renderShareCardSvg(options: ShareCardOptions): string {
  const matrix = encodeQrMatrix(options.url, 'M')
  const margin = 4
  const viewSize = matrix.size + margin * 2
  const qrBoxSize = 264
  // 使用整数模块像素步长（在 1x SVG 与 2x Canvas PNG 导出中均为精确整数），彻底消除抗锯齿细缝
  const modulePx = Math.max(2, Math.floor(qrBoxSize / viewSize))
  const qrDrawSize = viewSize * modulePx
  const qrX = (480 - qrBoxSize) / 2
  const qrY = 174
  const qrOffsetX = Math.round((480 - qrDrawSize) / 2)
  const qrOffsetY = Math.round(qrY + (qrBoxSize - qrDrawSize) / 2)
  const qrPath = qrPathData(matrix.modules, margin)
  const title = escapeXml(truncateLine(options.title || '文件收集', 20))
  const subtitle = escapeXml(
    truncateLine(options.description || '扫码免登录提交文件，请保留个人回执', 28),
  )
  const materialsLine = options.materials?.length
    ? escapeXml(truncateLine(`必需/材料项：${options.materials.join('、')}`, 32))
    : ''
  const codeLine = options.passcode
    ? escapeXml(`访问提取码：${options.passcode}`)
    : options.hasAccessCode
      ? '已启用提取码保护，请向发起人获取提取码'
      : '免登录直传 · 保留个人私密回执'
  const height = materialsLine ? 620 : 592
  const footerY = height - 42

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 ${height}" width="960" height="${height * 2}" role="img">
<title>${title} 分享卡片</title>
<rect width="480" height="${height}" rx="28" fill="#fbf7f4"/>
<rect x="20" y="20" width="440" height="${height - 40}" rx="22" fill="#ffffff" stroke="#efe4dc" stroke-width="1.5"/>
<rect x="44" y="42" width="32" height="32" rx="10" fill="#e8613c"/>
<path d="M52 54h7l2.4 3.2h6.6v9.6H52z" fill="#fffdf8"/>
<path d="M52 51.6h8l3.2 4H52z" fill="#f7c8b9"/>
<text x="86" y="64" fill="#2a211c" font-size="16" font-weight="700" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">集屿 · 文件收集</text>
<text x="436" y="63" text-anchor="end" fill="#8a7568" font-size="12" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">截止 ${escapeXml(options.deadline)}</text>
<text x="240" y="114" text-anchor="middle" fill="#2a211c" font-size="22" font-weight="700" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">${title}</text>
<text x="240" y="144" text-anchor="middle" fill="#5f5049" font-size="13" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">${subtitle}</text>
<rect x="${qrX - 14}" y="${qrY - 14}" width="${qrBoxSize + 28}" height="${qrBoxSize + 28}" rx="18" fill="#ffffff" stroke="#efe4dc" stroke-width="1.5"/>
<g transform="translate(${qrOffsetX},${qrOffsetY}) scale(${modulePx})" shape-rendering="crispEdges">
<rect width="${viewSize}" height="${viewSize}" fill="#ffffff"/>
<path d="${qrPath}" fill="#2a211c"/>
</g>
<text x="240" y="${qrY + qrBoxSize + 44}" text-anchor="middle" fill="#c4461f" font-size="14" font-weight="600" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">${codeLine}</text>
<text x="240" y="${qrY + qrBoxSize + 70}" text-anchor="middle" fill="#5f5049" font-size="12" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">允许格式：${escapeXml(truncateLine(options.formats, 34))}</text>
${materialsLine ? `<text x="240" y="${qrY + qrBoxSize + 96}" text-anchor="middle" fill="#5f5049" font-size="12" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">${materialsLine}</text>` : ''}
<text x="240" y="${footerY}" text-anchor="middle" fill="#8a7568" font-size="11" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif">微信/浏览器扫码打开提交页 · 由本地离线生成</text>
</svg>`
}
