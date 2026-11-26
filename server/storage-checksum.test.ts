import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import { s3Headers, StandardStorage } from './storage-adapters.ts'
import { DriveStorage, quickXorHashBuffer } from './drive-storage.ts'
import type { RemoteHTTP, RemoteRequest } from './remote-http.ts'
import type { StorageProfile } from '../src/types.ts'

const s3Profile: StorageProfile = {
  id: 's3',
  endpoint: 'https://s3.example.com',
  root: '/jiyu',
  bucket: 'jiyu-bucket',
  region: 'us-east-1',
  enabled: true,
  hasCredentials: true,
  revision: 'rev-1',
}

test('S3 优先核验 x-amz-checksum-sha256 或单段 MD5 ETag 跳过全量回读，严格模式与缺失时回退读回', async () => {
  const payload = Buffer.from('集屿云同步原生校验和省流测试正文')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const sha256B64 = Buffer.from(sha256, 'hex').toString('base64')
  const md5 = createHash('md5').update(payload).digest('hex')

  // 1. 服务端返回匹配的 x-amz-checksum-sha256 -> 跳过 GET 回读
  const reqs1: RemoteRequest[] = []
  const http1: RemoteHTTP = async (req) => {
    reqs1.push(req)
    return {
      status: 200,
      headers: { 'x-amz-checksum-sha256': sha256B64 },
      body: Readable.from([Buffer.alloc(0)]),
    }
  }
  const s3WithChecksum = new StandardStorage(
    s3Profile,
    { accessKeyId: 'ak', secretAccessKey: 'sk' },
    http1,
    new AbortController().signal,
  )
  await s3WithChecksum.put('/jiyu/task/a.txt', payload, payload.length, sha256)
  assert.equal(reqs1.length, 1)
  assert.equal(reqs1[0].method, 'PUT')
  assert.equal(reqs1[0].headers?.['x-amz-checksum-sha256'], sha256B64)
  assert.match(
    String(reqs1[0].headers?.authorization || ''),
    /SignedHeaders=host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date,/,
    'S3 PUT Authorization SignedHeaders 必须包含 x-amz-checksum-sha256',
  )
  assert.equal(
    reqs1.some((r) => r.method === 'GET'),
    false,
  )

  // 1b. 直接验证 s3Headers 合并并规范化 extraHeaders 中的 x-amz-* 参与 SigV4 签名计算
  const fixedDate = new Date('2026-11-26T12:00:00.000Z')
  const putUrl = new URL('https://s3.example.com/jiyu-bucket/jiyu/task/a.txt')
  const signed = s3Headers(
    'PUT',
    putUrl,
    'us-east-1',
    { accessKeyId: 'ak', secretAccessKey: 'sk' },
    sha256,
    fixedDate,
    {
      'X-Amz-Checksum-Sha256': sha256B64,
      'x-custom-ignored': 'ignored',
      'x-amz-date': 'spoofed-date',
    },
  )
  assert.equal(signed['x-amz-checksum-sha256'], sha256B64)
  assert.equal(signed['x-amz-date'], '20261126T120000Z')
  assert.equal('x-custom-ignored' in signed, false)
  const expectedCanonical = [
    'PUT',
    '/jiyu-bucket/jiyu/task/a.txt',
    '',
    `host:s3.example.com\nx-amz-checksum-sha256:${sha256B64}\nx-amz-content-sha256:${sha256}\nx-amz-date:20261126T120000Z\n`,
    'host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date',
    sha256,
  ].join('\n')
  const hmac = (key: Buffer | string, val: string) => createHmac('sha256', key).update(val).digest()
  const signingKey = hmac(hmac(hmac(hmac('AWS4sk', '20261126'), 'us-east-1'), 's3'), 'aws4_request')
  const expectedSig = createHmac('sha256', signingKey)
    .update(
      `AWS4-HMAC-SHA256\n20261126T120000Z\n20261126/us-east-1/s3/aws4_request\n${createHash('sha256').update(expectedCanonical).digest('hex')}`,
    )
    .digest('hex')
  assert.equal(
    signed.authorization,
    `AWS4-HMAC-SHA256 Credential=ak/20261126/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date, Signature=${expectedSig}`,
  )

  // 2. 服务端返回不匹配的 x-amz-checksum-sha256 -> 拒绝并报 502
  const badShaB64 = Buffer.from('0'.repeat(64), 'hex').toString('base64')
  const s3BadChecksum = new StandardStorage(
    s3Profile,
    { accessKeyId: 'ak', secretAccessKey: 'sk' },
    async () => ({
      status: 200,
      headers: { 'x-amz-checksum-sha256': badShaB64 },
      body: Readable.from([Buffer.alloc(0)]),
    }),
    new AbortController().signal,
  )
  await assert.rejects(
    () => s3BadChecksum.put('/jiyu/task/bad.txt', payload, payload.length, sha256),
    /校验和不匹配/,
  )

  // 3. 服务端返回单段 MD5 ETag -> 跳过 GET 回读
  const reqs3: RemoteRequest[] = []
  const s3Etag = new StandardStorage(
    s3Profile,
    { accessKeyId: 'ak', secretAccessKey: 'sk' },
    async (req) => {
      reqs3.push(req)
      return {
        status: 200,
        headers: { etag: `"${md5}"` },
        body: Readable.from([Buffer.alloc(0)]),
      }
    },
    new AbortController().signal,
  )
  await s3Etag.put('/jiyu/task/b.txt', payload, payload.length, sha256)
  assert.equal(
    reqs3.some((r) => r.method === 'GET'),
    false,
  )

  // 4. 服务端返回多段 ETag（带 -2 后缀）或缺失 -> 自动回退 GET 全量读回
  const reqs4: RemoteRequest[] = []
  const s3MultipartEtag = new StandardStorage(
    s3Profile,
    { accessKeyId: 'ak', secretAccessKey: 'sk' },
    async (req) => {
      reqs4.push(req)
      return {
        status: 200,
        headers: req.method === 'PUT' ? { etag: `"${md5}-2"` } : {},
        body: Readable.from([req.method === 'GET' ? payload : Buffer.alloc(0)]),
      }
    },
    new AbortController().signal,
  )
  await s3MultipartEtag.put('/jiyu/task/c.txt', payload, payload.length, sha256)
  assert.equal(
    reqs4.some((r) => r.method === 'GET'),
    true,
  )

  // 5. 开启严格回读模式 -> 即使返回 x-amz-checksum-sha256 也强制执行 GET 全量读回
  const reqs5: RemoteRequest[] = []
  const s3Strict = new StandardStorage(
    s3Profile,
    { accessKeyId: 'ak', secretAccessKey: 'sk' },
    async (req) => {
      reqs5.push(req)
      return {
        status: 200,
        headers: { 'x-amz-checksum-sha256': sha256B64 },
        body: Readable.from([req.method === 'GET' ? payload : Buffer.alloc(0)]),
      }
    },
    new AbortController().signal,
    { strictReadback: true },
  )
  await s3Strict.put('/jiyu/task/d.txt', payload, payload.length, sha256)
  assert.equal(
    reqs5.some((r) => r.method === 'GET'),
    true,
  )
})

test('OneDrive 与 Google Drive 优先比对原生校验和跳过二次下载，异常哈希拒绝、缺失回退', async () => {
  const payload = Buffer.from('OneDrive and Google Drive native hash check payload 123456')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const qxh = quickXorHashBuffer(payload)
  assert.equal(quickXorHashBuffer(Buffer.alloc(0)), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')

  // OneDrive: sha256Hash 匹配跳过 /content 回读
  const odRequests: RemoteRequest[] = []
  const makeOdHttp =
    (hashes?: Record<string, string>, log: RemoteRequest[] = odRequests): RemoteHTTP =>
    async (req) => {
      log.push(req)
      if (req.url.hostname === 'upload.up.1drv.com') {
        return {
          status: 200,
          headers: {},
          body: Readable.from([
            Buffer.from(
              JSON.stringify({
                id: 'od-file-1',
                size: payload.length,
                ...(hashes ? { file: { hashes } } : {}),
              }),
            ),
          ]),
        }
      }
      if (req.url.pathname.endsWith('/createUploadSession')) {
        return {
          status: 200,
          headers: {},
          body: Readable.from([
            Buffer.from(JSON.stringify({ uploadUrl: 'https://upload.up.1drv.com/session' })),
          ]),
        }
      }
      if (req.url.pathname.endsWith('/content')) {
        return { status: 200, headers: {}, body: Readable.from([payload]) }
      }
      if (req.url.pathname.includes('file_')) {
        return { status: 404, headers: {}, body: Readable.from([Buffer.alloc(0)]) }
      }
      return {
        status: 200,
        headers: {},
        body: Readable.from([Buffer.from(JSON.stringify({ id: 'folder-id', folder: {} }))]),
      }
    }

  const odProfile: StorageProfile = {
    id: 'onedrive',
    endpoint: '',
    root: '/集屿',
    enabled: true,
    hasCredentials: true,
    revision: 'rev',
  }

  // 1a. OneDrive sha256Hash 命中
  const od1 = new DriveStorage(
    odProfile,
    { accessToken: 'tok' },
    makeOdHttp({ sha256Hash: sha256.toUpperCase() }, odRequests),
    new AbortController().signal,
  )
  await od1.put('/集屿/task/file_a.txt', payload, payload.length, sha256)
  assert.equal(
    odRequests.some((r) => r.url.pathname.endsWith('/content')),
    false,
  )

  // 1b. OneDrive quickXorHash 命中（企业版/SharePoint 常见）
  const odXorReqs: RemoteRequest[] = []
  const od2 = new DriveStorage(
    odProfile,
    { accessToken: 'tok' },
    makeOdHttp({ quickXorHash: qxh }, odXorReqs),
    new AbortController().signal,
  )
  await od2.put('/集屿/task/file_b.txt', payload, payload.length, sha256)
  assert.equal(
    odXorReqs.some((r) => r.url.pathname.endsWith('/content')),
    false,
  )

  // 1c. OneDrive quickXorHash 不匹配 -> 拒绝
  const od3 = new DriveStorage(
    odProfile,
    { accessToken: 'tok' },
    makeOdHttp({ quickXorHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, []),
    new AbortController().signal,
  )
  await assert.rejects(
    () => od3.put('/集屿/task/file_c.txt', payload, payload.length, sha256),
    /QuickXorHash 校验失败/,
  )

  // 2. Google Drive sha256Checksum 命中跳过 alt=media 回读
  const gdReqs: RemoteRequest[] = []
  const makeGdHttp =
    (sha256Checksum?: string, log: RemoteRequest[] = gdReqs): RemoteHTTP =>
    async (req) => {
      log.push(req)
      if (req.url.pathname === '/session') {
        return {
          status: 200,
          headers: {},
          body: Readable.from([
            Buffer.from(
              JSON.stringify({
                id: 'gd-file-1',
                size: String(payload.length),
                ...(sha256Checksum ? { sha256Checksum } : {}),
              }),
            ),
          ]),
        }
      }
      if (req.url.pathname.startsWith('/upload/drive/')) {
        assert.ok(req.url.searchParams.get('fields')?.includes('sha256Checksum'))
        return {
          status: 200,
          headers: { location: 'https://www.googleapis.com/session' },
          body: Readable.from([Buffer.alloc(0)]),
        }
      }
      if (req.url.searchParams.get('alt') === 'media') {
        return { status: 200, headers: {}, body: Readable.from([payload]) }
      }
      const q = req.url.searchParams.get('q') || ''
      return {
        status: 200,
        headers: {},
        body: Readable.from([
          Buffer.from(
            JSON.stringify({ files: q.includes('mimeType=') ? [{ id: 'folder-1' }] : [] }),
          ),
        ]),
      }
    }

  const gdProfile: StorageProfile = {
    id: 'gdrive',
    endpoint: '',
    root: '/集屿',
    enabled: true,
    hasCredentials: true,
    revision: 'rev',
  }
  const gd1 = new DriveStorage(
    gdProfile,
    { accessToken: 'tok' },
    makeGdHttp(sha256, gdReqs),
    new AbortController().signal,
  )
  await gd1.put('/集屿/task/file_gd.txt', payload, payload.length, sha256)
  assert.equal(
    gdReqs.some((r) => r.url.searchParams.get('alt') === 'media'),
    false,
  )

  // Google Drive sha256Checksum 不匹配 -> 拒绝
  const gdBad = new DriveStorage(
    gdProfile,
    { accessToken: 'tok' },
    makeGdHttp('f'.repeat(64), []),
    new AbortController().signal,
  )
  await assert.rejects(
    () => gdBad.put('/集屿/task/file_gd_bad.txt', payload, payload.length, sha256),
    /Google Drive SHA-256 校验失败/,
  )
})
