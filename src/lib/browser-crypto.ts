// Browser-safe UUID and SHA-256 helpers that work on both HTTPS and non-HTTPS LAN origins.

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function fillRandomBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') {
    try {
      c.getRandomValues(bytes)
      return bytes
    } catch {
      /* Fall back below if the environment blocks WebCrypto. */
    }
  }
  let seed = Date.now() ^ (Math.floor(Math.random() * 0x100000000) >>> 0)
  for (let i = 0; i < bytes.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    bytes[i] = ((seed >>> 24) ^ Math.floor(Math.random() * 256)) & 0xff
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function safeRandomHex(byteLength = 32): string {
  return bytesToHex(fillRandomBytes(new Uint8Array(byteLength)))
}

export function safeRandomUUID(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      /* Fall back to RFC 4122 v4 generation on non-secure contexts. */
    }
  }
  const bytes = fillRandomBytes(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function sha256BytesFallback(data: Uint8Array): Uint8Array {
  const len = data.length
  const totalLen = (len + 9 + 63) & ~63
  const padded = new Uint8Array(totalLen)
  padded.set(data)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  const highBits = Math.floor(len / 0x20000000)
  const lowBits = (len << 3) >>> 0
  view.setUint32(totalLen - 8, highBits, false)
  view.setUint32(totalLen - 4, lowBits, false)

  let h0 = SHA256_INIT[0],
    h1 = SHA256_INIT[1],
    h2 = SHA256_INIT[2],
    h3 = SHA256_INIT[3]
  let h4 = SHA256_INIT[4],
    h5 = SHA256_INIT[5],
    h6 = SHA256_INIT[6],
    h7 = SHA256_INIT[7]
  const w = new Uint32Array(64)

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15],
        w2 = w[i - 2]
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0, false)
  outView.setUint32(4, h1, false)
  outView.setUint32(8, h2, false)
  outView.setUint32(12, h3, false)
  outView.setUint32(16, h4, false)
  outView.setUint32(20, h5, false)
  outView.setUint32(24, h6, false)
  outView.setUint32(28, h7, false)
  return out
}

function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input)
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}

export async function sha256Buffer(input: Uint8Array | ArrayBuffer | string): Promise<ArrayBuffer> {
  const bytes = toBytes(input)
  const subtle = globalThis.crypto?.subtle
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      return await subtle.digest('SHA-256', copy.buffer)
    } catch {
      /* Fall back to pure-JS SHA-256 if subtle is unavailable or restricted. */
    }
  }
  const digest = sha256BytesFallback(bytes)
  return digest.buffer.slice(
    digest.byteOffset,
    digest.byteOffset + digest.byteLength,
  ) as ArrayBuffer
}

export async function sha256Hex(input: Uint8Array | ArrayBuffer | string): Promise<string> {
  return bytesToHex(new Uint8Array(await sha256Buffer(input)))
}
