import { useEffect, useState } from 'react'
import { ArrowRight, Check, Info, WandSparkles } from 'lucide-react'
import { FileIcon, Modal } from '../components/ui'
import { fetchAllPaginatedFiles } from '../lib/api'
import { hasUnsafeFilenameChars } from '../lib/text-safety'
import type { CollectedFile, Collection } from '../types'

export function getRenames(files: CollectedFile[], collections: Collection[], pattern: string) {
  return files.map((file, index) => {
    const dot = file.name.lastIndexOf('.')
    const extension = dot > 0 ? file.name.slice(dot) : ''
    const base = dot > 0 ? file.name.slice(0, dot) : file.name
    const collection = collections.find((c) => c.id === file.collectionId)
    const title = collection?.title || '未分类'
    const materialName =
      (file.materialId && collection?.materials?.find((m) => m.id === file.materialId)?.name) ||
      '未分类'
    const name =
      pattern
        .replaceAll('{任务}', title)
        .replaceAll('{提交人}', file.owner)
        .replaceAll('{材料项}', materialName)
        .replaceAll('{序号}', String(index + 1).padStart(2, '0'))
        .replaceAll('{原名}', base)
        .replaceAll('{日期}', file.createdAt.slice(0, 10).replaceAll('-', ''))
        .trim() + extension
    return { id: file.id, oldName: file.name, name }
  })
}

export function RenameModal({
  files,
  allFiles,
  collections,
  summaryMode = false,
  onClose,
  onApply,
  busy = false,
  serverError,
}: {
  files: CollectedFile[]
  allFiles: CollectedFile[]
  collections: Collection[]
  summaryMode?: boolean
  onClose: () => void
  busy?: boolean
  serverError?: string
  onApply: (changes: { id: string; name: string; oldName: string }[]) => void
}) {
  const [pattern, setPattern] = useState('{任务}_{提交人}_{序号}')
  const [loadedAllFiles, setLoadedAllFiles] = useState<CollectedFile[] | null>(null)
  const touchedCollectionKey = [...new Set(files.map((f) => f.collectionId))].sort().join(',')
  useEffect(() => {
    if (!summaryMode || !touchedCollectionKey) {
      setLoadedAllFiles(null)
      return
    }
    const controller = new AbortController()
    const cids = touchedCollectionKey.split(',')
    void Promise.all(
      cids.map((cid) =>
        fetchAllPaginatedFiles(
          `/api/collections/${encodeURIComponent(cid)}/files`,
          new URLSearchParams({ sort: 'created_desc' }),
          10000,
          controller.signal,
        ).then((r) => r.items),
      ),
    )
      .then((lists) => {
        if (!controller.signal.aborted) setLoadedAllFiles(lists.flat())
      })
      .catch(() => {
        /* Server still enforces atomic uniqueness on submit. */
      })
    return () => controller.abort()
  }, [summaryMode, touchedCollectionKey])
  const effectiveAllFiles = loadedAllFiles ?? allFiles
  const changes = getRenames(files, collections, pattern)
  const changeById = new Map(changes.map((c) => [c.id, c.name]))
  const selectedById = new Map(files.map((f) => [f.id, f]))
  const countsByCollection = new Map<string, Map<string, number>>()
  for (const f of effectiveAllFiles) {
    let counts = countsByCollection.get(f.collectionId)
    if (!counts) {
      counts = new Map()
      countsByCollection.set(f.collectionId, counts)
    }
    const key = (changeById.get(f.id) ?? f.name).toLowerCase()
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const invalid =
    !pattern.trim() ||
    hasUnsafeFilenameChars(pattern, false) ||
    /[{}]/.test(pattern.replace(/\{(任务|提交人|材料项|序号|原名|日期)\}/g, '')) ||
    changes.some(
      (c) => c.name.length > 200 || !c.name.trim() || hasUnsafeFilenameChars(c.name, false),
    )
  const duplicate = changes.some((c) => {
    const file = selectedById.get(c.id)
    return !!file && (countsByCollection.get(file.collectionId)?.get(c.name.toLowerCase()) || 0) > 1
  })
  return (
    <Modal
      title="给文件，一个整齐的名字"
      subtitle={`批量重命名 · 已选择 ${files.length} 个文件`}
      onClose={onClose}
      wide
    >
      <label className="field">
        命名规则
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="命名规则" />
      </label>
      <div className="token-list">
        {['{任务}', '{提交人}', '{材料项}', '{序号}', '{原名}', '{日期}'].map((token) => (
          <button type="button" key={token} onClick={() => setPattern(pattern + token)}>
            {token}
          </button>
        ))}
        <span>点击插入变量 · 自动保留扩展名</span>
      </div>
      <div className="rename-preview">
        <div className="rename-labels">
          <span>原文件名</span>
          <span>重命名后</span>
        </div>
        {changes.map((c) => (
          <div className="rename-row" key={c.id}>
            <span>
              <FileIcon name={c.oldName} />
              {c.oldName}
            </span>
            <ArrowRight size={15} />
            <strong>{c.name}</strong>
          </div>
        ))}
      </div>
      {invalid ? (
        <p className="error-text" role="alert">
          请输入有效规则，仅支持上面的变量，且不能包含路径或特殊符号。
        </p>
      ) : duplicate ? (
        <p className="error-text" role="alert">
          发现重名文件，请加入「序号」或调整规则。
        </p>
      ) : (
        <p className="success-text">
          <Check size={15} />
          命名检查通过，没有重名文件
        </p>
      )}
      <div className="form-note">
        <Info size={15} />
        预览确认后才会应用。服务器会再次检查重名并一次完成修改，文件内容保持不变；可撤销最近的命名操作。
      </div>
      {serverError && (
        <p className="error-text" role="alert">
          {serverError}
        </p>
      )}
      <footer className="modal-footer">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={invalid || duplicate || !files.length || busy}
          onClick={() => onApply(changes)}
        >
          <WandSparkles size={15} />
          {busy ? '正在保存…' : `应用到 ${files.length} 个文件`}
        </button>
      </footer>
    </Modal>
  )
}
