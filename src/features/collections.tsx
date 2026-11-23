import { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CalendarDays,
  CopyPlus,
  Link,
  Plus,
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderCog,
  LockKeyhole,
  MessageSquareText,
} from 'lucide-react'
import { CollectionIcon, Empty, Modal } from '../components/ui'
import { TemplateManagerModal } from './collection-templates'
import type { Collection, CollectedFile } from '../types'
import { materialProgress } from '../lib/materials'
import { collectionState, collectionStateNames, isExpired, nextWeek } from '../lib/collections'
import { qrSvgDataUrl, renderShareCardSvg } from '../lib/qrcode'
import { buildShareAnnouncement } from '../lib/reminder'
import { shareAddress } from '../lib/share-address'
import { downloadText } from '../lib/workspace'
import { useAccount } from './auth'

export function CollectionCard({
  collection: c,
  files,
  onOpen,
  onShare,
  onClone,
  onArchive,
}: {
  collection: Collection
  files: CollectedFile[]
  onOpen: (id: string) => void
  onShare: (c: Collection) => void
  onClone?: (c: Collection) => void
  onArchive?: (c: Collection) => void
}) {
  const { canEdit } = useAccount()
  const material = c.materialSummary ?? (c.materials?.length ? materialProgress(c, files) : null)
  const percent = material
    ? material.total
      ? Math.round((material.received / material.total) * 100)
      : 0
    : Math.min(100, Math.round((c.received / c.target) * 100))
  const state = collectionState(c)
  const archived = Boolean(c.archivedAt)
  return (
    <article className={`collection-card ${c.category} ${archived ? 'archived' : ''}`}>
      <div className="card-top">
        <CollectionIcon category={c.category} />
        <div className="card-status-group">
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
      </div>
      <button type="button" className="card-title" onClick={() => onOpen(c.id)}>
        {c.title}
        <ArrowUpRight size={16} />
      </button>
      <p className="card-description">{c.description}</p>
      <div className="card-progress-label">
        <span>
          {material ? (
            <>
              必需项收齐 <b>{material.received}</b> / {material.total} 人 · 核对通过{' '}
              {material.reviewed} 人
            </>
          ) : (
            <>
              <b>{c.received}</b>
              <span className="muted"> / {c.target} 份</span>
            </>
          )}
        </span>
        <span>{percent}%</span>
      </div>
      <div className="progress">
        <span style={{ width: `${percent}%` }} />
      </div>
      <footer>
        <span>
          <CalendarDays size={13} />
          {c.deadline.slice(5).replace('-', '月')}日截止
        </span>
        {canEdit && (
          <div className="card-footer-actions">
            {onClone && (
              <button
                type="button"
                className="icon-button card-quick-action"
                onClick={() => onClone(c)}
                title="复制为新任务"
                aria-label={`复制${c.title}`}
              >
                <CopyPlus size={14} />
              </button>
            )}
            {onArchive && (
              <button
                type="button"
                className="icon-button card-quick-action"
                onClick={() => onArchive(c)}
                title={archived ? '取消归档' : '归档任务'}
                aria-label={`${archived ? '取消归档' : '归档'}${c.title}`}
              >
                {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              </button>
            )}
            {!archived && (
              <button
                type="button"
                className="share-button"
                onClick={() => onShare(c)}
                aria-label={`分享${c.title}`}
              >
                <Link size={14} />
                <span>分享收集</span>
              </button>
            )}
          </div>
        )}
      </footer>
    </article>
  )
}

export function Collections({
  collections,
  files,
  onOpen,
  onShare,
  onCreate,
  onClone,
  onArchive,
}: {
  collections: Collection[]
  files: CollectedFile[]
  onOpen: (id: string) => void
  onShare: (c: Collection) => void
  onCreate: () => void
  onClone?: (c: Collection) => void
  onArchive?: (c: Collection) => void
}) {
  const { canEdit } = useAccount()
  const [archiveScope, setArchiveScope] = useState<'active' | 'archived' | 'all'>('active')
  const [tab, setTab] = useState('all')
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const scoped = collections.filter((c) =>
    archiveScope === 'all'
      ? true
      : archiveScope === 'archived'
        ? Boolean(c.archivedAt)
        : !c.archivedAt,
  )
  const list =
    archiveScope === 'archived'
      ? scoped
      : scoped.filter((c) => tab === 'all' || collectionState(c) === tab)
  const activeCount = collections.filter((c) => !c.archivedAt).length
  const archivedCount = collections.filter((c) => Boolean(c.archivedAt)).length
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">COLLECTIONS</p>
          <h1>让收集，有条不紊。</h1>
          <p>一个链接收齐文件，进展尽在掌握。</p>
        </div>
        <div className="button-row">
          <button type="button" className="button" onClick={() => setTemplatesOpen(true)}>
            <FolderCog size={16} />
            模板管理
          </button>
          {canEdit && (
            <button type="button" className="button primary" onClick={onCreate}>
              <Plus size={17} />
              新建收集
            </button>
          )}
        </div>
      </div>
      <div className="collection-scope-bar">
        <div className="tabs archive-scope-tabs" role="tablist" aria-label="归档状态筛选">
          {(
            [
              ['active', '进行中', activeCount],
              ['archived', '已归档', archivedCount],
              ['all', '全部', collections.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              type="button"
              role="tab"
              aria-selected={archiveScope === value}
              className={archiveScope === value ? 'active' : ''}
              key={value}
              onClick={() => {
                setArchiveScope(value)
                setTab('all')
              }}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        {archiveScope !== 'archived' && (
          <div className="tabs collection-tabs">
            {[
              ['all', '全部状态'],
              ['active', '收集中'],
              ['completed', '已完成'],
              ['paused', '已暂停'],
              ['expired', '已截止'],
            ].map(([value, label]) => (
              <button
                type="button"
                className={tab === value ? 'active' : ''}
                key={value}
                onClick={() => setTab(value)}
              >
                {label}
                <span>
                  {scoped.filter((c) => value === 'all' || collectionState(c) === value).length}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {list.length ? (
        <div className="collection-grid all-collections">
          {list.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              files={files}
              onOpen={onOpen}
              onShare={onShare}
              onClone={onClone}
              onArchive={onArchive}
            />
          ))}
          {canEdit && archiveScope !== 'archived' && (
            <button type="button" className="create-card" onClick={onCreate}>
              <span>
                <Plus size={24} />
              </span>
              <b>发起下一项收集</b>
              <p>让文件自己找到归处</p>
            </button>
          )}
        </div>
      ) : (
        <Empty
          title={archiveScope === 'archived' ? '暂无已归档收集' : '暂无这类收集'}
          text={
            archiveScope === 'archived'
              ? '历史任务归档后会收纳在这里，随时可以取消归档或一键复制复用。'
              : '新建一项收集，或切换其他状态查看。'
          }
        />
      )}
      {templatesOpen && <TemplateManagerModal onClose={() => setTemplatesOpen(false)} />}
    </>
  )
}

export function CloneCollectionModal({
  collection: c,
  busy,
  serverError,
  onClose,
  onConfirm,
}: {
  collection: Collection
  busy: boolean
  serverError?: string
  onClose: () => void
  onConfirm: (payload: {
    title: string
    deadline: string
    includeExpectedSubmitters: boolean
    accessCode?: string
  }) => void
}) {
  const [title, setTitle] = useState(`${c.title}（副本）`.slice(0, 50))
  const [deadline, setDeadline] = useState(isExpired(c) ? nextWeek() : c.deadline)
  const [includeRoster, setIncludeRoster] = useState(Boolean(c.expectedSubmitters?.length))
  const [accessCode, setAccessCode] = useState('')
  const [error, setError] = useState('')

  return (
    <Modal
      title="一键复制为新任务"
      subtitle={`来源：${c.title}`}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!title.trim()) {
            setError('请填写新任务名称。')
            return
          }
          const code = accessCode.trim()
          if (code && (code.length < 4 || code.length > 8 || /\s/.test(code))) {
            setError('访问提取码需为 4–8 位非空白字符。')
            return
          }
          setError('')
          onConfirm({
            title: title.trim(),
            deadline,
            includeExpectedSubmitters: includeRoster,
            ...(code ? { accessCode: code } : {}),
          })
        }}
      >
        <fieldset disabled={busy}>
          <div className="form-note">
            将完整复制格式限制、自定义字段、自动命名规则与材料清单，并生成全新的收集链接（已收文件和旧提交记录不会复制到新任务）。
          </div>
          <label className="field">
            新任务名称
            <input
              required
              maxLength={50}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            新截止日期
            <input
              type="date"
              required
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </label>
          {!!c.expectedSubmitters?.length && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={includeRoster}
                onChange={(e) => setIncludeRoster(e.target.checked)}
              />
              同时复制应交名单（{c.expectedSubmitters.length} 人）
              {c.restrictToExpectedSubmitters ? '及名单准入限制' : ''}
            </label>
          )}
          <label className="field">
            新任务访问提取码（选填，原提取码不会自动继承）
            <input
              maxLength={8}
              value={accessCode}
              placeholder="留空表示不设提取码，或输入 4–8 位字符"
              onChange={(e) => setAccessCode(e.target.value)}
            />
          </label>
          {(error || serverError) && (
            <p className="error-text" role="alert">
              {error || serverError}
            </p>
          )}
          <footer className="modal-footer">
            <button type="button" className="button" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              <CopyPlus size={15} />
              {busy ? '复制中…' : '确认复制'}
            </button>
          </footer>
        </fieldset>
      </form>
    </Modal>
  )
}

export function ArchiveCollectionModal({
  collection: c,
  busy,
  serverError,
  onClose,
  onConfirm,
}: {
  collection: Collection
  busy: boolean
  serverError?: string
  onClose: () => void
  onConfirm: (archived: boolean) => void
}) {
  const archived = Boolean(c.archivedAt)
  return (
    <Modal
      title={archived ? '取消归档这项收集？' : '归档这项收集？'}
      subtitle={c.title}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <p className="body-copy">
        {archived
          ? '取消归档后，任务会重新出现在「进行中」列表中。若需要继续接收提交，可在详情页手动重新开放。'
          : '归档后，任务将收纳至「已归档」分类并停止接收新提交，所有已收文件与台账记录均完整保留，随时可取消归档。'}
      </p>
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
          disabled={busy}
          onClick={() => onConfirm(!archived)}
        >
          {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          {busy ? '处理中…' : archived ? '确认取消归档' : '确认归档'}
        </button>
      </footer>
    </Modal>
  )
}

export { CollectionForm } from './collection-form'

function readCachedPasscode(collectionId: string): string {
  try {
    return sessionStorage.getItem(`jiyu:passcode:${collectionId}`) || ''
  } catch {
    return ''
  }
}

export function ShareCollection({
  collection,
  onClose,
  onRotate,
  busy,
  serverError,
}: {
  collection: Collection
  onClose: () => void
  onRotate: () => void
  busy: boolean
  serverError?: string
}) {
  const [copied, setCopied] = useState<'' | 'url' | 'notice'>('')
  const [copyError, setCopyError] = useState('')
  const [passcode, setPasscode] = useState(() => readCachedPasscode(collection.id))
  const [downloadingCard, setDownloadingCard] = useState(false)
  const url = `${location.origin}/#/submit/${collection.uploadToken}`
  const address = shareAddress(location.origin)
  const [rotate, setRotate] = useState(false)
  const qrState = useMemo<{ dataUrl: string; error: string }>(() => {
    try {
      return {
        dataUrl: qrSvgDataUrl(url, { size: 200, margin: 4, title: `${collection.title} 二维码` }),
        error: '',
      }
    } catch (err) {
      return {
        dataUrl: '',
        error:
          (err as Error).message || '当前链接过长，超出二维码容量上限，请直接复制下方链接分享。',
      }
    }
  }, [url, collection.title])
  const announcement = useMemo(
    () => buildShareAnnouncement({ collection, url, passcode }),
    [collection, url, passcode],
  )

  async function copy(kind: 'url' | 'notice', value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      setCopyError('')
    } catch {
      setCopied('')
      setCopyError('无法自动复制，请手动选中文本复制。')
    }
  }

  async function downloadShareCard() {
    if (!qrState.dataUrl) {
      setCopyError(qrState.error || '当前链接暂无法生成分享二维码卡片，请直接复制链接或群通知。')
      return
    }
    setDownloadingCard(true)
    setCopyError('')
    const safeTitle = collection.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 40) || '收集'
    let svg: string
    try {
      svg = renderShareCardSvg({
        title: collection.title,
        description: collection.description,
        url,
        deadline: collection.deadline,
        formats: collection.formats,
        passcode: passcode.trim() || undefined,
        hasAccessCode: collection.hasAccessCode,
        materials: collection.materials?.map((m) => `${m.name}${m.required ? '' : '（选填）'}`),
      })
    } catch (err) {
      setCopyError((err as Error).message || '链接过长，暂无法生成分享卡片，请复制链接或群通知。')
      setDownloadingCard(false)
      return
    }
    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('svg-load-failed'))
        img.src = svgDataUrl
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || 960
      canvas.height = img.naturalHeight || 1184
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas-unavailable')
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('png-export-failed')
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = `集屿分享-${safeTitle}.png`
      link.click()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1500)
    } catch {
      downloadText(`集屿分享-${safeTitle}.svg`, svg, 'image/svg+xml;charset=utf-8')
    } finally {
      setDownloadingCard(false)
    }
  }

  return (
    <Modal title="好文件，一个链接就能收齐" subtitle={collection.title} onClose={onClose} wide>
      <div className="share-qr-panel">
        <div className="share-qr-box">
          {qrState.dataUrl ? (
            <>
              <img
                src={qrState.dataUrl}
                alt={`${collection.title} 收集链接二维码`}
                width={176}
                height={176}
              />
              <small>纯本地生成 SVG 二维码 · 扫码免登录提交</small>
            </>
          ) : (
            <div className="share-qr-fallback" role="status">
              <strong>暂无法生成二维码</strong>
              <small>{qrState.error}</small>
            </div>
          )}
        </div>
        <div className="share-qr-side">
          <div className="share-badges">
            <CollectionIcon category={collection.category} />
            <div>
              <strong>{collection.title}</strong>
              <small>截止 {collection.deadline} 23:59（UTC+8）</small>
            </div>
          </div>
          {collection.hasAccessCode && (
            <p className="share-lock-pill">
              <LockKeyhole size={14} />
              已开启提取码保护
            </p>
          )}
          <div className="share-quick-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => void copy('notice', announcement)}
            >
              {copied === 'notice' ? <Check size={15} /> : <MessageSquareText size={15} />}
              {copied === 'notice' ? '已复制群通知' : '一键复制群通知'}
            </button>
            <button
              type="button"
              className="button"
              disabled={downloadingCard || !qrState.dataUrl}
              onClick={() => void downloadShareCard()}
            >
              <Download size={15} />
              {downloadingCard ? '生成中…' : '下载分享图'}
            </button>
          </div>
        </div>
      </div>

      {collection.hasAccessCode && (
        <label className="field">
          附带提取码到分享图与群通知（选填，仅在本地拼接）
          <input
            value={passcode}
            maxLength={8}
            placeholder="填写 4–8 位提取码后，一键复制群通知与分享图将自动包含提取码"
            onChange={(e) => {
              setPasscode(e.target.value)
              setCopied('')
            }}
          />
        </label>
      )}

      <label className="field">
        收集链接
        <div className="copy-field">
          <input value={url} readOnly aria-label="收集链接" />
          <button
            type="button"
            className="icon-button"
            aria-label="复制链接"
            onClick={() => void copy('url', url)}
          >
            {copied === 'url' ? <Check size={18} /> : <Copy size={18} />}
          </button>
        </div>
      </label>

      <details className="share-notice-preview">
        <summary>预览结构化群通知文本</summary>
        <pre>{announcement}</pre>
      </details>

      <div
        className={`share-address-note ${address.kind === 'external' ? '' : 'attention'}`}
        role="note"
      >
        <strong>{address.label}</strong>
        <p>{address.detail}</p>
        {address.kind !== 'external' && (
          <a
            className="text-button"
            href="https://github.com/1Beyond1/jiyu/blob/main/docs/DEPLOYMENT.md"
            target="_blank"
            rel="noreferrer"
          >
            查看部署与访问配置
            <ExternalLink size={14} />
          </a>
        )}
      </div>
      {copied === 'url' && (
        <p className="success-text" role="status">
          {address.kind === 'local'
            ? '已复制本机预览链接；请勿发给其他人用于提交。'
            : '链接已复制，请先确认参与者可以访问。'}
        </p>
      )}
      {copied === 'notice' && (
        <p className="success-text" role="status">
          结构化群通知已复制，可直接粘贴到微信 / QQ / 飞书 / 钉钉群公告。
        </p>
      )}
      {copyError && (
        <p className="error-text" role="alert">
          {copyError}
        </p>
      )}
      {serverError && (
        <p className="error-text" role="alert">
          {serverError}
        </p>
      )}
      <div className="form-note">
        链接不提供他人文件列表或下载权限。提交者须凭本人私密回执查询或替换本批文件。暂停或结束收集可立即停止接收。
      </div>
      {rotate ? (
        <div className="rotate-confirm">
          <p>重新生成后，之前分享的链接和二维码会立即失效。</p>
          <button type="button" className="button" disabled={busy} onClick={() => setRotate(false)}>
            取消
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              onRotate()
              setRotate(false)
              setCopied('')
            }}
          >
            确认更换链接
          </button>
        </div>
      ) : (
        <button type="button" className="text-button" onClick={() => setRotate(true)}>
          更换收集链接
        </button>
      )}
      <footer className="modal-footer">
        <button type="button" className="button" onClick={onClose}>
          完成
        </button>
        <a href={url} target="_blank" rel="noreferrer" className="button primary">
          预览提交页
          <ExternalLink size={15} />
        </a>
      </footer>
    </Modal>
  )
}
