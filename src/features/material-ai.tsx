import { useEffect, useRef, useState } from 'react'
import type {
  Collection,
  CollectedFile,
  AISettings,
  MaterialAIPreview,
  MaterialAIPlan,
  MaterialAIFinding,
  DocumentInfo,
} from '../types'
import { api } from '../lib/api'
import { materialStateVersion } from '../lib/materials'
import { useAccount } from './auth'

const labels = {
  attention: '模型提示存在待核问题',
  uncertain: '模型无法确定',
  no_issue_in_excerpt: '已读片段未见问题，仍需人工核对',
}
// Reading the text is a prerequisite of a review, so it happens here rather than as a separate step for the user.
async function recognize(ids: string[], signal: AbortSignal) {
  const documents = async () =>
    (await api<{ documents: DocumentInfo[] }>('/api/content/status')).documents
  const known = await documents()
  const missing = ids.filter((id) => !known.some((d) => d.file_id === id))
  if (missing.length) await api('/api/content/index', 'POST', { ids: missing }, signal)
  for (let i = 0; i < 40 && !signal.aborted; i++) {
    const current = await documents()
    if (
      ids.every((id) =>
        current.some((d) => d.file_id === id && d.status !== 'queued' && d.status !== 'processing'),
      )
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export function MaterialAIPanel({
  collection: c,
  personId,
  selected: picked,
  allFiles,
  scopeVersion,
  disabled = false,
  onDetail,
  onPrepare,
}: {
  collection: Collection
  personId: string
  selected: CollectedFile[]
  allFiles: CollectedFile[]
  scopeVersion: string
  disabled?: boolean
  onDetail: (file: CollectedFile) => void
  onPrepare: (plan: MaterialAIPlan, finding: MaterialAIFinding) => void
}) {
  const { user } = useAccount()
  // Nothing ticked means this person's materials, so a review takes one click.
  const selected = picked.length ? picked : allFiles.slice(0, 10)
  const storageKey = `jiyu:material-ai:${user?.id}:${c.id}:${personId}`
  const [settings, setSettings] = useState<AISettings | null>(null),
    [preview, setPreview] = useState<MaterialAIPreview | null>(null),
    [plan, setPlan] = useState<MaterialAIPlan | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [consent, setConsent] = useState(false),
    [contentConsent, setContentConsent] = useState(false),
    [checked, setChecked] = useState<Record<string, boolean>>({})
  const [toolMode, setToolMode] = useState(false)
  const [planCheckedKey, setPlanCheckedKey] = useState('')
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0)
  const selectionKey = JSON.stringify(selected.map((f) => [f.id, materialStateVersion(f)]))
  const fileKey = JSON.stringify(allFiles.map((f) => [f.id, materialStateVersion(f)]))
  const scopeKey = JSON.stringify([c.id, personId, c.materialRevision, fileKey, scopeVersion])
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey
  useEffect(() => {
    let alive = true
    void api<AISettings>('/api/ai/settings')
      .then((s) => {
        if (alive) setSettings(s)
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
      generation.current++
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    generation.current++
    controller.current?.abort()
    setBusy(false)
    setPreview(null)
    setConsent(false)
    setContentConsent(false)
  }, [selectionKey, fileKey, c.materialRevision, scopeVersion])
  useEffect(() => {
    let alive = true
    let id = ''
    try {
      id = localStorage.getItem(storageKey) || ''
    } catch {
      /* optional local history pointer */
    }
    if (id)
      void api<MaterialAIPlan>(`/api/material-ai/plans/${encodeURIComponent(id)}`)
        .then((p) => {
          if (alive) {
            setPlan(p)
            setPlanCheckedKey(scopeKey)
            setChecked({})
          }
        })
        .catch((e) => {
          if (alive) setError(e.message)
        })
    return () => {
      alive = false
    }
  }, [storageKey, scopeKey])
  async function prepare() {
    if (disabled) return
    const ticket = ++generation.current
    setBusy(true)
    setError('')
    setConsent(false)
    setContentConsent(false)
    setPreview(null)
    controller.current = new AbortController()
    try {
      await recognize(
        selected.map((f) => f.id),
        controller.current.signal,
      )
      const [s, p] = await Promise.all([
        api<AISettings>('/api/ai/settings'),
        api<MaterialAIPreview>(
          '/api/material-ai/preview',
          'POST',
          {
            collectionId: c.id,
            files: selected.map((f) => ({ id: f.id, expectedVersion: materialStateVersion(f) })),
          },
          controller.current.signal,
        ),
      ])
      if (ticket === generation.current && scopeRef.current === scopeKey) {
        setSettings(s)
        setPreview(p)
      }
    } catch (e) {
      if (ticket === generation.current && scopeRef.current === scopeKey)
        setError((e as Error).message)
    } finally {
      if (ticket === generation.current && scopeRef.current === scopeKey) setBusy(false)
    }
  }
  async function run() {
    if (disabled || !preview) return
    const ticket = ++generation.current
    setBusy(true)
    setError('')
    controller.current = new AbortController()
    try {
      const p = await api<MaterialAIPlan>(
        '/api/material-ai/run',
        'POST',
        {
          previewId: preview.previewId,
          settingsRevision: preview.settingsRevision,
          consent,
          contentConsent,
          mode: toolMode ? 'tools' : 'single',
        },
        controller.current.signal,
      )
      if (ticket === generation.current && scopeRef.current === scopeKey) {
        setPlan(p)
        setPlanCheckedKey(scopeKey)
        setChecked({})
        setPreview(null)
        try {
          localStorage.setItem(storageKey, p.runId)
        } catch {
          /* server record remains */
        }
      }
    } catch (e) {
      if (ticket === generation.current && scopeRef.current === scopeKey)
        setError((e as Error).message)
    } finally {
      if (ticket === generation.current && scopeRef.current === scopeKey) {
        setBusy(false)
        setConsent(false)
        setContentConsent(false)
      }
    }
  }
  async function adopt(finding: MaterialAIFinding) {
    if (disabled || !plan || planCheckedKey !== scopeKey || !checked[finding.fileId]) return
    const ticket = ++generation.current
    controller.current = new AbortController()
    setBusy(true)
    setError('')
    try {
      const current = await api<MaterialAIPlan>(
        `/api/material-ai/plans/${plan.runId}`,
        'GET',
        undefined,
        controller.current.signal,
      )
      if (ticket !== generation.current || scopeRef.current !== scopeKey) return
      setPlan(current)
      setPlanCheckedKey(scopeKey)
      if (current.stale) throw new Error(current.staleReason)
      onPrepare(current, finding)
    } catch (e) {
      if (ticket === generation.current && scopeRef.current === scopeKey)
        setError((e as Error).message)
    } finally {
      if (ticket === generation.current && scopeRef.current === scopeKey) setBusy(false)
    }
  }
  return (
    <section className="material-ai" aria-label="AI材料预核对">
      <h4>AI 材料预核对</h4>
      <p>先读已选文件的授权片段，给出待人工审阅的建议。不会自动通过材料，也不能判断未读内容。</p>
      {settings?.testMode && (
        <p className="form-note">
          <strong>内部注入测试模式</strong> · 仅验证协议、引用、版本与界面；结果不代表真实模型效果。
        </p>
      )}
      {settings && (!settings.enabled || !settings.keyReady) && (
        <p className="form-note">
          模型尚未配置。可先核对本机读取范围；在<a href="#/settings">设置</a>
          中填写你自己的模型服务后才能发送。
        </p>
      )}
      <button
        className="button"
        disabled={disabled || busy || !selected.length || selected.length > 10}
        onClick={() => void prepare()}
      >
        让 AI 预核对这 {selected.length} 份（先看发送范围）
      </button>
      <p className="field-hint">
        未勾选时默认核对此人的材料。每次最多 10 份，每份最多 4,000 字符，合计最多
        8,000，正文会自动识别。
      </p>
      {preview && (
        <div className="material-ai-preview">
          <h5>本次会发送什么</h5>
          <p>
            任务：{preview.title} · {preview.description}
          </p>
          <ul>
            {preview.materials.map((m) => (
              <li key={m.id}>
                {m.name}（{m.required ? '必需' : '选填'}）：{m.description}
              </li>
            ))}
          </ul>
          {preview.sources.map((s) => (
            <details key={s.id} open>
              <summary>
                {s.alias} · {s.name} ·{' '}
                {s.coverage === 'unread'
                  ? '未读'
                  : s.coverage === 'partial'
                    ? '部分已读'
                    : '索引全文'}
              </summary>
              <p>{s.reason}</p>
              <small>
                当前归属：{preview.materials.find((m) => m.id === s.materialId)?.name || '未分类'}
              </small>
              {s.excerpt && <pre>{s.excerpt}</pre>}
            </details>
          ))}
          <p className="field-hint">
            只发送以上任务要求、文件名、当前材料归属和显示的正文，不附带姓名 /
            私人名单；正文自身可能含个人信息，请检查。模型调用可能计费，失败尝试也计入每日次数。
          </p>
          {settings?.materialToolMode && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={toolMode}
                disabled={busy}
                onChange={(e) => setToolMode(e.target.checked)}
              />
              使用实验性多轮核对（最多四次模型请求，可能产生额外费用）
            </label>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
            />
            同意向 {settings ? new URL(settings.baseUrl).hostname : '当前模型服务'}{' '}
            发送以上任务要求与文件信息
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={contentConsent}
              disabled={busy}
              onChange={(e) => setContentConsent(e.target.checked)}
            />
            单独同意发送以上精确正文摘录
          </label>
          <button
            className="button primary"
            disabled={
              disabled ||
              busy ||
              !consent ||
              !contentConsent ||
              !settings?.enabled ||
              !settings.keyReady ||
              !preview.sources.some((s) => s.coverage !== 'unread')
            }
            onClick={() => void run()}
          >
            {busy ? '正在预核对…' : preview.testMode ? '运行内部注入验收' : '发送并生成预核对建议'}
          </button>
        </div>
      )}
      {busy && (
        <button
          className="text-button"
          onClick={() => {
            generation.current++
            controller.current?.abort()
            setBusy(false)
            setConsent(false)
            setContentConsent(false)
            setError('请求已停止；已发送的请求仍可能计费。')
          }}
        >
          取消等待
        </button>
      )}
      {plan && (
        <section className="material-ai-results" aria-label="材料预核对建议">
          <h5>建议与原文依据</h5>
          <p className="field-hint">
            采用前会重新检查材料与正文版本。有限片段的观察不代表整份文件合格。
          </p>
          <small>
            {plan.preview.testMode ? '内部注入测试 · 非真实模型效果' : plan.model} ·{' '}
            {new Date(plan.createdAt).toLocaleString('zh-CN')}
          </small>
          {planCheckedKey !== scopeKey && (
            <p className="form-note" role="status">
              材料已更新，正在重新核验这份旧建议。核验完成前不能采用。
            </p>
          )}
          {plan.stale && <p className="error-text">{plan.staleReason}。请重新准备发送范围。</p>}
          {plan.findings.map((f) => {
            const source = plan.preview.sources.find((s) => s.id === f.fileId)!
            const file = allFiles.find((s) => s.id === f.fileId)
            return (
              <article key={f.fileId}>
                <h5>{source.name}</h5>
                <strong>{labels[f.assessment]}</strong>
                <p>{f.message}</p>
                <p>人工建议：{f.suggestion || '暂无补充建议，请继续人工核对。'}</p>
                {!!f.materialId && (
                  <p>可能归属：{plan.preview.materials.find((m) => m.id === f.materialId)?.name}</p>
                )}
                <p className="field-hint">读取范围：{source.reason}</p>
                {f.evidence.map((e, i) => (
                  <div className="material-ai-evidence" key={i}>
                    <small>
                      {source.name} · 第 {e.start + 1}–{e.end} 字
                    </small>
                    <blockquote>{e.quote}</blockquote>
                    <details>
                      <summary>核对本次提供的原文上下文</summary>
                      <pre>
                        {source.excerpt.slice(Math.max(0, e.start - 100), e.start)}
                        <mark>{e.quote}</mark>
                        {source.excerpt.slice(e.end, e.end + 100)}
                      </pre>
                    </details>
                  </div>
                ))}
                {file && (
                  <button className="button" disabled={busy} onClick={() => onDetail(file)}>
                    查看原文件 {source.name}
                  </button>
                )}
                {plan.dispositions?.[f.fileId] && (
                  <p className="field-hint">
                    已记录人工处置：{plan.dispositions[f.fileId].by} ·{' '}
                    {plan.dispositions[f.fileId].kind === 'classify' ? '材料归属' : '人工核对'} ·{' '}
                    {plan.dispositions[f.fileId].note}
                  </p>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={!!checked[f.fileId]}
                    disabled={
                      disabled ||
                      busy ||
                      planCheckedKey !== scopeKey ||
                      plan.stale ||
                      !file ||
                      source.coverage === 'unread'
                    }
                    onChange={(e) =>
                      setChecked((old) => ({ ...old, [f.fileId]: e.target.checked }))
                    }
                  />
                  我已核对这份文件的原文依据，接下来人工决定
                </label>
                <button
                  className="button"
                  disabled={
                    disabled ||
                    busy ||
                    planCheckedKey !== scopeKey ||
                    plan.stale ||
                    !checked[f.fileId] ||
                    !file
                  }
                  onClick={() => void adopt(f)}
                >
                  带入 {source.name} 的人工处理
                </button>
              </article>
            )
          })}
        </section>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
