import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, FileUp, LockKeyhole } from 'lucide-react'
import { Brand } from '../components/ui'
import { ThemeSwitch } from '../components/theme-switch'
import {
  api,
  uploadFiles,
  discardUpload,
  recoverUploadReceipt,
  hasPendingUpload,
  pendingSubmission,
} from '../lib/api'
import { fileExtensions, isExpired, submissionError, effectiveFileLimit } from '../lib/collections'
import { formatSize } from '../lib/workspace'
import { ReceiptManager } from './submission-receipt'
import { SampleSubmitHint } from './sample-tour'
import { UploadList } from './upload-list'
import { descriptorKey } from '../lib/materials'
import { safeRandomUUID } from '../lib/browser-crypto'
import type {
  Collection,
  UploadReceipt,
  ReceiptDetail,
  SubmissionMetadata,
  UploadFeedback,
} from '../types'

type PublicResponse =
  | { locked: true }
  | { locked?: false; collection: Collection; ownerName: string }

export function PublicSubmission({ uploadToken }: { uploadToken: string }) {
  const [info, setInfo] = useState<{ collection: Collection; ownerName: string } | null>(null),
    [locked, setLocked] = useState(false),
    [passcode, setPasscode] = useState(''),
    [unlocking, setUnlocking] = useState(false),
    [unlockError, setUnlockError] = useState(''),
    [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    void retry
    let alive = true
    const load = async () => {
      try {
        const data = await api<PublicResponse>(`/api/public/${encodeURIComponent(uploadToken)}`)
        if (!alive) return
        if ('locked' in data && data.locked) {
          setLocked(true)
          setInfo(null)
          setError('')
        } else if ('collection' in data) {
          setLocked(false)
          setInfo({ collection: data.collection, ownerName: data.ownerName })
          setError('')
        }
      } catch (e) {
        if (alive) setError((e as Error).message)
      }
    }
    void load()
    const timer = setInterval(() => void load(), 15000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [uploadToken, retry])

  async function submitPasscode(e: React.FormEvent) {
    e.preventDefault()
    if (unlocking) return
    const code = passcode.trim()
    if (code.length < 4 || code.length > 8) {
      setUnlockError('请输入 4–8 位提取码。')
      return
    }
    setUnlocking(true)
    setUnlockError('')
    try {
      const data = await api<{ unlocked: true; collection: Collection; ownerName: string }>(
        `/api/public/${encodeURIComponent(uploadToken)}/unlock`,
        'POST',
        { accessCode: code },
      )
      setLocked(false)
      setPasscode('')
      setInfo({ collection: data.collection, ownerName: data.ownerName })
      setError('')
    } catch (err) {
      setUnlockError((err as Error).message)
    } finally {
      setUnlocking(false)
    }
  }

  if (locked)
    return (
      <main className="auth-page">
        <div className="auth-top">
          <Brand />
          <ThemeSwitch compact />
        </div>
        <section className="auth-card">
          <span className="auth-symbol">
            <LockKeyhole size={24} strokeWidth={1.4} />
          </span>
          <p className="eyebrow">ACCESS CODE REQUIRED</p>
          <h1>请输入提取码</h1>
          <p>这项收集已开启提取码保护。验证通过后即可查看收集说明、材料清单并上传文件。</p>
          <form onSubmit={(e) => void submitPasscode(e)}>
            <fieldset disabled={unlocking}>
              <label className="field">
                访问提取码
                <input
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  required
                  minLength={4}
                  maxLength={8}
                  placeholder="请输入 4–8 位提取码"
                  autoComplete="one-time-code"
                />
              </label>
              {unlockError && (
                <p className="error-text" role="alert">
                  {unlockError}
                </p>
              )}
              <button type="submit" className="button primary submit-button">
                {unlocking ? '验证中…' : '验证并进入提交页'}
                <ArrowRight size={16} />
              </button>
            </fieldset>
          </form>
        </section>
      </main>
    )
  if (!info)
    return (
      <main className="auth-page">
        <div className="auth-top">
          <Brand />
          <ThemeSwitch compact />
        </div>
        <section className="auth-card">
          <h1>{error ? '暂时无法打开这项收集' : '正在打开收集…'}</h1>
          <p>{error || '正在读取最新的收集规则。'}</p>
          {error && (
            <button type="button" className="button" onClick={() => setRetry((n) => n + 1)}>
              重新打开
            </button>
          )}
        </section>
      </main>
    )
  return (
    <>
      {error && (
        <div className="submission-refresh-error" role="alert">
          收集信息暂未更新：{error}。已选文件和上传进度已保留。
          <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
            重试读取
          </button>
        </div>
      )}
      <Submission
        key={uploadToken}
        collection={info.collection}
        ownerName={info.ownerName}
        uploadToken={uploadToken}
      />
    </>
  )
}

function Submission({
  collection: c,
  ownerName,
  uploadToken,
}: {
  collection: Collection
  ownerName: string
  uploadToken: string
}) {
  const [draft] = useState(() => pendingSubmission(uploadToken))
  const [materialChoices, setMaterialChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (draft.files || []).map((f, i) => [descriptorKey(f), draft.materialIds?.[i] || '']),
    ),
  )
  const [files, setFiles] = useState<File[]>([]),
    [name, setName] = useState(() => pendingSubmission(uploadToken).owner || ''),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<UploadReceipt | null>(null)
  const [dragging, setDragging] = useState(false),
    [progress, setProgress] = useState(0),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now)
  const [fields, setFields] = useState<Record<string, string>>(
      () => pendingSubmission(uploadToken).fields || {},
    ),
    [replacement, setReplacement] = useState<SubmissionMetadata['replace']>(
      () => pendingSubmission(uploadToken).replace,
    )
  const [confirming, setConfirming] = useState(false)
  const [feedback, setFeedback] = useState<UploadFeedback | null>(null)
  const [pending, setPending] = useState(() => hasPendingUpload(uploadToken))
  const picker = useRef<HTMLInputElement>(null),
    form = useRef<HTMLFormElement>(null),
    controller = useRef<AbortController | null>(null),
    requestId = useRef(safeRandomUUID())
  // Files picked from a material card are assigned to that material; the generic drop zone leaves them unclassified.
  const pickFor = useRef('')
  const submitButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000)
    return () => {
      clearInterval(timer)
      controller.current?.abort()
    }
  }, [])
  const ended = c.status !== 'active' || isExpired(c, now)
  function continueSubmission(detail: ReceiptDetail, replace: boolean, key: string) {
    setMaterialChoices({})
    setName(detail.owner)
    setFields(detail.fields)
    setReplacement(replace ? { receiptId: detail.receipt.receiptId, key } : undefined)
    setReceipt(null)
    setFeedback(null)
    setFiles([])
    setError('')
    setPending(hasPendingUpload(uploadToken))
    requestId.current = safeRandomUUID()
  }
  const receiptManager = (
    <>
      <SampleSubmitHint collectionId={c.id} done={!!receipt} />
      <ReceiptManager
        c={c}
        uploadToken={uploadToken}
        receipt={receipt}
        onOpen={setReceipt}
        onContinue={continueSubmission}
      />
    </>
  )
  function addFiles(incoming: FileList | null, materialId = '') {
    if (!incoming || busy) return
    const next = [...files],
      added: File[] = []
    for (const file of Array.from(incoming))
      if (
        !next.some(
          (f) =>
            f.name === file.name && f.size === file.size && f.lastModified === file.lastModified,
        )
      ) {
        next.push(file)
        added.push(file)
      }
    const invalid = submissionError(c, next)
    if (invalid) {
      setError(invalid)
      return
    }
    if (next.reduce((sum, f) => sum + f.size, 0) > (c.requestLimitMB || 512) * 1024 ** 2) {
      setError(`单次提交总量不能超过 ${c.requestLimitMB || 512} MB`)
      return
    }
    if (materialId && c.materials?.some((m) => m.id === materialId))
      setMaterialChoices((old) => ({
        ...old,
        ...Object.fromEntries(added.map((f) => [descriptorKey(f), materialId])),
      }))
    setFeedback(null)
    setFiles(next)
    setError('')
    requestId.current = safeRandomUUID()
  }
  function openPicker(materialId = '') {
    pickFor.current = materialId
    picker.current?.click()
  }
  const choiceOf = (f: File) =>
    c.materials?.some((m) => m.id === materialChoices[descriptorKey(f)])
      ? materialChoices[descriptorKey(f)]
      : ''
  async function submit() {
    if (busy) return
    if (!form.current?.reportValidity()) return
    const invalid = submissionError(c, files)
    if (invalid || !name.trim()) {
      setError(invalid || '请填写你的姓名')
      return
    }
    const missing = c.fields?.find((f) => f.required && !fields[f.id]?.trim())
    if (missing) {
      setError(`请填写${missing.label}`)
      return
    }
    setBusy(true)
    setPending(true)
    setError('')
    setProgress(0)
    controller.current = new AbortController()
    try {
      setReceipt(
        await uploadFiles(
          uploadToken,
          files,
          name.trim(),
          requestId.current,
          setProgress,
          controller.current.signal,
          {
            fields: Object.fromEntries((c.fields || []).map((f) => [f.id, fields[f.id] || ''])),
            ...(c.materials?.length
              ? {
                  materialIds: files.map((f) =>
                    c.materials!.some((m) => m.id === materialChoices[descriptorKey(f)])
                      ? materialChoices[descriptorKey(f)]
                      : '',
                  ),
                }
              : {}),
            ...(replacement ? { replace: replacement } : {}),
          },
          setFeedback,
        ),
      )
      setPending(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="submission-page">
      <div className="submission-top">
        <Brand />
        <div className="submission-top-right">
          <ThemeSwitch compact />
          <span className="preview-badge">文件提交</span>
        </div>
      </div>
      <section className="submission-card">
        {receipt ? (
          <div className="submission-success">
            <CheckCircle2 size={52} strokeWidth={1.4} />
            <p className="eyebrow">ALL SET</p>
            <h1>每一份认真，都已收到。</h1>
            <p>{receipt.filesCount} 份文件已保存到发起人的服务器。</p>
            <div className="receipt-box">
              <span>提交回执</span>
              <code>{receipt.receiptId}</code>
              <small>共 {formatSize(receipt.bytes)} · 请保留回执，方便联系发起人。</small>
            </div>
            {receiptManager}
          </div>
        ) : (
          <>
            <span className="submission-kicker">{ownerName} 邀请你提交文件</span>
            <h1>{c.title}</h1>
            <p className="submission-description">{c.description}</p>
            <div className="submission-meta">
              <span>截止 {c.deadline}</span>
              <span>
                {c.activeFiles !== undefined
                  ? c.activeFiles === c.received
                    ? `当前有效 ${c.activeFiles} 份`
                    : `当前有效 ${c.activeFiles} 份 · 累计提交 ${c.received} 份`
                  : `累计提交 ${c.received} 份`}
              </span>
            </div>
            {!busy && receiptManager}
            {pending && !busy && (
              <div className="form-note">
                上次提交未取得回执，可直接确认结果，无需重新选择文件。
                <button
                  type="button"
                  className="button"
                  disabled={confirming}
                  onClick={async () => {
                    setConfirming(true)
                    setError('')
                    try {
                      const saved = await recoverUploadReceipt(uploadToken)
                      if (saved) {
                        setReceipt(saved)
                        setPending(false)
                      } else setError('这批文件尚未保存，请选择原文件继续上传。')
                    } catch (e) {
                      setError((e as Error).message)
                    } finally {
                      setConfirming(false)
                    }
                  }}
                >
                  确认上次提交结果
                </button>
              </div>
            )}
            {ended && !busy ? (
              <div className="empty">
                <LockKeyhole size={30} />
                <h3>
                  {c.status === 'active'
                    ? '这项收集已截止'
                    : c.status === 'paused'
                      ? '这项收集已暂停'
                      : '这项收集已结束'}
                </h3>
                <p>请联系发起人了解下一步安排。</p>
                {error && (
                  <p className="error-text" role="alert">
                    {error}
                  </p>
                )}
              </div>
            ) : (
              <form
                ref={form}
                onSubmit={(e) => {
                  e.preventDefault()
                  void submit()
                }}
              >
                <fieldset disabled={busy || confirming}>
                  {pending && (
                    <div className="form-note">
                      已启用断点续传。刷新后重新填写原姓名和提交信息、选择原文件即可继续，分片保留
                      24 小时。
                      <button
                        type="button"
                        className="text-button"
                        onClick={async () => {
                          setBusy(true)
                          try {
                            await discardUpload(uploadToken)
                            setPending(false)
                            setFeedback(null)
                            setError('')
                            requestId.current = safeRandomUUID()
                          } catch (e) {
                            setError((e as Error).message)
                          } finally {
                            setBusy(false)
                          }
                        }}
                      >
                        重新开始
                      </button>
                    </div>
                  )}
                  <label className="field">
                    你的姓名
                    <input
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value)
                        requestId.current = safeRandomUUID()
                      }}
                      required
                      maxLength={30}
                      placeholder="方便发起人知道文件来自你"
                      autoComplete="name"
                    />
                  </label>
                  {(c.fields || []).map((f) => (
                    <label className="field" key={f.id}>
                      {f.label}
                      {!f.required && '（选填）'}
                      <input
                        value={fields[f.id] || ''}
                        required={f.required}
                        maxLength={80}
                        onChange={(e) => setFields((old) => ({ ...old, [f.id]: e.target.value }))}
                      />
                    </label>
                  ))}
                  {replacement && (
                    <div className="replacement-note">
                      <strong>正在替换原批次</strong>
                      <p>
                        请重新选择这批完整文件。提交成功后原批次进入回收站，其他补交批次保持保留。
                      </p>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setReplacement(undefined)}
                      >
                        取消替换，改为普通提交
                      </button>
                    </div>
                  )}
                  {c.maxFileSizeMB > effectiveFileLimit(c) && (
                    <p className="field-hint">
                      当前服务器单次接收上限为 {c.requestLimitMB ?? 512}{' '}
                      MB，单文件可上传上限已按此调整。
                    </p>
                  )}
                  {!!c.naming?.parts.length && (
                    <p className="field-hint">发起人已设置自动命名，原扩展名和原名记录会保留。</p>
                  )}
                  {!!c.materials?.length && (
                    <section className="submission-materials" aria-label="本批文件材料归属">
                      <h3>本次要交的材料</h3>
                      <p className="field-hint">
                        点每项材料下方的按钮上传，文件会自动归到这一项；也可以分批提交。“已选择”只代表这批将要上传，收到后仍由发起人人工核对。
                      </p>
                      <div className="material-cards">
                        {c.materials.map((m) => {
                          const mine = files.filter((f) => choiceOf(f) === m.id)
                          return (
                            <article
                              key={m.id}
                              className={`material-card ${mine.length ? 'has-files' : ''}`}
                            >
                              <header>
                                <strong>{m.name}</strong>
                                <span className={`mstate ${m.required ? 'required' : 'optional'}`}>
                                  {m.required ? '必需' : '选填'}
                                </span>
                              </header>
                              {m.description && <p>{m.description}</p>}
                              {mine.length > 0 && (
                                <ul>
                                  {mine.map((f) => (
                                    <li key={descriptorKey(f)}>
                                      {f.name}
                                      <small>{formatSize(f.size)}</small>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <button
                                type="button"
                                className="button material-pick"
                                onClick={() => openPicker(m.id)}
                              >
                                <FileUp size={16} />
                                {mine.length ? `再选 ${m.name}` : `上传 ${m.name}`}
                              </button>
                            </article>
                          )
                        })}
                      </div>
                      {files.length > 0 && (
                        <details className="material-adjust" open={files.some((f) => !choiceOf(f))}>
                          <summary>
                            {files.filter((f) => !choiceOf(f)).length
                              ? `${files.filter((f) => !choiceOf(f)).length} 份文件还没选归属`
                              : '调整已选文件的归属'}
                          </summary>
                          {files.map((f) => (
                            <label className="field" key={descriptorKey(f)}>
                              {f.name} 的材料归属
                              <select
                                value={choiceOf(f)}
                                onChange={(e) =>
                                  setMaterialChoices((old) => ({
                                    ...old,
                                    [descriptorKey(f)]: e.target.value,
                                  }))
                                }
                              >
                                <option value="">未分类，交给发起人确认</option>
                                {c.materials!.map((m) => (
                                  <option value={m.id} key={m.id}>
                                    {m.name}
                                    {m.required ? '（必需）' : '（选填）'}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ))}
                          <p className="field-hint">未分类文件仍会收到，但不计入必需材料收齐。</p>
                        </details>
                      )}
                    </section>
                  )}
                  {!!files.length && (
                    <div className="submission-ready-link">
                      <span>这批已选择 {files.length} 份文件</span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          submitButton.current?.scrollIntoView({
                            block: 'center',
                            behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
                              ? 'instant'
                              : 'smooth',
                          })
                          submitButton.current?.focus({ preventScroll: true })
                        }}
                      >
                        前往提交
                      </button>
                    </div>
                  )}
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    accept={fileExtensions(c.formats)
                      .map((s) => `.${s}`)
                      .join(',')}
                    className="sr-only"
                    onChange={(e) => {
                      addFiles(e.target.files, pickFor.current)
                      pickFor.current = ''
                      e.target.value = ''
                    }}
                    aria-label="选择提交文件"
                  />
                  <button
                    type="button"
                    className={`drop-zone ${dragging ? 'dragging' : ''} ${c.materials?.length ? 'secondary' : ''}`}
                    onClick={() => openPicker()}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragging(true)
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDragging(false)
                      addFiles(e.dataTransfer.files)
                    }}
                  >
                    <span>
                      <FileUp size={29} strokeWidth={1.5} />
                    </span>
                    <strong>
                      {c.materials?.length
                        ? '其他文件：点击选择或拖到这里'
                        : '点击选择，或把文件拖到这里'}
                    </strong>
                    <p>
                      {c.formats}
                      <br />
                      单文件 ≤ {effectiveFileLimit(c)} MB · 每次最多 {c.maxFilesPerSubmission} 个
                      <br />
                      单次总量 ≤ {c.requestLimitMB || 512} MB
                    </p>
                  </button>

                  <UploadList
                    files={files}
                    feedback={feedback}
                    busy={busy}
                    onRetry={() => void submit()}
                    onRemove={(i) => {
                      setFiles((old) => old.filter((_, index) => index !== i))
                      setFeedback(null)
                      setError('')
                      requestId.current = safeRandomUUID()
                    }}
                  />
                  <div className="form-note">
                    文件将保存到发起人的服务器，仅工作台授权成员可查看和下载。
                  </div>
                  <button
                    ref={submitButton}
                    className="button primary submit-button"
                    type="submit"
                    disabled={!files.length}
                  >
                    {busy
                      ? `上传中 ${progress}%`
                      : feedback?.phase === 'paused'
                        ? '继续上传'
                        : error
                          ? '重试并确认回执'
                          : replacement
                            ? `确认替换为 ${files.length} 份文件`
                            : `提交${files.length ? ` ${files.length} 份` : ''}文件`}
                    <ArrowRight size={16} />
                  </button>
                </fieldset>
                {busy && (
                  <div className="upload-progress" role="status">
                    <div className="progress">
                      <span style={{ width: `${progress}%` }} />
                    </div>
                    <p>
                      {feedback?.phase === 'saving'
                        ? '文件已传完，正在等待整批回执…'
                        : feedback?.phase === 'preparing'
                          ? '正在连接并读取续传记录…'
                          : `已确认传输 ${progress}%`}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => controller.current?.abort()}
                      >
                        暂停上传
                      </button>
                    </p>
                  </div>
                )}
                {error && (
                  <p className="error-text" role="alert">
                    {error}
                  </p>
                )}
              </form>
            )}
          </>
        )}
      </section>
      <footer className="submission-bottom">
        <span>
          <LockKeyhole size={13} />
          仅工作台授权成员可见
        </span>
        <span>由集屿提供支持</span>
      </footer>
    </main>
  )
}
