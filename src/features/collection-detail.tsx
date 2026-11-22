import { useEffect, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  CirclePause,
  CopyPlus,
  Link,
  Pencil,
  Play,
  Upload,
} from 'lucide-react'
import { CollectionIcon, Modal } from '../components/ui'
import { FileTable } from './files'
import {
  collectionState,
  collectionStateNames,
  isExpired,
  effectiveFileLimit,
} from '../lib/collections'
import type {
  CollectedFile,
  Collection,
  CollectionStatus,
  MaterialOperation,
  Workspace,
} from '../types'
import { MaterialWorkbench } from './materials'
import { ParticipantLedger } from './participants'
import { SaveTemplate } from './collection-templates'
import { OfflineUploadModal } from './offline-upload-modal'
import { useAccount } from './auth'
import { materialProgress } from '../lib/materials'
import { fetchAllPaginatedFiles } from '../lib/api'

interface CollectionDetailProps {
  collection: Collection
  dataRevision: number
  files: CollectedFile[]
  summaryMode?: boolean
  onBack: () => void
  onEdit: () => void
  onShare: () => void
  onClone: () => void
  onArchive: () => void
  onStatus: (status: CollectionStatus) => void
  onRename: (files: CollectedFile[]) => void
  onReview: (ids: string[]) => void
  onDetail: (file: CollectedFile) => void
  onTrash?: (ids: string[]) => void
  onAI?: (files: CollectedFile[]) => void
  onMaterialAction: (kind: 'classify' | 'review', body: MaterialOperation) => Promise<void>
  onOfflineUploaded: (result: { workspace: Workspace; files: CollectedFile[] }) => void
  onRefresh: () => Promise<void>
}

export function CollectionDetail({
  collection: c,
  files: propFiles,
  summaryMode = false,
  dataRevision,
  onBack,
  onEdit,
  onShare,
  onClone,
  onArchive,
  onStatus,
  onRename,
  onReview,
  onDetail,
  onTrash,
  onAI,
  onMaterialAction,
  onOfflineUploaded,
  onRefresh,
}: CollectionDetailProps) {
  const [confirm, setConfirm] = useState<CollectionStatus | null>(null)
  const [tab, setTab] = useState(c.materials?.length ? 'materials' : 'files')
  const [selected, setSelected] = useState<{ ids: string[]; label: string } | null>(null)
  const [saveTemplate, setSaveTemplate] = useState(false)
  const [offlineTarget, setOfflineTarget] = useState<{ owner: string; identity: string } | null>(
    null,
  )
  const [loadedFiles, setLoadedFiles] = useState<CollectedFile[] | null>(null)
  const [filesLoading, setFilesLoading] = useState(summaryMode)
  const [filesError, setFilesError] = useState('')
  const [filesReloadTick, setFilesReloadTick] = useState(0)
  const { canEdit, isAdmin } = useAccount()

  useEffect(() => {
    if (!summaryMode) {
      setLoadedFiles(null)
      setFilesLoading(false)
      setFilesError('')
      return
    }
    void dataRevision
    void filesReloadTick
    const controller = new AbortController()
    setFilesLoading(true)
    setFilesError('')
    void fetchAllPaginatedFiles(
      `/api/collections/${encodeURIComponent(c.id)}/files`,
      new URLSearchParams({ sort: 'created_desc' }),
      10000,
      controller.signal,
    )
      .then((res) => {
        if (controller.signal.aborted) return
        setLoadedFiles(res.items)
        setFilesError('')
        setFilesLoading(false)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setFilesError((err as Error).message || '读取收集完整文件列表失败，请重试')
        setFilesLoading(false)
      })
    return () => controller.abort()
  }, [c.id, summaryMode, dataRevision, filesReloadTick])

  const filesReady = !summaryMode || loadedFiles !== null
  const files = summaryMode ? (loadedFiles ?? []) : propFiles
  const detailRefreshKey = `${dataRevision}:${filesReloadTick}`
  const state = collectionState(c)
  const archived = Boolean(c.archivedAt)
  const pending = c.pendingFiles ?? files.filter((f) => f.status === 'pending').length
  const activeCount = loadedFiles ? loadedFiles.length : (c.activeFiles ?? propFiles.length)
  const material = c.materials?.length
    ? loadedFiles
      ? materialProgress(c, loadedFiles)
      : (c.materialSummary ?? materialProgress(c, files))
    : null
  const percent = material
    ? material.total
      ? Math.round((material.received / material.total) * 100)
      : 0
    : Math.min(100, Math.round((c.received / c.target) * 100))
  const expired = isExpired(c)
  const actions =
    c.status === 'active'
      ? [
          { status: 'paused' as const, label: '暂停收集', icon: CirclePause },
          { status: 'completed' as const, label: '结束收集', icon: Check },
        ]
      : [
          { status: 'active' as const, label: '重新开放', icon: Play },
          ...(c.status === 'paused'
            ? [{ status: 'completed' as const, label: '结束收集', icon: Check }]
            : []),
        ]
  const confirmTitle =
    confirm === 'active'
      ? '重新开放这项收集？'
      : confirm === 'paused'
        ? '暂停这项收集？'
        : '结束这项收集？'
  return (
    <>
      <button type="button" className="text-button collection-back" onClick={onBack}>
        <ArrowLeft size={15} />
        全部收集
      </button>
      <div className="page-title collection-detail-title">
        <div>
          <div className="collection-detail-kicker">
            <CollectionIcon category={c.category} />
            {archived && (
              <span className="status neutral">
                <i />
                已归档
              </span>
            )}
            <span className={`status ${state}`}>
              <i />
              {collectionStateNames[state]}
            </span>
          </div>
          <h1>{c.title}</h1>
          <p>{c.description}</p>
        </div>
        {canEdit && (
          <div className="button-row">
            {isAdmin && !archived && (
              <button
                type="button"
                className="button"
                disabled={!filesReady}
                onClick={() => setOfflineTarget({ owner: '', identity: '' })}
              >
                <Upload size={15} />
                线下补录
              </button>
            )}
            {onAI && (
              <button
                type="button"
                className="button"
                disabled={!filesReady}
                onClick={() => onAI(files)}
              >
                检查这项收集
              </button>
            )}
            <button type="button" className="button" onClick={onClone}>
              <CopyPlus size={15} />
              复制任务
            </button>
            <button type="button" className="button" onClick={onArchive}>
              {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              {archived ? '取消归档' : '归档'}
            </button>
            <button type="button" className="button" onClick={onEdit}>
              <Pencil size={15} />
              编辑规则
            </button>
            {!archived && (
              <button type="button" className="button primary" onClick={onShare}>
                <Link size={15} />
                分享收集
              </button>
            )}
          </div>
        )}
      </div>
      {archived && (
        <div className="action-notice" role="status">
          <span>
            此任务已归档，公开链接已暂停接收新提交。已收文件与核对台账完整保留，随时可取消归档或一键复制为新任务。
          </span>
          {canEdit && (
            <button type="button" className="text-button" onClick={onArchive}>
              取消归档
            </button>
          )}
        </div>
      )}
      {c.draftOrigin && (
        <details className="form-note">
          <summary>
            材料草稿经发起人确认创建
            {c.draftOrigin.testMode ? '（内部注入验收，非真实模型效果）' : ''}
          </summary>
          {c.draftOrigin.resolutions
            .filter((a) => !a.skipped)
            .map((r) => (
              <p key={`${r.question}-${r.materialId || ''}-${r.answer || ''}`}>
                {r.question}：{r.answer}
              </p>
            ))}
        </details>
      )}
      <section className="collection-brief" aria-label="收集进度与规则">
        <div className="collection-progress-summary">
          <p>
            {material ? '必需项收齐' : '累计接收进度'}
            <span>{percent}%</span>
          </p>
          <strong>
            {material ? material.received : c.received}
            <small> / {material ? `${material.total} 人` : `${c.target} 份`}</small>
          </strong>
          <div className="progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <small>
            {material ? `核对通过 ${material.reviewed} 人` : '累计含替换前文件；有效文件见下方'}
          </small>
        </div>
        <dl>
          <div>
            <dt>截止时间</dt>
            <dd>
              {c.deadline}
              <small>当天 23:59 · UTC+8</small>
            </dd>
          </div>
          <div>
            <dt>提交规则</dt>
            <dd>
              单文件 ≤ {effectiveFileLimit(c)} MB
              <small>每次最多 {c.maxFilesPerSubmission} 个文件</small>
            </dd>
          </div>
          <div>
            <dt>允许格式</dt>
            <dd className="collection-formats">
              {c.formats}
              {(c.hasAccessCode || c.restrictToExpectedSubmitters) && (
                <small>
                  {[
                    c.hasAccessCode ? '已启用提取码' : '',
                    c.restrictToExpectedSubmitters ? '仅允许名单内提交' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
            </dd>
          </div>
        </dl>
      </section>
      <div className="collection-lifecycle">
        <p>
          {archived
            ? '收集已归档，当前不接收公开提交。'
            : state === 'active'
              ? '收集链接已开放，可以接收文件。'
              : state === 'expired'
                ? '已超过截止时间。延长截止日期后即可继续收集。'
                : state === 'paused'
                  ? '收集已暂停，提交页暂不接收文件。'
                  : '收集已结束，已收到的文件仍可整理。'}
        </p>
        {canEdit && !archived && (
          <div className="button-row">
            {actions.map((a) => (
              <button
                type="button"
                key={a.status}
                className="text-button"
                disabled={a.status === 'active' && expired}
                onClick={() => setConfirm(a.status)}
              >
                <a.icon size={14} />
                {a.label}
              </button>
            ))}
          </div>
        )}
        {!archived && expired && c.status !== 'active' && <small>延长截止日期后可重新开放</small>}
      </div>
      <div className="collection-workflow-bar">
        <div className="tabs">
          {!!c.materials?.length && (
            <button
              type="button"
              className={tab === 'materials' ? 'active' : ''}
              onClick={() => {
                setTab('materials')
                setSelected(null)
              }}
            >
              材料收齐与核对
            </button>
          )}
          <button
            type="button"
            className={tab === 'files' ? 'active' : ''}
            onClick={() => {
              setTab('files')
              setSelected(null)
            }}
          >
            收到的文件（{activeCount}）
          </button>
          <button
            type="button"
            className={tab === 'people' ? 'active' : ''}
            onClick={() => setTab('people')}
          >
            {c.materials?.length ? '提交记录' : '提交人 / 未交名单'}
          </button>
        </div>
        {canEdit && (
          <button type="button" className="text-button" onClick={() => setSaveTemplate(true)}>
            保存为模板
          </button>
        )}
      </div>
      {tab === 'materials' &&
        (c.materials?.length ? (
          !filesReady ? (
            filesError ? (
              <div className="error-banner" role="alert">
                <span>读取材料列表失败：{filesError}</span>
                <button
                  type="button"
                  className="button"
                  disabled={filesLoading}
                  onClick={() => setFilesReloadTick((n) => n + 1)}
                >
                  重新加载
                </button>
              </div>
            ) : (
              <p className="material-sync" role="status">
                正在读取本收集完整文件与材料记录…
              </p>
            )
          ) : (
            <MaterialWorkbench
              collection={c}
              files={files}
              refreshKey={detailRefreshKey}
              onEditRules={onEdit}
              onShare={onShare}
              onDetail={onDetail}
              onAction={onMaterialAction}
              onOfflineUpload={
                isAdmin && !archived ? (person) => setOfflineTarget(person) : undefined
              }
              onRefresh={async () => {
                await onRefresh()
                setFilesReloadTick((n) => n + 1)
              }}
            />
          )
        ) : (
          <p className="form-note">材料清单已移除，请切换到收到的文件查看。</p>
        ))}
      {tab === 'people' &&
        (!filesReady ? (
          filesError ? (
            <div className="error-banner" role="alert">
              <span>读取提交人台账失败：{filesError}</span>
              <button
                type="button"
                className="button"
                disabled={filesLoading}
                onClick={() => setFilesReloadTick((n) => n + 1)}
              >
                重新加载
              </button>
            </div>
          ) : (
            <p className="material-sync" role="status">
              正在读取本收集完整提交记录…
            </p>
          )
        ) : (
          <ParticipantLedger
            collection={c}
            files={files}
            onSelect={(ids, label) => setSelected(ids ? { ids, label: label || '' } : null)}
            onOfflineUpload={
              isAdmin && !archived ? (person) => setOfflineTarget(person) : undefined
            }
          />
        ))}
      {(tab === 'files' || selected) && (
        <>
          <div className="section-heading">
            <h2>{selected ? `${selected.label}的文件` : '收到的文件'}</h2>
            <span className="muted">
              {selected ? `${selected.ids.length} 份` : `${pending} 份待整理`}
            </span>
          </div>
          <FileTable
            key={`${c.id}-${selected?.label || 'all'}`}
            files={selected ? files.filter((f) => selected.ids.includes(f.id)) : files}
            collections={[c]}
            collectionId={selected ? '' : c.id}
            serverPagination={!selected}
            refreshKey={detailRefreshKey}
            onRename={onRename}
            onReview={onReview}
            onDetail={onDetail}
            onTrash={onTrash}
            onAI={onAI}
          />
        </>
      )}
      {saveTemplate && (
        <SaveTemplate collectionId={c.id} title={c.title} onClose={() => setSaveTemplate(false)} />
      )}
      {offlineTarget && isAdmin && !archived && (
        <OfflineUploadModal
          collection={c}
          existingFiles={files}
          initialOwner={offlineTarget.owner}
          initialIdentity={offlineTarget.identity}
          onClose={() => setOfflineTarget(null)}
          onUploaded={(result) => {
            setOfflineTarget(null)
            onOfflineUploaded(result)
            setFilesReloadTick((n) => n + 1)
          }}
        />
      )}
      <div className="collection-detail-note">
        文件由工作台授权成员查看和下载。云端同步后仍保留本机副本，任务总容量包含回收站文件。
      </div>
      {confirm && (
        <Modal title={confirmTitle} subtitle={c.title} onClose={() => setConfirm(null)}>
          <p className="body-copy">
            {confirm === 'active'
              ? '原收集链接将再次接受提交，现有文件记录会保留。'
              : confirm === 'paused'
                ? '暂停后，原收集链接暂不接受提交。你可以随时重新开放，已收到的记录会保留。'
                : '结束后，原收集链接将停止接收提交。已收到的记录会保留，你也可以在截止日期内重新开放。'}
          </p>
          <footer className="modal-footer">
            <button type="button" className="button" onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                onStatus(confirm)
                setConfirm(null)
              }}
            >
              {confirm === 'active' ? '重新开放' : confirm === 'paused' ? '暂停收集' : '结束收集'}
            </button>
          </footer>
        </Modal>
      )}
    </>
  )
}
