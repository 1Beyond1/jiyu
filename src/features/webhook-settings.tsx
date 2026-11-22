import { useCallback, useEffect, useState } from 'react'
import { BellRing, Check, Clock, Pencil, Plus, RefreshCw, Send, Trash2 } from 'lucide-react'
import { Modal } from '../components/ui'
import { api } from '../lib/api'
import { formatDate } from '../lib/workspace'
import type {
  WebhookChannel,
  WebhookChannelType,
  WebhookEventType,
  WebhookLog,
  WebhookState,
} from '../types'

const CHANNEL_META: Record<
  WebhookChannelType,
  { label: string; urlPlaceholder: string; secretHint: string }
> = {
  feishu: {
    label: '飞书机器人',
    urlPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
    secretHint: '选填：若飞书机器人开启了「签名校验」，请填入加签密钥（AES-GCM 加密保存）。',
  },
  dingtalk: {
    label: '钉钉加签机器人',
    urlPlaceholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
    secretHint: '推荐填写：钉钉安全设置中的「加签」SEC 密钥，发送时自动计算 HMAC-SHA256 签名。',
  },
  wecom: {
    label: '企业微信机器人',
    urlPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
    secretHint: '企业微信机器人通过 Webhook URL 中的 key 鉴权，此处可留空。',
  },
  generic: {
    label: '通用 HMAC Webhook',
    urlPlaceholder: 'https://hooks.example.com/jiyu',
    secretHint: '选填：填写后将在请求头附带 X-Jiyu-Timestamp 与 X-Jiyu-Signature（sha256=HMAC）。',
  },
}

const EVENT_OPTIONS: { id: WebhookEventType; label: string; hint: string }[] = [
  { id: 'submission.created', label: '新提交提醒', hint: '提交人上传或管理员补录文件后触发' },
  { id: 'review.accepted', label: '审核通过提醒', hint: '材料人工核对标记通过后触发' },
  { id: 'review.needs_changes', label: '审核退回提醒', hint: '材料标记需补充或纠正后触发' },
  {
    id: 'collection.deadline_soon',
    label: '临近截止汇总',
    hint: '活跃任务在截止前 24 小时内自动推送进度摘要',
  },
]

const EVENT_LABELS: Record<WebhookEventType | 'test', string> = {
  'submission.created': '新提交',
  'review.accepted': '审核通过',
  'review.needs_changes': '审核退回',
  'collection.deadline_soon': '临近截止',
  test: '测试通知',
}

interface EditorState {
  editing?: WebhookChannel
  name: string
  type: WebhookChannelType
  url: string
  secret: string
  clearSecret: boolean
  events: WebhookEventType[]
  debounceSeconds: number
  enabled: boolean
}

function defaultEditor(editing?: WebhookChannel): EditorState {
  if (!editing) {
    return {
      name: '',
      type: 'feishu',
      url: '',
      secret: '',
      clearSecret: false,
      events: ['submission.created', 'review.needs_changes', 'collection.deadline_soon'],
      debounceSeconds: 60,
      enabled: true,
    }
  }
  return {
    editing,
    name: editing.name,
    type: editing.type,
    url: '',
    secret: '',
    clearSecret: false,
    events: [...editing.events],
    debounceSeconds: editing.debounceSeconds,
    enabled: editing.enabled,
  }
}

export function WebhookSettingsPanel() {
  const [state, setState] = useState<WebhookState | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<WebhookChannel | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setLoading(true)
    try {
      const data = await api<WebhookState>('/api/webhooks')
      setState(data)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (manual) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function saveChannel(e: React.FormEvent) {
    e.preventDefault()
    if (!editor || saving) return
    if (!editor.name.trim()) {
      setEditorError('请填写渠道名称。')
      return
    }
    if (!editor.editing && !editor.url.trim()) {
      setEditorError('请填写完整的公网 HTTPS Webhook 地址。')
      return
    }
    if (!editor.events.length) {
      setEditorError('请至少勾选一项订阅事件。')
      return
    }
    setSaving(true)
    setEditorError('')
    try {
      const payload = {
        name: editor.name.trim(),
        type: editor.type,
        ...(editor.url.trim() ? { url: editor.url.trim() } : {}),
        ...(editor.clearSecret
          ? { clearSecret: true }
          : editor.secret.trim()
            ? { secret: editor.secret.trim() }
            : {}),
        events: editor.events,
        debounceSeconds: editor.debounceSeconds,
        enabled: editor.enabled,
      }
      if (editor.editing) {
        await api(`/api/webhooks/${encodeURIComponent(editor.editing.id)}`, 'PATCH', payload)
        setNotice(`已更新通知渠道「${editor.name.trim()}」`)
      } else {
        await api('/api/webhooks', 'POST', payload)
        setNotice(`已新增通知渠道「${editor.name.trim()}」`)
      }
      setEditor(null)
      await load()
    } catch (err) {
      setEditorError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function sendTest(ch: WebhookChannel) {
    setBusyId(ch.id)
    setError('')
    setNotice('')
    try {
      await api<{ ok: boolean; log: WebhookLog }>(
        `/api/webhooks/${encodeURIComponent(ch.id)}/test`,
        'POST',
        {},
      )
      setNotice(`已向「${ch.name}」发送测试通知，对方已接收。`)
      await load()
    } catch (err) {
      setError(`「${ch.name}」测试发送失败：${(err as Error).message}`)
      await load()
    } finally {
      setBusyId('')
    }
  }

  async function toggleEnabled(ch: WebhookChannel) {
    setBusyId(ch.id)
    setError('')
    setNotice('')
    try {
      await api(`/api/webhooks/${encodeURIComponent(ch.id)}`, 'PATCH', { enabled: !ch.enabled })
      setNotice(`已${ch.enabled ? '停用' : '启用'}「${ch.name}」`)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId('')
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyId(deleting.id)
    setError('')
    setNotice('')
    try {
      await api(`/api/webhooks/${encodeURIComponent(deleting.id)}`, 'DELETE')
      setNotice(`已删除通知渠道「${deleting.name}」`)
      setDeleting(null)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId('')
    }
  }

  async function triggerDigest() {
    setBusyId('digest')
    setError('')
    setNotice('')
    try {
      const res = await api<{ triggered: number }>('/api/webhooks/deadline-digest', 'POST', {})
      setNotice(
        res.triggered > 0
          ? `已将 ${res.triggered} 项临近截止任务加入推送队列（将在聚合窗口后投递）。`
          : '当前没有 24 小时内即将截止的进行中任务，或未启用临近截止订阅。',
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId('')
    }
  }

  return (
    <section id="settings-webhooks" tabIndex={-1} className="settings-panel full webhook-panel">
      <div className="section-heading">
        <div>
          <h2>
            <BellRing size={18} />
            事件通知（Webhook）
          </h2>
          <p>
            支持飞书、钉钉加签、企业微信与通用 HMAC Webhook。同任务默认 60 秒聚合防刷屏，URL
            与加签密钥均以 AES-GCM 加密存储，绝不回传明文。
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={loading || busyId !== ''}
            onClick={() => void load(true)}
          >
            <RefreshCw size={14} />
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className="button"
            disabled={busyId !== ''}
            onClick={() => void triggerDigest()}
          >
            <Clock size={14} />
            临近截止汇总
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busyId !== '' || (state?.channels.length ?? 0) >= 10}
            onClick={() => {
              setEditor(defaultEditor())
              setEditorError('')
            }}
          >
            <Plus size={15} />
            新增渠道
          </button>
        </div>
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-text" role="status">
          {notice}
        </p>
      )}

      {!state ? (
        <p className="muted" role="status">
          正在读取通知渠道与投递日志…
        </p>
      ) : (
        <>
          {state.channels.length ? (
            <div className="webhook-channel-list">
              {state.channels.map((ch) => (
                <article className="webhook-channel-card" key={ch.id}>
                  <div className="webhook-channel-main">
                    <div className="webhook-channel-head">
                      <strong>{ch.name}</strong>
                      <span className="webhook-type-pill">{CHANNEL_META[ch.type].label}</span>
                      <span className={`status ${ch.enabled ? 'active' : 'neutral'}`}>
                        <i />
                        {ch.enabled ? '已启用' : '已停用'}
                      </span>
                      {ch.hasSecret && <span className="webhook-meta-pill">已配置加签密钥</span>}
                      {!ch.keyReady && (
                        <span className="webhook-meta-pill warn">主密钥缺失，请重新填写</span>
                      )}
                    </div>
                    <p className="webhook-url-hint">
                      <code>{ch.urlHint}</code>
                      <span>· 同任务 {ch.debounceSeconds} 秒聚合</span>
                    </p>
                    <div className="webhook-event-pills">
                      {ch.events.map((ev) => (
                        <span key={ev}>{EVENT_LABELS[ev]}</span>
                      ))}
                    </div>
                  </div>
                  <div className="button-row webhook-channel-actions">
                    <button
                      type="button"
                      className="button"
                      disabled={busyId !== '' || !ch.keyReady}
                      onClick={() => void sendTest(ch)}
                    >
                      <Send size={14} />
                      {busyId === ch.id ? '发送中…' : '发送测试'}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busyId !== ''}
                      onClick={() => void toggleEnabled(ch)}
                    >
                      {ch.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busyId !== ''}
                      onClick={() => {
                        setEditor(defaultEditor(ch))
                        setEditorError('')
                      }}
                    >
                      <Pencil size={14} />
                      编辑
                    </button>
                    <button
                      type="button"
                      className="button danger"
                      disabled={busyId !== ''}
                      onClick={() => setDeleting(ch)}
                      aria-label={`删除渠道 ${ch.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="form-note">
              暂未配置事件通知渠道。新增飞书、钉钉、企业微信或通用 Webhook
              后，新提交、审核退回/通过及临近截止任务将自动聚合推送到群聊。
            </div>
          )}

          <details className="webhook-logs" open={state.logs.length > 0}>
            <summary>近期投递日志（脱敏保留最近 {state.logs.length} / 50 条）</summary>
            {state.logs.length ? (
              <div className="webhook-log-list">
                {state.logs.map((log) => (
                  <div className={`webhook-log-row ${log.status}`} key={log.id}>
                    <div className="webhook-log-top">
                      <span
                        className={`status ${log.status === 'succeeded' ? 'active' : 'expired'}`}
                      >
                        <i />
                        {log.status === 'succeeded' ? '投递成功' : '投递失败'}
                      </span>
                      <strong>{log.channelName}</strong>
                      <span className="webhook-type-pill">{EVENT_LABELS[log.event]}</span>
                      {log.mergedCount > 1 && (
                        <span className="webhook-meta-pill">聚合 {log.mergedCount} 条</span>
                      )}
                      {log.httpStatus !== undefined && (
                        <small className="numeric">HTTP {log.httpStatus}</small>
                      )}
                      {log.attempts > 1 && <small>重试 {log.attempts} 次</small>}
                      <small className="webhook-log-time numeric">
                        {formatDate(log.createdAt)}
                      </small>
                    </div>
                    <p className="webhook-log-summary">{log.summary}</p>
                    <div className="webhook-log-foot">
                      <code>{log.targetHint}</code>
                      {log.error && <span className="error-text">{log.error}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="field-hint">尚未产生投递记录。可点击「发送测试」验证连接。</p>
            )}
          </details>
        </>
      )}

      {editor && (
        <Modal
          title={editor.editing ? '编辑通知渠道' : '新增事件通知渠道'}
          subtitle="仅允许公网 HTTPS（443）地址，自动拦截本机与私有网段防 SSRF。"
          onClose={() => {
            if (!saving) setEditor(null)
          }}
        >
          <form onSubmit={(e) => void saveChannel(e)}>
            <fieldset disabled={saving}>
              <div className="form-row">
                <label className="field">
                  渠道名称
                  <input
                    required
                    maxLength={40}
                    placeholder="例如：教务处飞书群"
                    value={editor.name}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  />
                </label>
                <label className="field">
                  通知平台
                  <select
                    value={editor.type}
                    onChange={(e) =>
                      setEditor({ ...editor, type: e.target.value as WebhookChannelType })
                    }
                  >
                    {(Object.keys(CHANNEL_META) as WebhookChannelType[]).map((key) => (
                      <option key={key} value={key}>
                        {CHANNEL_META[key].label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                Webhook 地址（HTTPS）
                <input
                  type="url"
                  required={!editor.editing}
                  maxLength={1000}
                  autoComplete="off"
                  value={editor.url}
                  onChange={(e) => setEditor({ ...editor, url: e.target.value })}
                  placeholder={
                    editor.editing
                      ? `已加密保存（${editor.editing.urlHint}），留空保持不变`
                      : CHANNEL_META[editor.type].urlPlaceholder
                  }
                />
                <small>保存后仅在服务端加密存储，界面仅脱敏展示域名。</small>
              </label>

              <label className="field">
                加签密钥（Secret）
                <input
                  type="password"
                  maxLength={512}
                  autoComplete="new-password"
                  disabled={editor.clearSecret}
                  value={editor.secret}
                  onChange={(e) => setEditor({ ...editor, secret: e.target.value })}
                  placeholder={
                    editor.editing?.hasSecret ? '已加密保存，留空保留原密钥' : '选填，加密存储'
                  }
                />
                <small>{CHANNEL_META[editor.type].secretHint}</small>
              </label>

              {editor.editing?.hasSecret && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={editor.clearSecret}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        clearSecret: e.target.checked,
                        secret: e.target.checked ? '' : editor.secret,
                      })
                    }
                  />
                  清除已保存的加签密钥
                </label>
              )}

              <div className="field">
                <span>订阅事件</span>
                <div className="webhook-event-grid">
                  {EVENT_OPTIONS.map((ev) => {
                    const checked = editor.events.includes(ev.id)
                    return (
                      <label className="webhook-event-option" key={ev.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...editor.events, ev.id]
                              : editor.events.filter((x) => x !== ev.id)
                            setEditor({ ...editor, events: next })
                          }}
                        />
                        <span>
                          <strong>{ev.label}</strong>
                          <small>{ev.hint}</small>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>

              <div className="form-row">
                <label className="field">
                  同任务防刷屏聚合窗口（秒）
                  <input
                    type="number"
                    min={5}
                    max={300}
                    required
                    value={editor.debounceSeconds}
                    onChange={(e) =>
                      setEditor({ ...editor, debounceSeconds: Number(e.target.value) })
                    }
                  />
                  <small>默认 60 秒；同一任务窗口内多次同类事件会合并为一条消息。</small>
                </label>
                <label className="check-label webhook-enabled-toggle">
                  <input
                    type="checkbox"
                    checked={editor.enabled}
                    onChange={(e) => setEditor({ ...editor, enabled: e.target.checked })}
                  />
                  保存后立即启用此渠道
                </label>
              </div>

              {editorError && (
                <p className="error-text" role="alert">
                  {editorError}
                </p>
              )}

              <footer className="modal-footer">
                <button
                  type="button"
                  className="button"
                  disabled={saving}
                  onClick={() => setEditor(null)}
                >
                  取消
                </button>
                <button type="submit" className="button primary" disabled={saving}>
                  <Check size={15} />
                  {saving ? '保存中…' : '保存渠道'}
                </button>
              </footer>
            </fieldset>
          </form>
        </Modal>
      )}

      {deleting && (
        <Modal
          title="删除通知渠道？"
          subtitle={deleting.name}
          onClose={() => {
            if (!busyId) setDeleting(null)
          }}
        >
          <p className="body-copy">
            删除后将立即停止向「{deleting.name}」（<code>{deleting.urlHint}</code>
            ）推送通知，历史脱敏投递日志会保留用于审计。
          </p>
          <footer className="modal-footer">
            <button
              type="button"
              className="button"
              disabled={busyId !== ''}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button danger-solid"
              disabled={busyId !== ''}
              onClick={() => void confirmDelete()}
            >
              <Trash2 size={14} />
              {busyId === deleting.id ? '删除中…' : '确认删除'}
            </button>
          </footer>
        </Modal>
      )}
    </section>
  )
}
