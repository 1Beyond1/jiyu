import type { FastifyInstance } from 'fastify'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import type {
  WebhookChannel,
  WebhookChannelType,
  WebhookEventType,
  WebhookLog,
} from '../src/types.ts'
import { isExpired, localDate } from '../src/lib/collections.ts'
import { materialProgress } from '../src/lib/materials.ts'
import type { Store } from './store.ts'
import { decrypt, encrypt } from './secrets.ts'
import { HttpError, object, text } from './security.ts'
import { isPublicAddress } from './ai.ts'
import { remoteBody, remoteHTTP, remoteOK } from './remote-http.ts'
import type { RemoteHTTP } from './remote-http.ts'

const CHANNEL_TYPES: readonly WebhookChannelType[] = ['feishu', 'dingtalk', 'wecom', 'generic']
const EVENT_TYPES: readonly WebhookEventType[] = [
  'submission.created',
  'review.accepted',
  'review.needs_changes',
  'collection.deadline_soon',
]
const MAX_CHANNELS = 10
const MAX_LOGS = 50
const MAX_QUEUE_SIZE = 200
const DEFAULT_DEBOUNCE_SECONDS = 60

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType | 'test', string> = {
  'submission.created': '新提交',
  'review.accepted': '审核通过',
  'review.needs_changes': '审核退回/需补充',
  'collection.deadline_soon': '任务临近截止',
  test: '测试通知',
}

interface StoredWebhookChannel {
  id: string
  name: string
  type: WebhookChannelType
  enabled: boolean
  encryptedUrl: string
  urlHostHint: string
  encryptedSecret?: string
  events: WebhookEventType[]
  debounceSeconds: number
  createdAt: string
  updatedAt: string
}

interface StoredWebhookConfig {
  channels: StoredWebhookChannel[]
}

export interface WebhookEmitInput {
  event: WebhookEventType
  collectionId?: string
  collectionTitle?: string
  actor?: string
  summary: string
  detail?: string
  fileCount?: number
}

export interface WebhookPolicy {
  http?: RemoteHTTP
  debounceMs?: number
  retryBaseMs?: number
  maxAttempts?: number
  deadlineIntervalMs?: number
}

export interface WebhookDeliveryPayload {
  deliveryId: string
  event: WebhookEventType | 'test'
  collectionId?: string
  collectionTitle?: string
  mergedCount: number
  summary: string
  items: { actor?: string; summary: string; detail?: string; at: string }[]
}

export interface WebhookService {
  emit: (input: WebhookEmitInput) => void
  checkDeadlines: (force?: boolean) => number
  flushPending: () => Promise<void>
  stop: () => Promise<void>
}

export function maskWebhookUrl(url: URL): string {
  return `${url.protocol}//${url.host}/•••`
}

export function validateWebhookUrl(raw: string): URL {
  const trimmed = text(raw, 'Webhook 地址', 1000)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new HttpError(400, 'Webhook 地址格式无效，请填写完整的 HTTPS 地址')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new HttpError(400, 'Webhook 仅支持 HTTPS（443 端口），不支持内嵌账号密码')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new HttpError(400, 'Webhook 地址不能指向本机或内网域名')
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new HttpError(400, 'Webhook 地址不能指向本机、内网或保留 IP 地址')
  }
  return url
}

export function sanitizeWebhookError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '通知投递失败，请检查渠道配置与网络'
  return raw
    .replace(/https?:\/\/\S+/gi, '[已脱敏地址]')
    .replace(/\b(access_token|token|key|secret|sign)=[^&\s]+/gi, '$1=[已脱敏]')
    .slice(0, 200)
}

function formatMessageText(
  payload: WebhookDeliveryPayload,
  nowMs: number,
): {
  title: string
  plain: string
  markdown: string
} {
  const eventLabel = WEBHOOK_EVENT_LABELS[payload.event]
  const timeText = new Date(nowMs).toLocaleString('zh-CN', {
    timeZone: 'Asia/Taipei',
    hour12: false,
  })
  const title = payload.collectionTitle
    ? `【集屿 · ${eventLabel}】${payload.collectionTitle}`
    : `【集屿 · ${eventLabel}】`
  const detailLines = payload.items.slice(0, 8).map((item) => {
    const parts = [item.summary, item.detail].filter(Boolean).join(' — ')
    return `- ${parts}`
  })
  if (payload.mergedCount > detailLines.length) {
    detailLines.push(`- 另有 ${payload.mergedCount - detailLines.length} 条记录已聚合`)
  }
  const plain = [title, payload.summary, ...detailLines, `时间：${timeText}（UTC+8）`].join('\n')
  const markdown = [
    `### ${title}`,
    `> ${payload.summary}`,
    '',
    ...detailLines,
    '',
    `时间：${timeText}（UTC+8）`,
  ].join('\n')
  return { title, plain, markdown }
}

export function buildWebhookRequest(
  type: WebhookChannelType,
  targetUrl: string,
  secret: string | undefined,
  payload: WebhookDeliveryPayload,
  nowMs = Date.now(),
): { url: URL; headers: Record<string, string>; body: Buffer } {
  const url = new URL(targetUrl)
  const { title, plain, markdown } = formatMessageText(payload, nowMs)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'Jiyu-Webhook/0.5',
  }

  if (type === 'feishu') {
    const bodyObj: Record<string, unknown> = {
      msg_type: 'text',
      content: { text: plain },
    }
    if (secret) {
      const timestamp = String(Math.floor(nowMs / 1000))
      const sign = createHmac('sha256', `${timestamp}\n${secret}`).digest('base64')
      bodyObj.timestamp = timestamp
      bodyObj.sign = sign
    }
    return { url, headers, body: Buffer.from(JSON.stringify(bodyObj), 'utf8') }
  }

  if (type === 'dingtalk') {
    if (secret) {
      const timestamp = String(nowMs)
      const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
      url.searchParams.set('timestamp', timestamp)
      url.searchParams.set('sign', sign)
    }
    const bodyObj = {
      msgtype: 'markdown',
      markdown: { title, text: markdown },
    }
    return { url, headers, body: Buffer.from(JSON.stringify(bodyObj), 'utf8') }
  }

  if (type === 'wecom') {
    const bodyObj = {
      msgtype: 'markdown',
      markdown: { content: markdown },
    }
    return { url, headers, body: Buffer.from(JSON.stringify(bodyObj), 'utf8') }
  }

  // Generic HMAC Webhook
  const unixSeconds = String(Math.floor(nowMs / 1000))
  const bodyStr = JSON.stringify({
    id: payload.deliveryId,
    event: payload.event,
    timestamp: new Date(nowMs).toISOString(),
    ...(payload.collectionId
      ? {
          collection: {
            id: payload.collectionId,
            title: payload.collectionTitle || '',
          },
        }
      : {}),
    mergedCount: payload.mergedCount,
    summary: payload.summary,
    items: payload.items,
  })
  headers['X-Jiyu-Event'] = payload.event
  headers['X-Jiyu-Delivery'] = payload.deliveryId
  headers['X-Jiyu-Timestamp'] = unixSeconds
  if (secret) {
    const sig = createHmac('sha256', secret).update(`${unixSeconds}.${bodyStr}`).digest('hex')
    headers['X-Jiyu-Signature'] = `sha256=${sig}`
  }
  return { url, headers, body: Buffer.from(bodyStr, 'utf8') }
}

function checkPlatformResponseBody(type: WebhookChannelType, raw: Buffer) {
  if (type === 'generic' || !raw.length) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return
  }
  if (type === 'feishu') {
    const code =
      typeof parsed.code === 'number'
        ? parsed.code
        : typeof parsed.StatusCode === 'number'
          ? parsed.StatusCode
          : 0
    if (code !== 0) {
      throw Object.assign(new HttpError(502, `飞书接口拒绝了通知（code=${code}）`), {
        retryable: false,
      })
    }
  } else if (type === 'dingtalk') {
    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
      throw Object.assign(new HttpError(502, `钉钉接口拒绝了通知（errcode=${parsed.errcode}）`), {
        retryable: false,
      })
    }
  } else if (type === 'wecom') {
    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
      throw Object.assign(
        new HttpError(502, `企业微信接口拒绝了通知（errcode=${parsed.errcode}）`),
        { retryable: false },
      )
    }
  }
}

function readConfig(store: Store): StoredWebhookConfig {
  const raw = store.get('webhooks.config')
  if (!raw) return { channels: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWebhookConfig>
    return { channels: Array.isArray(parsed.channels) ? parsed.channels : [] }
  } catch {
    return { channels: [] }
  }
}

function writeConfig(store: Store, cfg: StoredWebhookConfig) {
  store.set('webhooks.config', JSON.stringify(cfg))
}

function secretKeyReady(store: Store): boolean {
  const path = join(store.dataDir, 'secrets.key')
  if (!existsSync(path)) return false
  try {
    return statSync(path).size === 32
  } catch {
    return false
  }
}

function toPublicChannel(ch: StoredWebhookChannel, keyReady: boolean): WebhookChannel {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    enabled: ch.enabled,
    urlHint: ch.urlHostHint,
    hasUrl: Boolean(ch.encryptedUrl),
    hasSecret: Boolean(ch.encryptedSecret),
    keyReady,
    events: ch.events,
    debounceSeconds: ch.debounceSeconds,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
  }
}

function parseEvents(raw: unknown): WebhookEventType[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, '请至少订阅一项通知事件')
  const unique = [...new Set(raw.map((v) => String(v)))]
  if (unique.some((e) => !EVENT_TYPES.includes(e as WebhookEventType))) {
    throw new HttpError(400, '包含无效的通知事件类型')
  }
  return unique as WebhookEventType[]
}

function parseDebounceSeconds(raw: unknown, fallback = DEFAULT_DEBOUNCE_SECONDS): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 5 || n > 300) {
    throw new HttpError(400, '聚合防刷屏窗口需为 5–300 秒之间的整数')
  }
  return n
}

function recordLog(store: Store, log: WebhookLog) {
  store.db
    .prepare(
      `INSERT INTO webhook_logs
        (id, channel_id, channel_name, channel_type, event, collection_id, status, http_status, attempts, merged_count, summary, error, target_hint, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      log.id,
      log.channelId,
      log.channelName,
      log.channelType,
      log.event,
      log.collectionId ?? null,
      log.status,
      log.httpStatus ?? null,
      log.attempts,
      log.mergedCount,
      log.summary,
      log.error ?? null,
      log.targetHint,
      log.createdAt,
    )
  store.db.exec(
    `DELETE FROM webhook_logs WHERE id NOT IN (SELECT id FROM webhook_logs ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_LOGS})`,
  )
}

function readLogs(store: Store): WebhookLog[] {
  const rows = store.db
    .prepare(
      `SELECT id, channel_id, channel_name, channel_type, event, collection_id, status, http_status, attempts, merged_count, summary, error, target_hint, created_at
       FROM webhook_logs ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_LOGS}`,
    )
    .all() as {
    id: string
    channel_id: string
    channel_name: string
    channel_type: WebhookChannelType
    event: WebhookEventType | 'test'
    collection_id: string | null
    status: 'succeeded' | 'failed'
    http_status: number | null
    attempts: number
    merged_count: number
    summary: string
    error: string | null
    target_hint: string
    created_at: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    channelType: r.channel_type,
    event: r.event,
    ...(r.collection_id ? { collectionId: r.collection_id } : {}),
    status: r.status,
    ...(r.http_status != null ? { httpStatus: r.http_status } : {}),
    attempts: r.attempts,
    mergedCount: r.merged_count,
    summary: r.summary,
    ...(r.error ? { error: r.error } : {}),
    targetHint: r.target_hint,
    createdAt: r.created_at,
  }))
}

interface PendingAggregate {
  channelId: string
  event: WebhookEventType
  collectionId?: string
  collectionTitle?: string
  items: { actor?: string; summary: string; detail?: string; at: string }[]
  mergedCount: number
  totalFiles: number
  timer: ReturnType<typeof setTimeout>
}

interface DeliveryJob {
  channelId: string
  payload: WebhookDeliveryPayload
}

function buildAggregatedSummary(agg: PendingAggregate): string {
  const titlePrefix = agg.collectionTitle ? `「${agg.collectionTitle}」` : ''
  if (agg.mergedCount === 1) return agg.items[0]?.summary || `${titlePrefix}收到新事件`
  if (agg.event === 'submission.created') {
    const actors = [
      ...new Set(agg.items.map((i) => i.actor).filter((a): a is string => Boolean(a))),
    ]
    const actorText = actors.length
      ? `（来自 ${actors.slice(0, 3).join('、')}${actors.length > 3 ? ` 等 ${actors.length} 人` : ''}）`
      : ''
    const fileText = agg.totalFiles > 0 ? `，共 ${agg.totalFiles} 份文件` : ''
    return `${titlePrefix}在聚合窗口内收到 ${agg.mergedCount} 次提交${fileText}${actorText}`
  }
  if (agg.event === 'review.accepted') {
    return `${titlePrefix}在聚合窗口内有 ${agg.mergedCount} 次材料审核通过`
  }
  if (agg.event === 'review.needs_changes') {
    return `${titlePrefix}在聚合窗口内有 ${agg.mergedCount} 次材料标记需补充`
  }
  return `${titlePrefix}汇总了 ${agg.mergedCount} 条${WEBHOOK_EVENT_LABELS[agg.event]}提醒`
}

export function registerWebhooks(
  app: FastifyInstance,
  store: Store,
  policy: WebhookPolicy = {},
): WebhookService {
  const http = policy.http ?? remoteHTTP
  const maxAttempts = Math.max(1, Math.min(5, policy.maxAttempts ?? 3))
  const retryBaseMs = Math.max(10, policy.retryBaseMs ?? 2000)
  const controller = new AbortController()
  let stopped = false

  const pending = new Map<string, PendingAggregate>()
  const queue: DeliveryJob[] = []
  let draining: Promise<void> | null = null

  async function sleep(ms: number) {
    if (stopped || controller.signal.aborted) return
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      t.unref()
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function deliverNow(
    channel: StoredWebhookChannel,
    payload: WebhookDeliveryPayload,
    attemptsLimit: number,
  ): Promise<WebhookLog> {
    let targetUrl: string
    let secret: string | undefined
    try {
      targetUrl = decrypt(store, channel.encryptedUrl)
      secret = channel.encryptedSecret ? decrypt(store, channel.encryptedSecret) : undefined
    } catch (err) {
      const failedLog: WebhookLog = {
        id: payload.deliveryId,
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        event: payload.event,
        ...(payload.collectionId ? { collectionId: payload.collectionId } : {}),
        status: 'failed',
        attempts: 1,
        mergedCount: payload.mergedCount,
        summary: payload.summary,
        error: sanitizeWebhookError(err),
        targetHint: channel.urlHostHint,
        createdAt: new Date().toISOString(),
      }
      if (!stopped) recordLog(store, failedLog)
      return failedLog
    }

    let lastStatus: number | undefined
    let lastError = '通知投递失败'
    let attempts = 0

    for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
      if (stopped || controller.signal.aborted) break
      attempts = attempt
      try {
        const req = buildWebhookRequest(channel.type, targetUrl, secret, payload)
        const res = await http({
          url: req.url,
          method: 'POST',
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        })
        lastStatus = res.status
        remoteOK(res)
        const bodyBuf = await remoteBody(res, 64 * 1024)
        checkPlatformResponseBody(channel.type, bodyBuf)

        const okLog: WebhookLog = {
          id: payload.deliveryId,
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          event: payload.event,
          ...(payload.collectionId ? { collectionId: payload.collectionId } : {}),
          status: 'succeeded',
          httpStatus: res.status,
          attempts,
          mergedCount: payload.mergedCount,
          summary: payload.summary,
          targetHint: channel.urlHostHint,
          createdAt: new Date().toISOString(),
        }
        if (!stopped) recordLog(store, okLog)
        return okLog
      } catch (err) {
        const tagged = err as { retryable?: boolean; upstreamStatus?: number }
        if (typeof tagged.upstreamStatus === 'number') lastStatus = tagged.upstreamStatus
        lastError = sanitizeWebhookError(err)
        const retryable = tagged.retryable === true
        if (!retryable || attempt >= attemptsLimit || stopped || controller.signal.aborted) {
          break
        }
        await sleep(retryBaseMs * 2 ** (attempt - 1))
      }
    }

    const failedLog: WebhookLog = {
      id: payload.deliveryId,
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      event: payload.event,
      ...(payload.collectionId ? { collectionId: payload.collectionId } : {}),
      status: 'failed',
      ...(lastStatus !== undefined ? { httpStatus: lastStatus } : {}),
      attempts: Math.max(1, attempts),
      mergedCount: payload.mergedCount,
      summary: payload.summary,
      error: lastError,
      targetHint: channel.urlHostHint,
      createdAt: new Date().toISOString(),
    }
    if (!stopped) recordLog(store, failedLog)
    return failedLog
  }

  function startDrain() {
    if (draining || stopped) return
    draining = (async () => {
      try {
        while (!stopped && queue.length > 0) {
          const job = queue.shift()!
          const cfg = readConfig(store)
          const ch = cfg.channels.find((c) => c.id === job.channelId)
          if (!ch || !ch.enabled) continue
          await deliverNow(ch, job.payload, maxAttempts)
        }
      } finally {
        draining = null
        if (!stopped && queue.length > 0) startDrain()
      }
    })()
  }

  function flushKey(key: string) {
    const agg = pending.get(key)
    if (!agg) return
    clearTimeout(agg.timer)
    pending.delete(key)
    if (stopped) return
    const payload: WebhookDeliveryPayload = {
      deliveryId: randomUUID(),
      event: agg.event,
      collectionId: agg.collectionId,
      collectionTitle: agg.collectionTitle,
      mergedCount: agg.mergedCount,
      summary: buildAggregatedSummary(agg),
      items: agg.items,
    }
    if (queue.length >= MAX_QUEUE_SIZE) queue.shift()
    queue.push({ channelId: agg.channelId, payload })
    startDrain()
  }

  function emit(input: WebhookEmitInput) {
    if (stopped) return
    const cfg = readConfig(store)
    const nowIso = new Date().toISOString()
    for (const ch of cfg.channels) {
      if (!ch.enabled || !ch.events.includes(input.event)) continue
      const key = `${ch.id}:${input.collectionId || 'global'}:${input.event}`
      const existing = pending.get(key)
      if (existing) {
        existing.mergedCount += 1
        existing.totalFiles += input.fileCount || 0
        if (existing.items.length < 20) {
          existing.items.push({
            ...(input.actor ? { actor: input.actor } : {}),
            summary: input.summary,
            ...(input.detail ? { detail: input.detail } : {}),
            at: nowIso,
          })
        }
      } else {
        const delayMs =
          policy.debounceMs !== undefined
            ? Math.max(0, policy.debounceMs)
            : ch.debounceSeconds * 1000
        const timer = setTimeout(() => flushKey(key), delayMs)
        timer.unref()
        pending.set(key, {
          channelId: ch.id,
          event: input.event,
          collectionId: input.collectionId,
          collectionTitle: input.collectionTitle,
          items: [
            {
              ...(input.actor ? { actor: input.actor } : {}),
              summary: input.summary,
              ...(input.detail ? { detail: input.detail } : {}),
              at: nowIso,
            },
          ],
          mergedCount: 1,
          totalFiles: input.fileCount || 0,
          timer,
        })
      }
    }
  }

  function checkDeadlines(force = false): number {
    if (stopped) return 0
    const cfg = readConfig(store)
    if (!cfg.channels.some((c) => c.enabled && c.events.includes('collection.deadline_soon'))) {
      return 0
    }
    const today = localDate()
    const tomorrow = localDate(new Date(Date.now() + 24 * 60 * 60 * 1000))
    const notifiedRaw = store.get('webhooks.deadlineNotified')
    let notified: Record<string, string> = {}
    if (notifiedRaw) {
      try {
        notified = JSON.parse(notifiedRaw) as Record<string, string>
      } catch {
        notified = {}
      }
    }
    const active = store.collections().filter((c) => !c.archivedAt && c.status === 'active')
    let emitted = 0
    const now = Date.now()
    for (const c of active) {
      if (isExpired(c, now)) continue
      if (c.deadline !== today && c.deadline !== tomorrow) continue
      const marker = `${c.id}:${c.deadline}`
      if (!force && notified[marker]) continue
      let detail = `已收 ${c.received} / 目标 ${c.target} 份，截止 ${c.deadline} 23:59`
      if (c.materials?.length) {
        const prog = materialProgress(c, store.collectionFiles(c.id, false))
        detail = `必需材料已收齐 ${prog.received}/${prog.total} 人，核对通过 ${prog.reviewed} 人，截止 ${c.deadline} 23:59`
      }
      emit({
        event: 'collection.deadline_soon',
        collectionId: c.id,
        collectionTitle: c.title,
        summary: `「${c.title}」即将于 ${c.deadline} 截止`,
        detail,
      })
      notified[marker] = new Date(now).toISOString()
      emitted++
    }
    if (emitted > 0) {
      // Prune stale markers older than 30 days
      const cutoff = now - 30 * 24 * 60 * 60 * 1000
      for (const [k, v] of Object.entries(notified)) {
        if (Date.parse(v) < cutoff) delete notified[k]
      }
      store.set('webhooks.deadlineNotified', JSON.stringify(notified))
    }
    return emitted
  }

  const deadlineTimer = setInterval(
    () => {
      try {
        checkDeadlines(false)
      } catch {
        /* Ignore periodic deadline scan errors. */
      }
    },
    Math.max(1000, policy.deadlineIntervalMs ?? 30 * 60 * 1000),
  )
  deadlineTimer.unref()

  // Admin-only HTTP API (enforced by app.ts onRequest for /api/webhooks*)
  app.get('/api/webhooks', async () => {
    const cfg = readConfig(store)
    const keyReady = secretKeyReady(store)
    return {
      channels: cfg.channels.map((ch) => toPublicChannel(ch, keyReady)),
      logs: readLogs(store),
    }
  })

  app.post('/api/webhooks', async (req, reply) => {
    const body = object(req.body)
    const cfg = readConfig(store)
    if (cfg.channels.length >= MAX_CHANNELS) {
      throw new HttpError(400, `最多配置 ${MAX_CHANNELS} 个通知渠道`)
    }
    const type = String(body.type || '') as WebhookChannelType
    if (!CHANNEL_TYPES.includes(type)) throw new HttpError(400, '通知渠道类型无效')
    const name = text(body.name, '渠道名称', 40)
    const url = validateWebhookUrl(String(body.url || ''))
    const rawSecret =
      body.secret === undefined || body.secret === '' ? '' : text(body.secret, '加签密钥', 512)
    const events = parseEvents(body.events)
    const debounceSeconds = parseDebounceSeconds(body.debounceSeconds, DEFAULT_DEBOUNCE_SECONDS)
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled)
    const nowIso = new Date().toISOString()
    const channel: StoredWebhookChannel = {
      id: randomUUID(),
      name,
      type,
      enabled,
      encryptedUrl: encrypt(store, url.toString()),
      urlHostHint: maskWebhookUrl(url),
      ...(rawSecret ? { encryptedSecret: encrypt(store, rawSecret) } : {}),
      events,
      debounceSeconds,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    store.transaction(() => {
      writeConfig(store, { channels: [channel, ...cfg.channels] })
      store.activity(`新增通知渠道「${channel.name}」`)
    })
    reply.code(201)
    return {
      channel: toPublicChannel(channel, secretKeyReady(store)),
    }
  })

  app.patch('/api/webhooks/:id', async (req) => {
    const id = String(object(req.params).id)
    const body = object(req.body)
    const cfg = readConfig(store)
    const index = cfg.channels.findIndex((c) => c.id === id)
    if (index < 0) throw new HttpError(404, '通知渠道不存在')
    const current = cfg.channels[index]

    const type = body.type === undefined ? current.type : (String(body.type) as WebhookChannelType)
    if (!CHANNEL_TYPES.includes(type)) throw new HttpError(400, '通知渠道类型无效')
    const name = body.name === undefined ? current.name : text(body.name, '渠道名称', 40)
    const events = body.events === undefined ? current.events : parseEvents(body.events)
    const debounceSeconds = parseDebounceSeconds(body.debounceSeconds, current.debounceSeconds)
    const enabled = body.enabled === undefined ? current.enabled : Boolean(body.enabled)

    let encryptedUrl = current.encryptedUrl
    let urlHostHint = current.urlHostHint
    if (body.url !== undefined && String(body.url).trim() !== '') {
      const url = validateWebhookUrl(String(body.url))
      encryptedUrl = encrypt(store, url.toString())
      urlHostHint = maskWebhookUrl(url)
    }

    let encryptedSecret = current.encryptedSecret
    if (body.clearSecret === true) {
      encryptedSecret = undefined
    } else if (body.secret !== undefined && String(body.secret) !== '') {
      encryptedSecret = encrypt(store, text(body.secret, '加签密钥', 512))
    }

    const updated: StoredWebhookChannel = {
      ...current,
      name,
      type,
      enabled,
      encryptedUrl,
      urlHostHint,
      ...(encryptedSecret ? { encryptedSecret } : {}),
      events,
      debounceSeconds,
      updatedAt: new Date().toISOString(),
    }
    if (!encryptedSecret) delete updated.encryptedSecret

    const nextChannels = [...cfg.channels]
    nextChannels[index] = updated
    store.transaction(() => {
      writeConfig(store, { channels: nextChannels })
      store.activity(`更新了通知渠道「${updated.name}」`)
    })
    return {
      channel: toPublicChannel(updated, secretKeyReady(store)),
    }
  })

  app.delete('/api/webhooks/:id', async (req) => {
    const id = String(object(req.params).id)
    const cfg = readConfig(store)
    const existing = cfg.channels.find((c) => c.id === id)
    if (!existing) throw new HttpError(404, '通知渠道不存在')
    for (const [key, agg] of pending) {
      if (agg.channelId === id) {
        clearTimeout(agg.timer)
        pending.delete(key)
      }
    }
    store.transaction(() => {
      writeConfig(store, { channels: cfg.channels.filter((c) => c.id !== id) })
      store.activity(`删除了通知渠道「${existing.name}」`)
    })
    return { ok: true }
  })

  app.post(
    '/api/webhooks/:id/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const id = String(object(req.params).id)
      const cfg = readConfig(store)
      const channel = cfg.channels.find((c) => c.id === id)
      if (!channel) throw new HttpError(404, '通知渠道不存在')
      const nowIso = new Date().toISOString()
      const payload: WebhookDeliveryPayload = {
        deliveryId: randomUUID(),
        event: 'test',
        mergedCount: 1,
        summary: `这是来自集屿工作台「${store.get('displayName') || '管理员'}」的测试通知，渠道连接正常。`,
        items: [
          {
            summary: `渠道「${channel.name}」测试成功`,
            detail: `已订阅：${channel.events.map((e) => WEBHOOK_EVENT_LABELS[e]).join('、')}`,
            at: nowIso,
          },
        ],
      }
      const log = await deliverNow(channel, payload, 1)
      if (log.status !== 'succeeded') {
        reply.code(502)
        return { ok: false, error: log.error || '测试通知发送失败', log }
      }
      return { ok: true, log }
    },
  )

  app.post(
    '/api/webhooks/deadline-digest',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async () => {
      const count = checkDeadlines(true)
      return { triggered: count }
    },
  )

  return {
    emit,
    checkDeadlines,
    async flushPending() {
      for (const key of [...pending.keys()]) flushKey(key)
      if (draining) await draining
    },
    async stop() {
      stopped = true
      clearInterval(deadlineTimer)
      for (const agg of pending.values()) clearTimeout(agg.timer)
      pending.clear()
      queue.length = 0
      controller.abort()
      if (draining) await draining.catch(() => {})
    },
  }
}
