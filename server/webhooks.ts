import type { FastifyInstance } from 'fastify'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import type {
  Collection,
  WebhookChannel,
  WebhookChannelType,
  WebhookEventType,
  WebhookLog,
  WebhookRemindDelivery,
  WebhookRemindResult,
} from '../src/types.ts'
import { materialParticipants } from '../src/lib/materials.ts'
import { collectionParticipants } from '../src/lib/participants.ts'
import { maskIdentifier } from '../src/lib/reminder.ts'
import { isBidiControlCode, isControlCode } from '../src/lib/text-safety.ts'
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
const DEFAULT_MAX_QUEUE_PER_CHANNEL = 50
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
  maxQueuePerChannel?: number
  now?: () => number
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
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
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
    .replace(
      /\b(access_token|api_key|apikey|bot_token|auth_token|token|key|secret|sign|password)=[^&\s]+/gi,
      '$1=[已脱敏]',
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已脱敏]')
    .slice(0, 200)
}

export function sanitizeWebhookPlainText(value: string): string {
  let cleaned = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (isControlCode(code, true) || code === 0x2028 || code === 0x2029) {
      cleaned += ' '
    } else if (!isBidiControlCode(code)) {
      cleaned += value[i]
    }
  }
  return cleaned
    .replace(/<\s*\/?\s*at\b[^>]*>/gi, '')
    .replace(/<\s*@[^>]*>/gi, '')
    .replaceAll('<', '＜')
    .replaceAll('>', '＞')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1（$2）')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1（$2）')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function sanitizeWebhookMarkdown(value: string): string {
  return sanitizeWebhookPlainText(value).replace(/([\\[\]()*_`~#])/g, '\\$1')
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
  const safePlainTitle = payload.collectionTitle
    ? sanitizeWebhookPlainText(payload.collectionTitle)
    : ''
  const safeMdTitle = payload.collectionTitle
    ? sanitizeWebhookMarkdown(payload.collectionTitle)
    : ''
  const title = safePlainTitle
    ? `【集屿 · ${eventLabel}】${safePlainTitle}`
    : `【集屿 · ${eventLabel}】`
  const mdTitle = safeMdTitle
    ? `【集屿 · ${eventLabel}】${safeMdTitle}`
    : `【集屿 · ${eventLabel}】`
  const plainSummary = sanitizeWebhookPlainText(payload.summary)
  const mdSummary = sanitizeWebhookMarkdown(payload.summary)
  const visibleItems = payload.items.slice(0, 8)
  const plainDetailLines = visibleItems.map((item) => {
    const parts = [item.summary, item.detail]
      .filter((p): p is string => Boolean(p))
      .map((p) => sanitizeWebhookPlainText(p))
      .filter(Boolean)
      .join(' — ')
    return `- ${parts}`
  })
  const mdDetailLines = visibleItems.map((item) => {
    const parts = [item.summary, item.detail]
      .filter((p): p is string => Boolean(p))
      .map((p) => sanitizeWebhookMarkdown(p))
      .filter(Boolean)
      .join(' — ')
    return `- ${parts}`
  })
  if (payload.mergedCount > visibleItems.length) {
    const extraLine = `- 另有 ${payload.mergedCount - visibleItems.length} 条记录已聚合`
    plainDetailLines.push(extraLine)
    mdDetailLines.push(extraLine)
  }
  const plain = [title, plainSummary, ...plainDetailLines, `时间：${timeText}（UTC+8）`].join('\n')
  const markdown = [
    `### ${mdTitle}`,
    `> ${mdSummary}`,
    '',
    ...mdDetailLines,
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
    'User-Agent': 'Jiyu-Webhook/0.5.0',
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

function channelKeyReady(store: Store, ch: StoredWebhookChannel): boolean {
  if (!secretKeyReady(store)) return false
  try {
    decrypt(store, ch.encryptedUrl)
    if (ch.encryptedSecret) decrypt(store, ch.encryptedSecret)
    return true
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
  deadlineMarker?: string
  deadlineCollection?: { collectionId: string; deadline: string }
  timer: ReturnType<typeof setTimeout>
}

interface DeliveryJob {
  channelId: string
  payload: WebhookDeliveryPayload
  deadlineMarker?: string
  deadlineCollection?: { collectionId: string; deadline: string }
}

const MAX_DIGEST_NAMES = 20

function formatDigestPerson(identity: string, owner: string, desensitize: boolean): string {
  const cleanId = identity.trim()
  const cleanOwner = owner.trim()
  const idLabel = desensitize ? maskIdentifier(cleanId) : cleanId
  if (!cleanOwner || cleanOwner === cleanId) return idLabel
  const ownerLabel = desensitize ? maskIdentifier(cleanOwner) : cleanOwner
  return `${idLabel}（${ownerLabel}）`
}

function joinDigestNames(names: string[]): string {
  if (!names.length) return ''
  const visible = names.slice(0, MAX_DIGEST_NAMES).join('、')
  return names.length > MAX_DIGEST_NAMES ? `${visible} 等 ${names.length} 人` : visible
}

export interface CollectionReminderDigest {
  summary: string
  detail: string
  receivedCount: number
  totalCount: number
  missingCount: number
  needsChangesCount: number
  missingNames: string[]
}

export function buildCollectionReminderDigest(
  store: Store,
  c: Collection,
  options: { desensitizeNames: boolean; nowMs?: number },
): CollectionReminderDigest {
  const { desensitizeNames } = options
  const activeFiles = store.collectionFiles(c.id, false)

  if (c.materials?.length) {
    const people = materialParticipants(c, activeFiles)
    const roster = c.expectedSubmitters?.length ? people.filter((p) => p.expected) : people
    const receivedCount = roster.filter((p) => p.receivedComplete).length
    const reviewedCount = roster.filter((p) => p.reviewComplete).length
    const missingPeople = roster.filter((p) => !p.receivedComplete)
    const needsChangesPeople = people.filter((p) => p.status === 'needs_changes')
    const missingNames = missingPeople.map((p) =>
      formatDigestPerson(p.identity, p.owner, desensitizeNames),
    )
    const needsChangesNames = needsChangesPeople.map((p) =>
      formatDigestPerson(p.identity, p.owner, desensitizeNames),
    )
    const summary = `「${c.title}」催交摘要：必需材料已收齐 ${receivedCount}/${roster.length} 人，缺交 ${missingPeople.length} 人${needsChangesPeople.length ? `，退回需补充 ${needsChangesPeople.length} 人` : ''}（截止 ${c.deadline} 23:59）`
    const detailParts = [`核对通过 ${reviewedCount} 人`]
    if (missingNames.length) {
      detailParts.push(`缺交名单（${missingNames.length} 人）：${joinDigestNames(missingNames)}`)
    } else if (roster.length) {
      detailParts.push('应交人员必需材料均已收齐')
    }
    if (needsChangesNames.length) {
      detailParts.push(
        `退回需补充（${needsChangesNames.length} 人）：${joinDigestNames(needsChangesNames)}`,
      )
    }
    return {
      summary,
      detail: detailParts.join('；'),
      receivedCount,
      totalCount: roster.length,
      missingCount: missingPeople.length,
      needsChangesCount: needsChangesPeople.length,
      missingNames,
    }
  }

  const people = collectionParticipants(c, activeFiles)
  if (c.expectedSubmitters?.length) {
    const roster = people.filter((p) => p.expected)
    const receivedCount = roster.filter((p) => p.fileIds.length > 0).length
    const missingPeople = roster.filter((p) => !p.fileIds.length)
    const missingNames = missingPeople.map((p) =>
      formatDigestPerson(p.identity, p.owner, desensitizeNames),
    )
    const summary = `「${c.title}」催交摘要：已提交 ${receivedCount}/${roster.length} 人，缺交 ${missingPeople.length} 人（截止 ${c.deadline} 23:59）`
    const detailParts = [`有效文件 ${activeFiles.length} 份`]
    if (missingNames.length) {
      detailParts.push(`缺交名单（${missingNames.length} 人）：${joinDigestNames(missingNames)}`)
    } else {
      detailParts.push('应交名单内人员均已提交')
    }
    return {
      summary,
      detail: detailParts.join('；'),
      receivedCount,
      totalCount: roster.length,
      missingCount: missingPeople.length,
      needsChangesCount: 0,
      missingNames,
    }
  }

  const submittedPeople = people.filter((p) => p.fileIds.length > 0).length
  const missingCount = Math.max(0, c.target - activeFiles.length)
  return {
    summary: `「${c.title}」催交摘要：已收 ${activeFiles.length}/${c.target} 份（${submittedPeople} 人已提交，截止 ${c.deadline} 23:59）`,
    detail: `累计提交 ${c.received} 份，有效文件 ${activeFiles.length} 份，距离目标还差 ${missingCount} 份`,
    receivedCount: submittedPeople,
    totalCount: c.target,
    missingCount,
    needsChangesCount: 0,
    missingNames: [],
  }
}

function resolveDeadlineIntervalMs(policy: WebhookPolicy): number {
  if (policy.deadlineIntervalMs !== undefined) {
    return Math.max(100, policy.deadlineIntervalMs)
  }
  const envRaw = process.env.JIYU_DEADLINE_CHECK_INTERVAL_SECONDS
  if (envRaw && envRaw.trim()) {
    const parsed = Number(envRaw)
    if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 86400) {
      return Math.trunc(parsed) * 1000
    }
  }
  return 5 * 60 * 1000
}

function buildAggregatedSummary(agg: PendingAggregate): string {
  const safeTitle = agg.collectionTitle ? sanitizeWebhookPlainText(agg.collectionTitle) : ''
  const titlePrefix = safeTitle ? `「${safeTitle}」` : ''
  if (agg.mergedCount === 1) return agg.items[0]?.summary || `${titlePrefix}收到新事件`
  if (agg.event === 'submission.created') {
    const actors = [
      ...new Set(
        agg.items
          .map((i) => (i.actor ? sanitizeWebhookPlainText(i.actor) : ''))
          .filter((a): a is string => Boolean(a)),
      ),
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
  const nowFn = policy.now ?? (() => Date.now())
  const maxAttempts = Math.max(1, Math.min(5, policy.maxAttempts ?? 3))
  const retryBaseMs = Math.max(10, policy.retryBaseMs ?? 2000)
  const maxQueuePerChannel = Math.max(
    1,
    Math.min(200, policy.maxQueuePerChannel ?? DEFAULT_MAX_QUEUE_PER_CHANNEL),
  )
  const controller = new AbortController()
  let stopped = false
  let deadlineScanActive = false

  const pending = new Map<string, PendingAggregate>()
  const channelQueues = new Map<string, DeliveryJob[]>()
  const channelDrainers = new Map<string, Promise<void>>()
  const inFlightDeadlines = new Set<string>()

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

  function readDeadlineNotified(): Record<string, string> {
    const raw = store.get('webhooks.deadlineNotified')
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {}
    } catch {
      return {}
    }
  }

  function markDeadlineNotified(marker: string) {
    if (stopped) return
    const notified = readDeadlineNotified()
    const now = nowFn()
    notified[marker] = new Date(now).toISOString()
    const cutoff = now - 30 * 24 * 60 * 60 * 1000
    for (const [k, v] of Object.entries(notified)) {
      if (Date.parse(v) < cutoff) delete notified[k]
    }
    store.set('webhooks.deadlineNotified', JSON.stringify(notified))
  }

  function markCollectionDeadlineSent(collectionId: string, deadline: string) {
    if (stopped) return
    const cfg = readConfig(store)
    const eligibleChannels = cfg.channels.filter(
      (ch) => ch.enabled && ch.events.includes('collection.deadline_soon'),
    )
    const notified = readDeadlineNotified()
    const allDelivered =
      eligibleChannels.length > 0 &&
      eligibleChannels.every((ch) => Boolean(notified[`${ch.id}:${collectionId}:${deadline}`]))
    if (!allDelivered) return
    store.transaction(() => {
      const latest = store.collection(collectionId)
      if (!latest || latest.deadline !== deadline || !latest.deadlineReminder?.enabled) return
      if (latest.deadlineReminder.lastSentDeadline === deadline) return
      store.saveCollection({
        ...latest,
        deadlineReminder: {
          ...latest.deadlineReminder,
          lastSentDeadline: deadline,
          lastSentAt: new Date(nowFn()).toISOString(),
        },
      })
    })
  }

  function startChannelDrain(channelId: string) {
    if (stopped || channelDrainers.has(channelId)) return
    const drainer = (async () => {
      try {
        while (!stopped) {
          const q = channelQueues.get(channelId)
          if (!q || q.length === 0) break
          const job = q.shift()!
          try {
            const cfg = readConfig(store)
            const ch = cfg.channels.find((c) => c.id === channelId)
            if (
              !ch ||
              !ch.enabled ||
              (job.payload.event !== 'test' && !ch.events.includes(job.payload.event))
            ) {
              continue
            }
            const log = await deliverNow(ch, job.payload, maxAttempts)
            if (log.status === 'succeeded' && !stopped) {
              if (job.deadlineMarker) markDeadlineNotified(job.deadlineMarker)
              if (job.deadlineCollection) {
                markCollectionDeadlineSent(
                  job.deadlineCollection.collectionId,
                  job.deadlineCollection.deadline,
                )
              }
            }
          } finally {
            if (job.deadlineMarker) inFlightDeadlines.delete(job.deadlineMarker)
          }
        }
      } finally {
        channelDrainers.delete(channelId)
        const remaining = channelQueues.get(channelId)
        if (remaining && remaining.length === 0) channelQueues.delete(channelId)
        if (!stopped && remaining && remaining.length > 0) startChannelDrain(channelId)
      }
    })()
    channelDrainers.set(channelId, drainer)
  }

  function enqueueJob(channelId: string, job: DeliveryJob) {
    let q = channelQueues.get(channelId)
    if (!q) {
      q = []
      channelQueues.set(channelId, q)
    }
    if (q.length >= maxQueuePerChannel) {
      const dropped = q.shift()!
      if (dropped.deadlineMarker) inFlightDeadlines.delete(dropped.deadlineMarker)
      const ch = readConfig(store).channels.find((c) => c.id === channelId)
      app.log.warn(
        {
          channelId,
          event: dropped.payload.event,
          deliveryId: dropped.payload.deliveryId,
          targetHint: ch?.urlHostHint || '',
        },
        'webhook channel queue full; dropped oldest delivery',
      )
      if (!stopped && ch) {
        recordLog(store, {
          id: dropped.payload.deliveryId,
          channelId: ch.id,
          channelName: ch.name,
          channelType: ch.type,
          event: dropped.payload.event,
          ...(dropped.payload.collectionId ? { collectionId: dropped.payload.collectionId } : {}),
          status: 'failed',
          attempts: 0,
          mergedCount: dropped.payload.mergedCount,
          summary: sanitizeWebhookPlainText(dropped.payload.summary),
          error: '该渠道待投递队列已满，较早的通知已丢弃',
          targetHint: ch.urlHostHint,
          createdAt: new Date().toISOString(),
        })
      }
    }
    q.push(job)
    startChannelDrain(channelId)
  }

  function flushKey(key: string) {
    const agg = pending.get(key)
    if (!agg) return
    clearTimeout(agg.timer)
    pending.delete(key)
    if (stopped) {
      if (agg.deadlineMarker) inFlightDeadlines.delete(agg.deadlineMarker)
      return
    }
    const payload: WebhookDeliveryPayload = {
      deliveryId: randomUUID(),
      event: agg.event,
      collectionId: agg.collectionId,
      collectionTitle: agg.collectionTitle,
      mergedCount: agg.mergedCount,
      summary: buildAggregatedSummary(agg),
      items: agg.items,
    }
    enqueueJob(agg.channelId, {
      channelId: agg.channelId,
      payload,
      ...(agg.deadlineMarker ? { deadlineMarker: agg.deadlineMarker } : {}),
      ...(agg.deadlineCollection ? { deadlineCollection: agg.deadlineCollection } : {}),
    })
  }

  function emitToChannel(
    ch: StoredWebhookChannel,
    input: WebhookEmitInput,
    nowIso: string,
    deadlineMarker?: string,
    deadlineCollection?: { collectionId: string; deadline: string },
  ) {
    const key = `${ch.id}:${input.collectionId || 'global'}:${input.event}`
    const existing = pending.get(key)
    if (existing) {
      existing.mergedCount += 1
      existing.totalFiles += input.fileCount || 0
      if (deadlineMarker && !existing.deadlineMarker) existing.deadlineMarker = deadlineMarker
      if (deadlineCollection && !existing.deadlineCollection)
        existing.deadlineCollection = deadlineCollection
      if (existing.items.length < 20) {
        existing.items.push({
          ...(input.actor ? { actor: input.actor } : {}),
          summary: input.summary,
          ...(input.detail ? { detail: input.detail } : {}),
          at: nowIso,
        })
      }
      return
    }
    const delayMs =
      policy.debounceMs !== undefined ? Math.max(0, policy.debounceMs) : ch.debounceSeconds * 1000
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
      ...(deadlineMarker ? { deadlineMarker } : {}),
      ...(deadlineCollection ? { deadlineCollection } : {}),
      timer,
    })
  }

  function emit(input: WebhookEmitInput) {
    if (stopped) return
    const cfg = readConfig(store)
    const nowIso = new Date(nowFn()).toISOString()
    for (const ch of cfg.channels) {
      if (!ch.enabled || !ch.events.includes(input.event)) continue
      emitToChannel(ch, input, nowIso)
    }
  }

  function checkDeadlines(force = false): number {
    if (stopped || deadlineScanActive) return 0
    deadlineScanActive = true
    try {
      const cfg = readConfig(store)
      const eligibleChannels = cfg.channels.filter(
        (c) => c.enabled && c.events.includes('collection.deadline_soon'),
      )
      if (!eligibleChannels.length) return 0
      const notified = readDeadlineNotified()
      const active = store.collections().filter((c) => !c.archivedAt && c.status === 'active')
      let emitted = 0
      const now = nowFn()
      const nowIso = new Date(now).toISOString()
      for (const c of active) {
        const deadlineMs = new Date(`${c.deadline}T23:59:59.999+08:00`).getTime()
        const remainingMs = deadlineMs - now
        if (!Number.isFinite(deadlineMs) || remainingMs <= 0) continue

        const reminder = c.deadlineReminder
        if (reminder !== undefined) {
          if (!reminder.enabled) continue
          if (remainingMs > reminder.hoursBefore * 60 * 60 * 1000) continue
          if (!force && reminder.lastSentDeadline === c.deadline) continue
        } else if (remainingMs > 24 * 60 * 60 * 1000) {
          continue
        }

        const legacyMarker = `${c.id}:${c.deadline}`
        const targetChannels = eligibleChannels.filter((ch) => {
          const chMarker = `${ch.id}:${c.id}:${c.deadline}`
          if (force) return true
          if (inFlightDeadlines.has(chMarker)) return false
          if (notified[legacyMarker] || notified[chMarker]) return false
          return true
        })
        if (!targetChannels.length) continue

        const digest = buildCollectionReminderDigest(store, c, {
          desensitizeNames: reminder?.desensitizeNames ?? true,
          nowMs: now,
        })
        const deadlineCollection = reminder?.enabled
          ? { collectionId: c.id, deadline: c.deadline }
          : undefined

        for (const ch of targetChannels) {
          const chMarker = `${ch.id}:${c.id}:${c.deadline}`
          inFlightDeadlines.add(chMarker)
          emitToChannel(
            ch,
            {
              event: 'collection.deadline_soon',
              collectionId: c.id,
              collectionTitle: c.title,
              summary: digest.summary,
              detail: digest.detail,
            },
            nowIso,
            chMarker,
            deadlineCollection,
          )
        }
        emitted++
      }
      return emitted
    } finally {
      deadlineScanActive = false
    }
  }

  const deadlineTimer = setInterval(() => {
    try {
      checkDeadlines(false)
    } catch {
      /* Ignore periodic deadline scan errors. */
    }
  }, resolveDeadlineIntervalMs(policy))
  deadlineTimer.unref()

  // Admin-only HTTP API (enforced by app.ts onRequest for /api/webhooks*)
  app.get('/api/webhooks', async () => {
    const cfg = readConfig(store)
    return {
      channels: cfg.channels.map((ch) => toPublicChannel(ch, channelKeyReady(store, ch))),
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
      channel: toPublicChannel(channel, channelKeyReady(store, channel)),
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

    const typeChanged = type !== current.type
    let urlChanged = false
    let encryptedUrl = current.encryptedUrl
    let urlHostHint = current.urlHostHint
    if (body.url !== undefined && String(body.url).trim() !== '') {
      const url = validateWebhookUrl(String(body.url))
      const nextUrlStr = url.toString()
      try {
        urlChanged = decrypt(store, current.encryptedUrl) !== nextUrlStr
      } catch {
        urlChanged = true
      }
      encryptedUrl = encrypt(store, nextUrlStr)
      urlHostHint = maskWebhookUrl(url)
    }

    let encryptedSecret = current.encryptedSecret
    if (body.clearSecret === true) {
      encryptedSecret = undefined
    } else if (body.secret !== undefined && String(body.secret) !== '') {
      encryptedSecret = encrypt(store, text(body.secret, '加签密钥', 512))
    } else if (urlChanged || typeChanged) {
      // 更换目标地址或平台类型时若未提供新密钥，强制清空旧加签密钥，严禁跨目标复用
      encryptedSecret = undefined
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

    for (const [key, agg] of pending) {
      if (agg.channelId === id && (!updated.enabled || !updated.events.includes(agg.event))) {
        clearTimeout(agg.timer)
        pending.delete(key)
        if (agg.deadlineMarker) inFlightDeadlines.delete(agg.deadlineMarker)
      }
    }
    const queued = channelQueues.get(id)
    if (queued) {
      for (let i = queued.length - 1; i >= 0; i--) {
        const job = queued[i]
        if (
          !updated.enabled ||
          (job.payload.event !== 'test' && !updated.events.includes(job.payload.event))
        ) {
          if (job.deadlineMarker) inFlightDeadlines.delete(job.deadlineMarker)
          queued.splice(i, 1)
        }
      }
      if (queued.length === 0) channelQueues.delete(id)
    }

    return {
      channel: toPublicChannel(updated, channelKeyReady(store, updated)),
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
        if (agg.deadlineMarker) inFlightDeadlines.delete(agg.deadlineMarker)
      }
    }
    const queued = channelQueues.get(id)
    if (queued) {
      for (const job of queued) {
        if (job.deadlineMarker) inFlightDeadlines.delete(job.deadlineMarker)
      }
      channelQueues.delete(id)
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

  // Admin & Editor endpoint (viewer blocked by app.ts onRequest write guard; CSRF + Origin enforced)
  app.post(
    '/api/collections/:id/remind-webhook',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const id = String(object(req.params).id)
      const c = store.collection(id)
      if (!c) throw new HttpError(404, '没有找到这项收集')
      if (c.archivedAt) throw new HttpError(409, '该任务已归档，无法推送催交摘要')
      const body = req.body ? object(req.body) : {}
      if (body.desensitizeNames !== undefined && typeof body.desensitizeNames !== 'boolean') {
        throw new HttpError(400, '缺交名单脱敏参数无效')
      }
      const desensitizeNames =
        body.desensitizeNames !== undefined
          ? Boolean(body.desensitizeNames)
          : (c.deadlineReminder?.desensitizeNames ?? true)
      const cfg = readConfig(store)
      const targetChannels = cfg.channels.filter(
        (ch) => ch.enabled && ch.events.includes('collection.deadline_soon'),
      )
      if (!targetChannels.length) {
        throw new HttpError(
          400,
          '尚未启用订阅「临近截止汇总」的 Webhook 渠道，请先在设置 → 事件通知中配置并启用',
        )
      }
      const nowMs = nowFn()
      const nowIso = new Date(nowMs).toISOString()
      const digest = buildCollectionReminderDigest(store, c, { desensitizeNames, nowMs })
      const logs = await Promise.all(
        targetChannels.map((ch) =>
          deliverNow(
            ch,
            {
              deliveryId: randomUUID(),
              event: 'collection.deadline_soon',
              collectionId: c.id,
              collectionTitle: c.title,
              mergedCount: 1,
              summary: digest.summary,
              items: [{ summary: digest.summary, detail: digest.detail, at: nowIso }],
            },
            1,
          ),
        ),
      )
      const deliveries: WebhookRemindDelivery[] = logs.map((log) => ({
        channelId: log.channelId,
        channelName: log.channelName,
        channelType: log.channelType,
        status: log.status,
        ...(log.httpStatus !== undefined ? { httpStatus: log.httpStatus } : {}),
        ...(log.error ? { error: log.error } : {}),
        targetHint: log.targetHint,
      }))
      const succeeded = deliveries.filter((d) => d.status === 'succeeded').length
      const failed = deliveries.length - succeeded
      store.activity(
        `手动向 Webhook 推送「${c.title}」催交摘要（成功 ${succeeded}/${deliveries.length} 个渠道）`,
      )
      const result: WebhookRemindResult = {
        ok: succeeded > 0,
        totalChannels: deliveries.length,
        succeeded,
        failed,
        summary: digest.summary,
        stats: {
          receivedCount: digest.receivedCount,
          totalCount: digest.totalCount,
          missingCount: digest.missingCount,
          needsChangesCount: digest.needsChangesCount,
        },
        deliveries,
        ...(succeeded === 0
          ? {
              error:
                deliveries.find((d) => d.error)?.error ||
                '全部通知渠道投递失败，请前往设置 → 事件通知查看日志',
            }
          : {}),
      }
      if (succeeded === 0) reply.code(502)
      return result
    },
  )

  return {
    emit,
    checkDeadlines,
    async flushPending() {
      for (const key of [...pending.keys()]) flushKey(key)
      while (channelDrainers.size > 0) {
        await Promise.all([...channelDrainers.values()])
      }
    },
    async stop() {
      stopped = true
      clearInterval(deadlineTimer)
      for (const agg of pending.values()) clearTimeout(agg.timer)
      pending.clear()
      channelQueues.clear()
      inFlightDeadlines.clear()
      controller.abort()
      await Promise.allSettled([...channelDrainers.values()])
    },
  }
}
