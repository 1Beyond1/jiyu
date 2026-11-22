import { useCallback, useEffect, useRef, useState } from 'react'
import type { AISettings, CollectionDraft, DraftConfirmation, MaterialRequirement } from '../types'
import { api } from '../lib/api'
import { safeRandomUUID } from '../lib/browser-crypto'
import { deadlineFromText } from '../lib/collections'

type Resolution = { answer: string; materialId: string; applied: boolean; skipped?: boolean }
export function CollectionDraftEditor({
  onApply,
}: {
  onApply: (value: {
    title: string
    description: string
    deadline: string
    materials: MaterialRequirement[]
    confirmation: DraftConfirmation
  }) => void
}) {
  const [open, setOpen] = useState(false),
    [prompt, setPrompt] = useState(''),
    [settings, setSettings] = useState<AISettings | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [draft, setDraft] = useState<CollectionDraft | null>(null),
    [answers, setAnswers] = useState<Record<string, Resolution>>({}),
    [confirmed, setConfirmed] = useState(false)
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null)
  const loadSettings = useCallback(async () => {
    setConsent(false)
    setError('')
    try {
      setSettings(await api<AISettings>('/api/ai/settings'))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    if (open) void loadSettings()
    return () => {
      generation.current++
      controller.current?.abort()
    }
  }, [open, loadSettings])
  function discard() {
    generation.current++
    controller.current?.abort()
    setOpen(false)
    setDraft(null)
    setAnswers({})
    setBusy(false)
    setConsent(false)
    setConfirmed(false)
    setError('')
  }
  function edit(value: CollectionDraft) {
    setDraft(value)
    setConfirmed(false)
    setError('')
  }
  async function generate() {
    if (busy || !settings || !consent) return
    const current = ++generation.current,
      source = prompt.trim()
    controller.current = new AbortController()
    setBusy(true)
    setError('')
    setDraft(null)
    setAnswers({})
    setConfirmed(false)
    try {
      const value = await api<CollectionDraft>(
        '/api/ai/collection-draft',
        'POST',
        { prompt: source, consent: true, settingsRevision: settings.revision },
        controller.current.signal,
      )
      if (current === generation.current) {
        if (value.source !== source) throw new Error('草稿与本次描述不匹配，请重新起草')
        setDraft(value)
        setAnswers(
          Object.fromEntries(
            value.clarifications.map((q) => [
              q.id,
              { answer: '', materialId: q.materialId || '', applied: false },
            ]),
          ),
        )
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message)
    } finally {
      if (current === generation.current) {
        setBusy(false)
        setConsent(false)
      }
    }
  }
  function resolve(id: string) {
    if (!draft) return
    const a = answers[id],
      answer = a?.answer.trim(),
      material = draft.materials.find((m) => m.id === a?.materialId)
    if (!answer || !material) {
      setError('请填写补充要求，并明确它属于哪项材料。')
      return
    }
    const description = material.description.includes(answer)
      ? material.description
      : [material.description, `补充要求：${answer}`].filter(Boolean).join('\n')
    if (description.length > 200) {
      setError('加入答复后超过 200 字，请先精简该材料要求，再加入答复。')
      return
    }
    edit({
      ...draft,
      materials: draft.materials.map((m) => (m.id === material.id ? { ...m, description } : m)),
    })
    setAnswers((old) => ({ ...old, [id]: { ...a, answer, applied: true } }))
  }
  function apply() {
    if (!draft || !confirmed) return
    const materials = draft.materials
    if (
      !draft.title.trim() ||
      !materials.length ||
      materials.some((m) => !m.name.trim() || m.required === null) ||
      !materials.some((m) => m.required)
    ) {
      setError('请填写标题、材料名称，并明确每项必需性，至少一项为必需。')
      return
    }
    if (
      new Set(materials.map((m) => m.name.normalize('NFKC').trim().toLowerCase())).size !==
      materials.length
    ) {
      setError('材料名称不能重复。')
      return
    }
    if (
      draft.clarifications.some((q) => {
        const a = answers[q.id]
        if (a?.skipped) return false
        return (
          !a?.applied ||
          !materials.some((m) => m.id === a.materialId && m.description.includes(a.answer))
        )
      })
    ) {
      setError('请把每个澄清答复加入对应材料要求。')
      return
    }
    onApply({
      title: draft.title.trim(),
      description: draft.description,
      deadline: deadlineFromText(prompt),
      materials: materials.map((m) => ({
        id: m.id,
        name: m.name.trim(),
        required: m.required === true,
        description: m.description.trim(),
      })),
      confirmation: {
        runId: draft.runId,
        confirmed: true,
        resolutions: draft.clarifications.map((q) =>
          answers[q.id].skipped
            ? { id: q.id, skipped: true }
            : { id: q.id, answer: answers[q.id].answer, materialId: answers[q.id].materialId },
        ),
      },
    })
    discard()
  }
  return (
    <section className="collection-draft" aria-label="一句话材料草稿">
      {!open ? (
        <button type="button" className="button" onClick={() => setOpen(true)}>
          用一句话起草材料清单
        </button>
      ) : (
        <>
          <div className="section-heading">
            <h3>先说说，要收什么</h3>
            <button type="button" className="text-button" onClick={discard}>
              取消一句话草稿
            </button>
          </div>
          <p>只生成建议，不创建任务；随时可继续使用下方人工或模板入口。</p>
          {settings?.testMode && (
            <p className="form-note">
              <strong>内部注入测试模式</strong> · 只验证流程，不代表真实语义理解。
            </p>
          )}
          {settings && (!settings.enabled || !settings.keyReady) && (
            <p className="form-note">模型尚未配置，不能生成草稿。可直接使用下方模板或人工设置。</p>
          )}
          <label className="field">
            一句话描述收集内容
            <textarea
              rows={3}
              value={prompt}
              maxLength={1000}
              disabled={busy}
              onChange={(e) => {
                setPrompt(e.target.value)
                setConsent(false)
                setDraft(null)
                setAnswers({})
                setConfirmed(false)
              }}
              placeholder="例如：收社团报名表和作品说明，展示图片选填，作品说明的页数还没定"
            />
          </label>
          <p className="field-hint">
            只描述材料，不粘贴名单、证件号或私密凭证。只发送这段原话，不读取已有任务、文件或名单；调用可能计费，取消不会撤销已发生的调用记录与次数。
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy || !settings?.enabled || !settings.keyReady}
              onChange={(e) => setConsent(e.target.checked)}
            />
            同意向 {settings ? new URL(settings.baseUrl).hostname : '当前模型服务'} 发送以上原话
          </label>
          <div className="button-row">
            <button
              type="button"
              className="button"
              disabled={
                busy ||
                prompt.trim().length < 4 ||
                !consent ||
                !settings?.enabled ||
                !settings.keyReady
              }
              onClick={() => void generate()}
            >
              {busy ? '正在起草…' : '生成材料草稿'}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void loadSettings()}
            >
              刷新模型设置
            </button>
          </div>
          {draft && (
            <section className="collection-draft-result" aria-label="可修改的材料草稿">
              <h4>清单由你定稿</h4>
              <p>
                请核对材料范围和每项必需性。截止时间、名单、个人字段、格式与存储仍在原表单中人工设置。
              </p>
              <label className="field">
                草稿收集标题
                <input
                  value={draft.title}
                  maxLength={50}
                  onChange={(e) => edit({ ...draft, title: e.target.value })}
                />
              </label>
              {draft.materials.map((m, i) => (
                <article key={m.id}>
                  <label className="field">
                    草稿材料 {i + 1} 名称
                    <input
                      maxLength={30}
                      value={m.name}
                      onChange={(e) =>
                        edit({
                          ...draft,
                          materials: draft.materials.map((v) =>
                            v.id === m.id ? { ...v, name: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    草稿材料 {i + 1} 必需性
                    <select
                      value={m.required === null ? 'unset' : m.required ? 'required' : 'optional'}
                      onChange={(e) =>
                        edit({
                          ...draft,
                          materials: draft.materials.map((v) =>
                            v.id === m.id
                              ? {
                                  ...v,
                                  required:
                                    e.target.value === 'unset'
                                      ? null
                                      : e.target.value === 'required',
                                }
                              : v,
                          ),
                        })
                      }
                    >
                      <option value="unset">未明确，请人工选择</option>
                      <option value="required">必需</option>
                      <option value="optional">选填</option>
                    </select>
                  </label>
                  <label className="field">
                    草稿材料 {i + 1} 要求
                    <textarea
                      value={m.description}
                      maxLength={200}
                      rows={2}
                      onChange={(e) =>
                        edit({
                          ...draft,
                          materials: draft.materials.map((v) =>
                            v.id === m.id ? { ...v, description: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                  <p className="field-hint">
                    {m.sourceQuote
                      ? `原话依据：「${m.sourceQuote}」`
                      : '人工添加的材料，请核对必要性。'}
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      edit({ ...draft, materials: draft.materials.filter((v) => v.id !== m.id) })
                    }
                  >
                    移除草稿材料 {i + 1}
                  </button>
                </article>
              ))}
              <button
                type="button"
                className="button"
                disabled={draft.materials.length >= 8}
                onClick={() =>
                  edit({
                    ...draft,
                    materials: [
                      ...draft.materials,
                      {
                        id: `mat_${safeRandomUUID().slice(0, 8)}`,
                        name: '',
                        description: '',
                        required: null,
                        sourceQuote: '',
                      },
                    ],
                  })
                }
              >
                人工添加材料
              </button>
              {!!draft.clarifications.length && (
                <div className="draft-clarifications">
                  <h4>还需要你补清楚</h4>
                  {draft.clarifications.map((q, i) => {
                    const a = answers[q.id]
                    return (
                      <article key={q.id}>
                        <strong>{q.question}</strong>
                        <p className="field-hint">依据：「{q.sourceQuote}」</p>
                        <label className="field">
                          澄清 {i + 1} 对应材料
                          <select
                            value={a?.materialId || ''}
                            onChange={(e) => {
                              setConfirmed(false)
                              setAnswers((old) => ({
                                ...old,
                                [q.id]: { ...a, materialId: e.target.value, applied: false },
                              }))
                            }}
                          >
                            <option value="">请明确选择</option>
                            {draft.materials.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name || '未命名材料'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          澄清 {i + 1} 补充要求
                          <textarea
                            rows={2}
                            maxLength={120}
                            value={a?.answer || ''}
                            onChange={(e) => {
                              setConfirmed(false)
                              setAnswers((old) => ({
                                ...old,
                                [q.id]: { ...a, answer: e.target.value, applied: false },
                              }))
                            }}
                          />
                        </label>
                        <button type="button" className="button" onClick={() => resolve(q.id)}>
                          将澄清 {i + 1} 答复加入材料要求
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            setConfirmed(false)
                            setAnswers((old) => ({
                              ...old,
                              [q.id]: {
                                answer: '',
                                materialId: '',
                                applied: false,
                                skipped: !a?.skipped,
                              },
                            }))
                          }}
                        >
                          {a?.skipped ? '撤销跳过' : '这条不用补充'}
                        </button>
                        {a?.skipped && <p className="success-text">已跳过，这条不写进材料要求。</p>}
                        {a?.applied && (
                          <p className="success-text">答复已加入清单，请核对上方最终要求。</p>
                        )}
                      </article>
                    )
                  })}
                </div>
              )}
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对最终清单，确认带入下方创建表单
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!confirmed}
                onClick={apply}
              >
                确认草稿并带入表单
              </button>
              <p className="field-hint">此时仍不创建收集；完成原表单并点击“创建收集”后才保存。</p>
            </section>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  )
}
