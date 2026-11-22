import { useMemo, useRef, useState } from 'react'
import { FileUp, Upload, X } from 'lucide-react'
import { Modal } from '../components/ui'
import type { CollectedFile, Collection, Workspace } from '../types'
import { effectiveFileLimit, fileExtension, fileExtensions } from '../lib/collections'
import { descriptorKey } from '../lib/materials'
import { fileNameKey, submissionFileName } from '../lib/submission-naming'
import { uploadAdminOffline } from '../lib/api'
import { formatSize } from '../lib/workspace'

export function OfflineUploadModal({
  collection: c,
  existingFiles,
  initialOwner = '',
  initialIdentity = '',
  onClose,
  onUploaded,
}: {
  collection: Collection
  existingFiles: CollectedFile[]
  initialOwner?: string
  initialIdentity?: string
  onClose: () => void
  onUploaded: (result: { workspace: Workspace; files: CollectedFile[] }) => void
}) {
  const customIdentityId = c.identityField && c.identityField !== 'owner' ? c.identityField : ''
  const [owner, setOwner] = useState(
    initialOwner || (!customIdentityId && initialIdentity ? initialIdentity : ''),
  )
  const [fields, setFields] = useState<Record<string, string>>(() =>
    customIdentityId && initialIdentity ? { [customIdentityId]: initialIdentity } : {},
  )
  const [files, setFiles] = useState<File[]>([])
  const [materialChoices, setMaterialChoices] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [markReady, setMarkReady] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)

  const allowedExt = useMemo(() => fileExtensions(c.formats), [c.formats])
  const maxSingleMB = effectiveFileLimit(c)
  const datalistId = `offline-roster-${c.id}`

  function addFiles(incoming: FileList | null) {
    if (!incoming || busy) return
    const next = [...files]
    for (const file of Array.from(incoming)) {
      if (file.size === 0) {
        setError(`「${file.name}」是空文件，无法补录。`)
        return
      }
      if (!allowedExt.includes(fileExtension(file.name))) {
        setError(`「${file.name}」格式不符合任务要求（${c.formats}）。`)
        return
      }
      if (file.size > maxSingleMB * 1024 * 1024) {
        setError(`「${file.name}」超过单文件 ${maxSingleMB} MB 上限。`)
        return
      }
      if (
        !next.some(
          (f) =>
            f.name === file.name && f.size === file.size && f.lastModified === file.lastModified,
        )
      ) {
        next.push(file)
      }
    }
    if (next.length > c.maxFilesPerSubmission) {
      setError(`单次最多补录 ${c.maxFilesPerSubmission} 个文件。`)
      return
    }
    setFiles(next)
    setError('')
  }

  const previewNames = useMemo(() => {
    if (!files.length) return []
    const occupied = new Set(existingFiles.map((f) => fileNameKey(f.name)))
    const nowIso = new Date().toISOString()
    const cleanOwner = owner.trim() || '提交人'
    return files.map((file, i) => {
      const matId = materialChoices[descriptorKey(file)] || undefined
      return submissionFileName(
        c,
        file.name,
        cleanOwner,
        fields,
        c.received + i + 1,
        nowIso,
        occupied,
        matId,
      )
    })
  }, [c, existingFiles, files, owner, fields, materialChoices])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!owner.trim()) {
      setError('请填写提交人姓名。')
      return
    }
    for (const f of c.fields || []) {
      if (f.required && !fields[f.id]?.trim()) {
        setError(`请填写必填字段「${f.label}」。`)
        return
      }
    }
    if (!files.length) {
      setError('请至少选择 1 个补录文件。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await uploadAdminOffline(c.id, {
        owner: owner.trim(),
        files,
        fields: Object.fromEntries((c.fields || []).map((f) => [f.id, fields[f.id] || ''])),
        ...(c.materials?.length
          ? {
              materialIds: files.map((f) => materialChoices[descriptorKey(f)] || ''),
            }
          : {}),
        note: note.trim() || undefined,
        markReady,
      })
      onUploaded(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="管理员线下补录文件"
      subtitle={`任务：${c.title} · 自动套用任务命名规则`}
      onClose={() => {
        if (!busy) onClose()
      }}
      wide
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <fieldset disabled={busy}>
          <div className="form-note">
            适用于通过微信、邮件或线下 U
            盘收到的补充材料。补录不受任务暂停或截止时间限制，将自动归入指定提交人名下并套用当前命名规则。
          </div>

          {!!c.expectedSubmitters?.length && (
            <datalist id={datalistId}>
              {c.expectedSubmitters.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          )}

          <div className="form-row">
            <label className="field">
              提交人姓名
              <input
                required
                maxLength={30}
                list={!customIdentityId && c.expectedSubmitters?.length ? datalistId : undefined}
                placeholder="填写原提交人姓名"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </label>
            <label className="field">
              补录备注（选填）
              <input
                maxLength={100}
                placeholder="例如：微信私发转存 / 线下补交"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>

          {!!c.fields?.length && (
            <div className="form-row">
              {c.fields.map((f) => (
                <label className="field" key={f.id}>
                  {f.label}
                  {!f.required && '（选填）'}
                  <input
                    required={f.required}
                    maxLength={80}
                    list={
                      customIdentityId === f.id && c.expectedSubmitters?.length
                        ? datalistId
                        : undefined
                    }
                    value={fields[f.id] || ''}
                    onChange={(e) => setFields((old) => ({ ...old, [f.id]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}

          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            accept={allowedExt.map((ext) => `.${ext}`).join(',')}
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
            aria-label="选择补录文件"
          />

          <button
            type="button"
            className={`drop-zone secondary ${dragging ? 'dragging' : ''}`}
            onClick={() => picker.current?.click()}
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
              <FileUp size={24} strokeWidth={1.5} />
            </span>
            <strong>点击选择或拖入补录文件</strong>
            <p>
              允许格式：{c.formats} · 单文件 ≤ {maxSingleMB} MB · 最多 {c.maxFilesPerSubmission} 份
            </p>
          </button>

          {!!files.length && (
            <div className="offline-file-list">
              {files.map((file, idx) => {
                const key = descriptorKey(file)
                const renamed = previewNames[idx]
                return (
                  <div className="offline-file-item" key={key}>
                    <div className="offline-file-info">
                      <strong>{file.name}</strong>
                      <small>{formatSize(file.size)}</small>
                      {renamed && renamed !== file.name && (
                        <small className="offline-rename-preview">入库命名 → {renamed}</small>
                      )}
                    </div>
                    {!!c.materials?.length && (
                      <label className="offline-material-select">
                        <span className="sr-only">选择材料归属</span>
                        <select
                          aria-label={`${file.name} 的材料归属`}
                          value={materialChoices[key] || ''}
                          onChange={(e) =>
                            setMaterialChoices((old) => ({ ...old, [key]: e.target.value }))
                          }
                        >
                          <option value="">未分类</option>
                          {c.materials.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                              {m.required ? '（必需）' : '（选填）'}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => setFiles((old) => old.filter((_, i) => i !== idx))}
                    >
                      <X size={15} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <label className="check-label">
            <input
              type="checkbox"
              checked={markReady}
              onChange={(e) => setMarkReady(e.target.checked)}
            />
            入库后直接标记文件状态为「已整理」
          </label>

          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}

          <footer className="modal-footer">
            <button type="button" className="button" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="button primary" disabled={busy || !files.length}>
              <Upload size={15} />
              {busy ? '正在补录上传…' : `确认补录 ${files.length} 份文件`}
            </button>
          </footer>
        </fieldset>
      </form>
    </Modal>
  )
}
