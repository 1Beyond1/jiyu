import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Download,
  Eye,
  FolderArchive,
  Keyboard,
  MessageSquareText,
  Upload,
} from 'lucide-react'
import type { Collection, CollectedFile, MaterialOperation } from '../types'
import { materialStateLabels, materialStateVersion } from '../lib/materials'
import { safeRandomUUID } from '../lib/browser-crypto'
import { downloadText, formatSize } from '../lib/workspace'
import { isEditableTarget, resolveReviewShortcut, stepFileIndex } from '../lib/review-shortcuts'
import { ArchiveModal } from './archive'
import { useAccount } from './auth'
import { FilePreview } from './content'
import { MaterialAIPanel } from './material-ai'
import { ReminderModal } from './reminder-modal'
import { useMaterialState } from './use-material-state'

type Draft = { materialId: string; decision: '' | 'accepted' | 'needs_changes'; note: string }
type Selection = { rulesRevision: string; files: { id: string; expectedVersion: string }[] }

function restoreNotes(key: string): Record<string, Draft> {
  try {
    const notes: unknown = JSON.parse(sessionStorage.getItem(key) || '{}')
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return {}
    return Object.fromEntries(
      Object.entries(notes)
        .filter(([, note]) => typeof note === 'string')
        .map(([person, note]) => [
          person,
          { materialId: '', decision: '', note: String(note).slice(0, 300) },
        ]),
    )
  } catch {
    return {}
  }
}

export function MaterialWorkbench({
  collection: c,
  files,
  refreshKey,
  onDetail,
  onAction,
  onRefresh,
  onEditRules,
  onShare,
  onOfflineUpload,
}: {
  collection: Collection
  files: CollectedFile[]
  refreshKey: string
  onEditRules: () => void
  onShare: () => void
  onDetail: (file: CollectedFile) => void
  onAction: (kind: 'classify' | 'review', body: MaterialOperation) => Promise<void>
  onRefresh: () => Promise<void>
  onOfflineUpload?: (person: { owner: string; identity: string }) => void
}) {
  const { canEdit, isAdmin, user } = useAccount()
  const noteKey = `jiyu:material-note-drafts:${user?.id}:${c.id}`
  const [filter, setFilter] = useState('all'),
    [query, setQuery] = useState(''),
    [personId, setPersonId] = useState('')
  const [selection, setSelection] = useState<Selection>({
    rulesRevision: c.materialRevision || '',
    files: [],
  })
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => restoreNotes(noteKey)),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [aiReview, setAIReview] = useState<MaterialOperation['aiReview']>()
  const [previewFileId, setPreviewFileId] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [reminder, setReminder] = useState<{ mode: 'group' | 'direct'; personId?: string } | null>(
    null,
  )
  const pending = useRef<{
    signature: string
    kind: 'classify' | 'review'
    body: MaterialOperation
  } | null>(null)
  const detail = useRef<HTMLElement>(null)
  const noteInputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    try {
      sessionStorage.setItem(
        noteKey,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(drafts)
              .filter(([, value]) => value.note)
              .map(([person, value]) => [person, value.note]),
          ),
        ),
      )
    } catch {
      /* Current in-page draft remains editable when session storage is unavailable. */
    }
  }, [drafts, noteKey])
  useEffect(() => {
    if (personId) {
      detail.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
      detail.current?.focus({ preventScroll: true })
    }
  }, [personId])
  const state = useMaterialState(c, files, refreshKey, onRefresh)
  const { report, rows } = state
  const fileState = useCallback(
    (f: CollectedFile) => report?.files.find((v) => v.id === f.id)?.materialState || 'unclassified',
    [report],
  )
  const pendingPeople = rows.filter((p) => p.status === 'pending')
  // Same denominator as the progress bar: roster only when a roster exists.
  const people = report?.participants || []
  const roster = c.expectedSubmitters?.length ? people.filter((p) => p.expected) : people
  const outsiders = c.expectedSubmitters?.length
    ? people.filter((p) => !p.expected && p.receivedComplete).length
    : 0
  const personAction = (status: string) =>
    status === 'needs_changes'
      ? '查看补充原因'
      : status === 'missing'
        ? '查看缺哪项'
        : status === 'unclassified'
          ? '先确认归属'
          : status === 'accepted'
            ? '查看已核对材料'
            : '开始核对'
  function openQueue(value: string) {
    if (!state.ready || busy) return
    setFilter(value)
    const first = rows.find((p) =>
      value === 'pending'
        ? p.status === 'pending'
        : value === 'needs_changes'
          ? p.status === 'needs_changes'
          : !p.receivedComplete,
    )
    openPerson(first?.identity || '')
  }
  const person = rows.find((p) => p.identity === personId)
  const previewFile =
    person?.files.find((f) => f.id === previewFileId) ||
    person?.files.find((f) => fileState(f) !== 'accepted') ||
    person?.files[0] ||
    null
  const otherPendingPeople = (() => {
    const idx = rows.findIndex((p) => p.identity === personId)
    const ordered = idx >= 0 ? [...rows.slice(idx + 1), ...rows.slice(0, idx)] : rows
    return ordered.filter((p) => p.identity !== personId && p.status === 'pending')
  })()
  const nextPendingPerson = otherPendingPeople[0] || null
  const draft = drafts[personId] || { materialId: '', decision: '' as const, note: '' }
  const setDraft = useCallback(
    (value: Partial<Draft>) => {
      setDrafts((old) => ({
        ...old,
        [personId]: {
          ...(old[personId] || { materialId: '', decision: '' as const, note: '' }),
          ...value,
        },
      }))
      pending.current = null
      setNotice('')
      setError('')
    },
    [personId],
  )
  const chosen = (person?.files || []).filter((f) => selection.files.some((s) => s.id === f.id))
  const staleSelection =
    selection.files.length > 0 &&
    (selection.rulesRevision !== c.materialRevision ||
      selection.files.some(
        (s) => !chosen.some((f) => f.id === s.id && s.expectedVersion === materialStateVersion(f)),
      ))
  useEffect(() => {
    if (staleSelection) {
      setAIReview(undefined)
      setDrafts((old) =>
        old[personId]
          ? { ...old, [personId]: { ...old[personId], decision: '', materialId: '' } }
          : old,
      )
    }
  }, [staleSelection, personId])
  const shown = rows.filter(
    (p) =>
      `${p.identity} ${p.owner}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'accepted' && p.reviewComplete) ||
        (filter === 'missing' && !p.receivedComplete) ||
        (filter === 'pending' && p.status === 'pending') ||
        (filter === 'unclassified' && !!p.unclassified.length) ||
        (filter === 'duplicate' && p.duplicateCount > 0) ||
        (filter === 'needs_changes' && p.status === 'needs_changes')),
  )
  function openPerson(identity: string, preferredFileId = '') {
    if (busy || (identity && !state.ready)) return
    setAIReview(undefined)
    setPersonId(identity)
    setPreviewFileId(preferredFileId)
    setSelection({ rulesRevision: c.materialRevision || '', files: [] })
    setError('')
    setNotice('')
    pending.current = null
  }
  const selectFiles = useCallback(
    (list: CollectedFile[]) => {
      setAIReview(undefined)
      setSelection({
        rulesRevision: c.materialRevision || '',
        files: list.map((f) => ({ id: f.id, expectedVersion: materialStateVersion(f) })),
      })
      pending.current = null
      setError('')
      setNotice('')
    },
    [c.materialRevision],
  )
  const chosenIdSet = new Set(chosen.map((f) => f.id))
  const remainingUnreviewedForPerson = person
    ? person.files.filter(
        (f) => !chosenIdSet.has(f.id) && !['accepted', 'needs_changes'].includes(fileState(f)),
      )
    : []
  const submitReview = useCallback(
    async (
      targets: CollectedFile[],
      decision: 'accepted' | 'needs_changes',
      noteText: string,
      advanceNext: boolean,
      useCurrentSelection: boolean,
    ) => {
      if (busy || !state.ready || !canEdit || !targets.length) return
      if (useCurrentSelection && staleSelection) return
      if (decision === 'needs_changes' && !noteText.trim()) {
        setError('请说明需要补充或纠正什么。')
        return
      }
      if (
        decision === 'accepted' &&
        targets.some((f) => !c.materials?.some((m) => m.id === f.materialId))
      ) {
        setError('未分类文件不能直接标记核对通过，请先指定材料归属。')
        return
      }
      const targetEntries = useCurrentSelection
        ? selection.files
        : targets.map((f) => ({ id: f.id, expectedVersion: materialStateVersion(f) }))
      const rulesRev = useCurrentSelection ? selection.rulesRevision : c.materialRevision || ''
      const signature = JSON.stringify([
        personId,
        'review',
        rulesRev,
        targetEntries,
        decision,
        noteText.trim(),
        useCurrentSelection ? aiReview : undefined,
      ])
      if (pending.current?.signature !== signature) {
        pending.current = {
          signature,
          kind: 'review',
          body: {
            collectionId: c.id,
            ...(useCurrentSelection && aiReview ? { aiReview } : {}),
            rulesRevision: rulesRev,
            requestId: safeRandomUUID(),
            files: targetEntries,
            decision,
            note: noteText.trim(),
          },
        }
      }
      const targetIdSet = new Set(targets.map((f) => f.id))
      const leftoverFiles = person
        ? person.files.filter(
            (f) => !targetIdSet.has(f.id) && !['accepted', 'needs_changes'].includes(fileState(f)),
          )
        : []
      const nextTarget = advanceNext ? nextPendingPerson : null
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await onAction(pending.current.kind, pending.current.body)
        selectFiles([])
        setDrafts((old) => ({ ...old, [personId]: { materialId: '', decision: '', note: '' } }))
        state.retry()
        if (advanceNext && leftoverFiles.length) {
          setAIReview(undefined)
          setPreviewFileId(leftoverFiles[0].id)
          pending.current = null
          setNotice(
            `人工核对结果已保存；当前参与人仍有 ${leftoverFiles.length} 份未核对文件，已保留在本页并切换至「${leftoverFiles[0].name}」以免漏审。`,
          )
        } else if (advanceNext && nextTarget) {
          setAIReview(undefined)
          setPersonId(nextTarget.identity)
          setPreviewFileId('')
          pending.current = null
          setNotice(
            `人工核对结果已保存，已跳转至下一位待核对：${nextTarget.identity}${nextTarget.owner && nextTarget.owner !== nextTarget.identity ? `（${nextTarget.owner}）` : ''}。`,
          )
        } else {
          setNotice(
            advanceNext ? '人工核对结果已保存，当前已无更多待核对参与人。' : '人工核对结果已保存。',
          )
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [
      aiReview,
      busy,
      c.id,
      c.materialRevision,
      c.materials,
      canEdit,
      fileState,
      nextPendingPerson,
      onAction,
      person,
      personId,
      selectFiles,
      selection.files,
      selection.rulesRevision,
      staleSelection,
      state,
    ],
  )
  async function apply(kind: 'classify' | 'review', advanceNext = false) {
    if (busy || !state.ready || !canEdit || !chosen.length || staleSelection) return
    if (kind === 'review') {
      if (!draft.decision) {
        setError('请先选择人工核对结论。')
        return
      }
      await submitReview(chosen, draft.decision, draft.note, advanceNext, true)
      return
    }
    const signature = JSON.stringify([personId, kind, selection, draft, aiReview])
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        kind,
        body: {
          collectionId: c.id,
          ...(aiReview ? { aiReview } : {}),
          rulesRevision: selection.rulesRevision,
          requestId: safeRandomUUID(),
          files: selection.files.map((s) => ({
            ...s,
            materialId: draft.materialId,
          })),
        },
      }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await onAction(pending.current.kind, pending.current.body)
      selectFiles([])
      state.retry()
      setNotice('材料归属已保存；变化的文件需重新核对。')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!person || archiveOpen || reminder) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      const editable = isEditableTarget(e.target as HTMLElement | null)
      const shortcut = resolveReviewShortcut(e, editable)
      if (!shortcut) return
      if (shortcut === 'next' || shortcut === 'prev') {
        if (!person.files.length) return
        e.preventDefault()
        const currentIdx = previewFile ? person.files.findIndex((f) => f.id === previewFile.id) : 0
        const nextIdx = stepFileIndex(currentIdx, person.files.length, shortcut)
        if (nextIdx >= 0) setPreviewFileId(person.files[nextIdx].id)
        return
      }
      if (!canEdit || !state.ready || busy) return
      if (shortcut === 'approve') {
        const targets = chosen.length ? chosen : previewFile ? [previewFile] : []
        if (!targets.length) return
        e.preventDefault()
        void submitReview(targets, 'accepted', '', true, chosen.length > 0)
        return
      }
      if (shortcut === 'reject') {
        if (!chosen.length && !previewFile) return
        e.preventDefault()
        if (!chosen.length && previewFile) selectFiles([previewFile])
        setDraft({ decision: 'needs_changes' })
        requestAnimationFrame(() => {
          noteInputRef.current?.focus()
          noteInputRef.current?.scrollIntoView({ block: 'nearest' })
        })
        return
      }
      if (shortcut === 'submit') {
        const targets = chosen.length ? chosen : previewFile ? [previewFile] : []
        if (!targets.length) return
        e.preventDefault()
        if (!draft.decision) {
          setError('请先选择人工核对结论（或按 A 快速通过、按 R 退回）。')
          return
        }
        void submitReview(targets, draft.decision, draft.note, true, chosen.length > 0)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    archiveOpen,
    busy,
    canEdit,
    chosen,
    draft.decision,
    draft.note,
    person,
    previewFile,
    reminder,
    selectFiles,
    setDraft,
    state.ready,
    submitReview,
  ])
  async function exportReport() {
    setExporting(true)
    setError('')
    try {
      const response = await fetch(
        `/api/collections/${c.id}/materials/export?revision=${encodeURIComponent(report?.rulesRevision || '')}`,
        { credentials: 'same-origin' },
      )
      const content = await response.text()
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('jiyu:session-expired'))
        throw new Error(JSON.parse(content).error || '导出失败，请刷新重试')
      }
      if (!response.headers.get('content-type')?.includes('text/csv'))
        throw new Error('导出格式异常，请重试')
      downloadText('集屿-材料核对台账.csv', content, 'text/csv;charset=utf-8')
      setNotice('已按服务器当前状态导出台账，包含缺项和未通过记录。')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }
  return (
    <section
      className={`material-workbench${person ? ' with-person' : ''}`}
      aria-label="逐人材料收齐与人工核对"
    >
      <div className="material-mode-note">
        <strong>先看下一步，再逐项核对</strong>
        <p>
          收到文件与人工核对通过分别显示。相同内容不能凑齐两个必需项；AI 只提供单独授权后的建议。
        </p>
        <small>
          {report
            ? `材料状态更新于 ${new Date(report.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
            : '正在读取服务器材料状态…'}{' '}
          · 文件“已整理”不等于材料已通过
        </small>
      </div>
      {state.reading && (
        <p className="material-sync" role="status">
          {report ? '正在更新材料状态，已填写的核对说明会保留。' : '正在读取材料与名单…'}
        </p>
      )}
      {state.error && (
        <div className="form-note material-sync-error" role="alert">
          <p>{state.error} 当前显示的是上次读取的结果，更新后才能处理。</p>
          <button
            type="button"
            className="button"
            onClick={async () => {
              await onRefresh()
              state.retry()
            }}
          >
            同步最新记录
          </button>
        </div>
      )}
      <section className="material-next-tasks" aria-label="材料待办">
        <button
          type="button"
          className={`material-next missing ${filter === 'missing' ? 'active' : ''}`}
          disabled={busy || !state.ready}
          aria-pressed={filter === 'missing'}
          onClick={() => openQueue('missing')}
        >
          <strong>
            {report?.summary.missing ?? '—'}
            <small>人</small>
          </strong>
          <span>缺项或内容重复</span>
          <small>查看谁缺什么 →</small>
        </button>
        <button
          type="button"
          className={`material-next pending ${filter === 'pending' ? 'active' : ''}`}
          disabled={busy || !state.ready}
          aria-pressed={filter === 'pending'}
          onClick={() => openQueue('pending')}
        >
          <strong>
            {report ? pendingPeople.length : '—'}
            <small>人</small>
          </strong>
          <span>等待人工核对</span>
          <small>开始核对下一位 →</small>
        </button>
        <button
          type="button"
          className={`material-next needs_changes ${filter === 'needs_changes' ? 'active' : ''}`}
          disabled={busy || !state.ready}
          aria-pressed={filter === 'needs_changes'}
          onClick={() => openQueue('needs_changes')}
        >
          <strong>
            {report?.summary.needsChanges ?? '—'}
            <small>人</small>
          </strong>
          <span>材料需补充</span>
          <small>查看原因与当前材料 →</small>
        </button>
      </section>
      {report && (
        <div className="material-summary">
          <span>
            {roster.filter((p) => p.receivedComplete).length} 人必需项已收齐 ·{' '}
            {roster.filter((p) => p.reviewComplete).length} 人人工核对通过
            {!!outsiders && ` · 名单外另有 ${outsiders} 人已收齐`}
          </span>
          {!!report.summary.unclassified && (
            <button type="button" className="text-button" onClick={() => setFilter('unclassified')}>
              {report.summary.unclassified} 份文件待确认归属
            </button>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setFilter('all')
              setQuery('')
            }}
          >
            查看全部 {report.summary.participants} 人
          </button>
        </div>
      )}
      {!c.expectedSubmitters?.length && (
        <div className="form-note">
          未设置应交名单，只能统计已出现的参与人。
          {canEdit && (
            <button type="button" className="text-button" onClick={onEditRules}>
              添加应交名单
            </button>
          )}
        </div>
      )}
      <div className="material-toolbar">
        <label className="field">
          查找参与人
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="报名编号或姓名"
          />
        </label>
        <label className="field">
          材料状态
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部参与人</option>
            <option value="missing">缺项或内容重复</option>
            <option value="pending">已收齐，待核对</option>
            <option value="needs_changes">需补充</option>
            <option value="unclassified">含未分类文件</option>
            <option value="duplicate">含重复内容</option>
            <option value="accepted">人工核对通过</option>
          </select>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy || !files.length || files.length > 500}
            title="按材料项分目录打包，可勾选仅打包人工核对通过文件"
            onClick={() => setArchiveOpen(true)}
          >
            <FolderArchive size={15} />
            定向打包
          </button>
          {canEdit && (
            <button
              type="button"
              className="button"
              disabled={busy || !state.ready}
              onClick={() => setReminder({ mode: 'group' })}
            >
              <MessageSquareText size={15} />
              一键催交话术
            </button>
          )}
          <button
            type="button"
            className="button"
            disabled={busy || exporting || !state.ready}
            onClick={() => void exportReport()}
          >
            {exporting ? '导出中…' : '导出材料台账'}
          </button>
        </div>
      </div>
      <div className="material-matrix">
        <table>
          <thead>
            <tr>
              <th>参与标识 / 姓名</th>
              {c.materials!.map((m) => (
                <th key={m.id}>
                  {m.name}
                  <small>{m.required ? '必需' : '选填'}</small>
                </th>
              ))}
              <th>整体进展</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr
                key={p.identity}
                className={p.identity === personId ? 'selected' : ''}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('button')) openPerson(p.identity)
                }}
              >
                <td>
                  <strong>{p.identity}</strong>
                  <small>
                    {p.owner || '尚未提交'}
                    {!p.expected && ' · 名单外 / 未设名单'}
                  </small>
                </td>
                {p.slots.map((s) => (
                  <td key={s.requirement.id}>
                    <span
                      className={`mstate ${!s.requirement.required && !s.files.length ? 'optional' : s.state}`}
                    >
                      {!s.requirement.required && !s.files.length
                        ? '选填未交'
                        : materialStateLabels[s.state]}
                    </span>
                    <small>
                      {s.files.length} 份{s.duplicate ? ' · 内容重复' : ''}
                    </small>
                  </td>
                ))}
                <td>
                  <span className={`mstate ${p.status}`}>
                    {p.reviewComplete
                      ? '人工核对通过'
                      : p.status === 'needs_changes'
                        ? '有材料需补充'
                        : p.receivedComplete
                          ? '已收齐，待核对'
                          : '必需项未收齐'}
                  </span>
                  {!!p.unclassified.length && <small>{p.unclassified.length} 份未分类</small>}
                </td>
                <td>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || !state.ready}
                    aria-label={`${personAction(p.status)}：${p.identity}`}
                    onClick={() => openPerson(p.identity)}
                  >
                    {personAction(p.status)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="material-people-cards">
        {shown.map((p) => (
          <article key={p.identity}>
            <header>
              <div>
                <h3>{p.identity}</h3>
                <small>{p.owner || '尚未提交'}</small>
              </div>
              <span className={`mstate ${p.status}`}>
                {p.reviewComplete
                  ? '核对通过'
                  : p.status === 'needs_changes'
                    ? '需补充'
                    : p.receivedComplete
                      ? '已收齐，待核对'
                      : '未收齐'}
              </span>
            </header>
            <ul>
              {p.slots.map((s) => (
                <li key={s.requirement.id}>
                  <strong>
                    {s.requirement.name}
                    {s.requirement.required ? ' · 必需' : ' · 选填'}
                  </strong>
                  <span
                    className={`mstate ${!s.requirement.required && !s.files.length ? 'optional' : s.state}`}
                  >
                    {!s.requirement.required && !s.files.length
                      ? '未交选填项'
                      : materialStateLabels[s.state]}
                    {s.duplicate && ' · 重复内容'}
                  </span>
                </li>
              ))}
            </ul>
            {!!p.unclassified.length && <p>{p.unclassified.length} 份未分类，尚不计入材料项</p>}
            <button
              type="button"
              className="button"
              disabled={busy || !state.ready}
              aria-label={`${personAction(p.status)}：${p.identity}`}
              onClick={() => openPerson(p.identity)}
            >
              {personAction(p.status)}
            </button>
          </article>
        ))}
      </div>
      {report && !shown.length && (
        <div className="empty-ledger">
          <p>
            {query || filter !== 'all'
              ? '这个筛选下没有参与人。'
              : '还没有提交记录。分享链接，让参与人按材料清单交件。'}
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setFilter('all')
              setQuery('')
            }}
          >
            显示全部参与人
          </button>
          {canEdit && (
            <button type="button" className="text-button" onClick={onShare}>
              分享收集链接
            </button>
          )}
        </div>
      )}
      {person && (
        <section
          ref={detail}
          tabIndex={-1}
          className="material-person-detail"
          aria-label={`${person.identity}材料详情`}
        >
          <div className="section-heading">
            <div>
              <h3>
                {person.identity} · {person.owner || '尚未提交'}
              </h3>
              <p>左侧内联预览图片 / PDF / 文本与 DOCX，右侧归属与人工核对表单，支持连续流转。</p>
            </div>
            <div className="button-row">
              {isAdmin && onOfflineUpload && !c.archivedAt && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    onOfflineUpload({ owner: person.owner || '', identity: person.identity })
                  }
                >
                  <Upload size={14} />替 TA 补录
                </button>
              )}
              {nextPendingPerson && (
                <button
                  type="button"
                  className="button"
                  disabled={busy || !state.ready}
                  onClick={() => openPerson(nextPendingPerson.identity)}
                >
                  跳至下一位待核对（剩余 {otherPendingPeople.length} 位）
                  <ArrowRight size={14} />
                </button>
              )}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => openPerson('')}
              >
                收起详情
              </button>
            </div>
          </div>

          <div className="review-shortcut-bar" role="note" aria-label="分栏审阅快捷键提示">
            <Keyboard size={14} />
            <span>
              <kbd>J</kbd>/<kbd>K</kbd> 切换文件
            </span>
            {canEdit && (
              <>
                <span>
                  <kbd>A</kbd> 快速通过
                </span>
                <span>
                  <kbd>R</kbd> 退回并填理由
                </span>
                <span>
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 提交审核
                </span>
              </>
            )}
          </div>

          <div className="material-review-split">
            <div className="material-review-preview">
              {person.files.length ? (
                <>
                  <div className="material-preview-tabs" role="tablist" aria-label="切换预览文件">
                    {person.files.map((f) => {
                      const active = previewFile?.id === f.id
                      const matName =
                        c.materials!.find((m) => m.id === f.materialId)?.name || '未分类'
                      return (
                        <button
                          key={f.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          className={`material-preview-tab ${active ? 'active' : ''}`}
                          onClick={() => setPreviewFileId(f.id)}
                        >
                          <span>{f.name}</span>
                          <small>
                            {matName} · {materialStateLabels[fileState(f)]}
                          </small>
                        </button>
                      )
                    })}
                  </div>
                  {previewFile && (
                    <div className="material-preview-stage">
                      <header className="material-preview-bar">
                        <div>
                          <strong>{previewFile.name}</strong>
                          <small>
                            {formatSize(previewFile.size)} ·{' '}
                            {c.materials!.find((m) => m.id === previewFile.materialId)?.name ||
                              '未分类'}{' '}
                            · {materialStateLabels[fileState(previewFile)]}
                          </small>
                        </div>
                        <div className="button-row">
                          {canEdit && (
                            <button
                              type="button"
                              className="button"
                              disabled={busy || !state.ready}
                              onClick={() => {
                                const already = selection.files.some((s) => s.id === previewFile.id)
                                selectFiles(
                                  already
                                    ? chosen.filter((v) => v.id !== previewFile.id)
                                    : [...chosen, previewFile],
                                )
                              }}
                            >
                              {selection.files.some((s) => s.id === previewFile.id)
                                ? '取消勾选此文件'
                                : '勾选此文件核对'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() => onDetail(previewFile)}
                          >
                            文件详情
                          </button>
                          <a className="button" href={`/api/files/${previewFile.id}/download`}>
                            <Download size={14} />
                            下载
                          </a>
                        </div>
                      </header>
                      <FilePreview key={previewFile.id} file={previewFile} inline />
                    </div>
                  )}
                </>
              ) : (
                <div className="material-preview-empty">
                  <Eye size={28} strokeWidth={1.5} />
                  <h4>暂未收到这位参与人的文件</h4>
                  <p>
                    尚缺必需材料：
                    {person.slots
                      .filter((s) => s.requirement.required && !s.files.length)
                      .map((s) => s.requirement.name)
                      .join('、') || '请检查材料要求'}
                  </p>
                  {canEdit && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => setReminder({ mode: 'direct', personId: person.identity })}
                    >
                      <MessageSquareText size={15} />
                      生成单人催交话术
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="material-review-form">
              <div className="material-person-next">
                <strong>{personAction(person.status)}</strong>
                <p>
                  {person.status === 'needs_changes'
                    ? '下方保留具体补充原因。本人替换后，新文件会重新等待核对。'
                    : person.status === 'missing'
                      ? `尚缺：${
                          person.slots
                            .filter((s) => s.requirement.required && !s.files.length)
                            .map((s) => s.requirement.name)
                            .join('、') || '存在重复内容，请查看逐项记录'
                        }。可分享原链接或复制私聊催交话术。`
                      : person.status === 'unclassified'
                        ? '先选择文件并确认材料归属，再进行人工核对。'
                        : person.reviewComplete
                          ? '当前材料已人工核对通过。文件或规则变化后，旧结论不会自动沿用。'
                          : '左侧直接预览内容，右侧勾选文件并给出核对结论，可一键保存并跳转下一位。'}
                </p>
                {canEdit && !person.reviewComplete && (
                  <div className="button-row">
                    <button
                      type="button"
                      className="button"
                      onClick={() => setReminder({ mode: 'direct', personId: person.identity })}
                    >
                      <MessageSquareText size={15} />
                      生成单人催交话术
                    </button>
                    {!person.receivedComplete && (
                      <button type="button" className="button" onClick={onShare}>
                        分享链接，提醒本人补交
                      </button>
                    )}
                  </div>
                )}
              </div>
              {[
                ...person.slots.map((s) => ({
                  id: s.requirement.id,
                  title: `${s.requirement.name} · ${s.requirement.required ? '必需' : '选填'}`,
                  description: s.requirement.description,
                  files: s.files,
                })),
                ...(person.unclassified.length
                  ? [
                      {
                        id: 'unknown',
                        title: '未分类 / 原材料项已移除',
                        description: '请先明确归属，不能直接标记核对通过。',
                        files: person.unclassified,
                      },
                    ]
                  : []),
              ].map((group) => (
                <div className="material-detail-group" key={group.id}>
                  <h4>{group.title}</h4>
                  <p>{group.description}</p>
                  {!group.files.length ? (
                    <p className="material-missing">
                      {group.id !== 'unknown' &&
                      c.materials!.find((m) => m.id === group.id)?.required
                        ? '尚缺此项材料'
                        : '选填项尚未提交'}
                    </p>
                  ) : (
                    group.files.map((f) => (
                      <article
                        className={`material-file ${previewFile?.id === f.id ? 'previewing' : ''}`}
                        key={f.id}
                      >
                        <div className="material-file-heading">
                          {canEdit && (
                            <input
                              type="checkbox"
                              aria-label={`选择核对${f.name}`}
                              disabled={busy || !state.ready}
                              checked={selection.files.some((s) => s.id === f.id)}
                              onChange={(e) =>
                                selectFiles(
                                  e.target.checked
                                    ? [...chosen, f]
                                    : chosen.filter((v) => v.id !== f.id),
                                )
                              }
                            />
                          )}
                          <strong>{f.name}</strong>
                          <span className={`mstate ${fileState(f)}`}>
                            {materialStateLabels[fileState(f)]}
                          </span>
                        </div>
                        <small>
                          {formatSize(f.size)} · 文件版本 {f.materialVersion || 0}
                        </small>
                        {f.materialReview && (
                          <p>
                            {fileState(f) === 'stale' ? '旧核对说明（已过期）：' : '核对说明：'}
                            {f.materialReview.note || '未填写说明'}
                            <small>
                              {f.materialReview.reviewerName} ·{' '}
                              {new Date(f.materialReview.reviewedAt).toLocaleString('zh-CN', {
                                hour12: false,
                              })}
                            </small>
                          </p>
                        )}
                        <div className="button-row">
                          <button
                            type="button"
                            className={`button ${previewFile?.id === f.id ? 'chosen' : ''}`}
                            disabled={busy}
                            onClick={() => setPreviewFileId(f.id)}
                          >
                            <Eye size={14} />
                            {previewFile?.id === f.id ? '正在左侧预览' : '左侧预览'}
                          </button>
                          <a className="button" href={`/api/files/${f.id}/download`}>
                            下载
                          </a>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              ))}
              {canEdit && !!person.files.length && (
                <section className="material-actions" aria-label="处理所选材料">
                  {aiReview && (
                    <p className="form-note">
                      已带入预核对建议，请编辑归属或核对说明后，明确点击保存。AI 未批准任何材料。
                    </p>
                  )}
                  <div className="section-heading">
                    <h4>处理所选 {selection.files.length} 份文件</h4>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || !state.ready}
                      onClick={() => selectFiles(person.files.slice(0, 50))}
                    >
                      选择此人前 50 份
                    </button>
                  </div>
                  {staleSelection && (
                    <p className="error-text" role="alert">
                      材料规则、文件分类或核对版本已变化，请清除后重新选择。
                    </p>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => selectFiles([])}
                  >
                    清除选择
                  </button>
                  <fieldset
                    disabled={
                      busy || !state.ready || !chosen.length || staleSelection || chosen.length > 50
                    }
                  >
                    <label className="field">
                      所选文件归到哪项材料
                      <select
                        value={draft.materialId}
                        onChange={(e) => setDraft({ materialId: e.target.value })}
                      >
                        <option value="">未分类</option>
                        {c.materials!.map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="button" onClick={() => void apply('classify')}>
                      保存所选归属
                    </button>
                    <label className="field">
                      人工核对结论
                      <select
                        value={draft.decision}
                        onChange={(e) =>
                          setDraft({ decision: e.target.value as Draft['decision'] })
                        }
                      >
                        <option value="">请选择核对结论</option>
                        <option value="accepted">核对通过</option>
                        <option value="needs_changes">需补充或纠正</option>
                      </select>
                    </label>
                    <p className="field-hint">
                      这个浏览器会暂存未保存的说明。重新进入时，请重选当前材料和核对结论。
                    </p>
                    <label className="field">
                      核对说明
                      <textarea
                        ref={noteInputRef}
                        rows={3}
                        maxLength={300}
                        value={draft.note}
                        onChange={(e) => setDraft({ note: e.target.value })}
                        placeholder="需补充时说明具体要改什么；这段说明可由本人回执查看（按 Ctrl+Enter 快速提交）"
                      />
                    </label>
                    {!!chosen.length && !!remainingUnreviewedForPerson.length && (
                      <p className="field-hint" role="status">
                        当前参与人还有 {remainingUnreviewedForPerson.length}{' '}
                        份未核对文件未勾选，保存并继续将保留在本页并切换至下一份未审文件，避免漏审。
                      </p>
                    )}
                    <div className="button-row">
                      <button
                        type="button"
                        className="button primary"
                        disabled={!draft.decision}
                        onClick={() => void apply('review', false)}
                      >
                        {busy ? '保存中…' : '保存人工核对'}
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={
                          !draft.decision ||
                          (!nextPendingPerson && !remainingUnreviewedForPerson.length)
                        }
                        title={
                          remainingUnreviewedForPerson.length
                            ? `当前参与人还有 ${remainingUnreviewedForPerson.length} 份未核对文件，保存后将留在当前页继续审阅`
                            : nextPendingPerson
                              ? `保存当前核对并跳转至 ${nextPendingPerson.identity}`
                              : '当前没有下一位待核对参与人'
                        }
                        onClick={() => void apply('review', true)}
                      >
                        {busy
                          ? '保存中…'
                          : remainingUnreviewedForPerson.length
                            ? `保存并审同人下一份（剩 ${remainingUnreviewedForPerson.length} 份）`
                            : nextPendingPerson
                              ? `保存并跳转下一位待核对（${otherPendingPeople.length}）`
                              : '已无下一位待核对'}
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </fieldset>
                  <MaterialAIPanel
                    key={person.identity}
                    collection={c}
                    personId={person.identity}
                    selected={staleSelection ? [] : chosen}
                    allFiles={person.files}
                    scopeVersion={report?.stateVersion || ''}
                    disabled={!state.ready}
                    onDetail={(f) => setPreviewFileId(f.id)}
                    onPrepare={(plan, finding) => {
                      const file = person.files.find((f) => f.id === finding.fileId)
                      const source = plan.preview.sources.find((f) => f.id === finding.fileId)
                      if (!state.ready || !file || !source) return
                      setPreviewFileId(file.id)
                      selectFiles([file])
                      setSelection({
                        rulesRevision: plan.preview.rulesRevision,
                        files: [{ id: file.id, expectedVersion: source.expectedVersion }],
                      })
                      setDrafts((old) => ({
                        ...old,
                        [personId]: {
                          materialId: finding.materialId || file.materialId || '',
                          decision: 'needs_changes',
                          note: finding.message.slice(0, 300),
                        },
                      }))
                      setAIReview({ runId: plan.runId, fileId: file.id, acknowledged: true })
                      setNotice('建议已带入人工处理，请核对后手动保存。')
                    }}
                  />
                </section>
              )}
            </div>
          </div>
        </section>
      )}
      {error && (
        <div className="error-text" role="alert">
          {error}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={async () => {
              await onRefresh()
              selectFiles([])
              setNotice('已更新记录，请重新选择并确认。')
            }}
          >
            更新记录并重新选择
          </button>
        </div>
      )}
      {notice && (
        <p className="success-text" role="status">
          {notice}
        </p>
      )}
      <p className="field-hint">
        导出由服务器按当前规则和文件状态生成，包含缺项及未通过结果；它不是全部合格的证明。
      </p>
      {archiveOpen && (
        <ArchiveModal
          files={files}
          collections={[c]}
          defaultLayout="material-owner"
          defaultAcceptedOnly
          onClose={() => setArchiveOpen(false)}
        />
      )}
      {reminder && (
        <ReminderModal
          collection={c}
          initialMode={reminder.mode}
          initialPersonId={reminder.personId}
          materialParticipants={rows}
          onClose={() => setReminder(null)}
        />
      )}
    </section>
  )
}
