import { useMemo, useState } from 'react'
import {
  ArrowUpRight,
  CalendarDays,
  Link,
  Plus,
  Check,
  Copy,
  Download,
  ExternalLink,
  LockKeyhole,
  MessageSquareText,
} from 'lucide-react'
import { CollectionIcon, Empty, Modal } from '../components/ui'
import type { Collection, CollectedFile } from '../types'
import { materialProgress } from '../lib/materials'
import { collectionState, collectionStateNames } from '../lib/collections'
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
}: {
  collection: Collection
  files: CollectedFile[]
  onOpen: (id: string) => void
  onShare: (c: Collection) => void
}) {
  const { canEdit } = useAccount()
  const material = c.materials?.length ? materialProgress(c, files) : null
  const percent = material
    ? material.total
      ? Math.round((material.received / material.total) * 100)
      : 0
    : Math.min(100, Math.round((c.received / c.target) * 100))
  const state = collectionState(c)
  return (
    <article className={`collection-card ${c.category}`}>
      <div className="card-top">
        <CollectionIcon category={c.category} />
        <span className={`status ${state}`}>
          <i />
          {collectionStateNames[state]}
        </span>
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
}: {
  collections: Collection[]
  files: CollectedFile[]
  onOpen: (id: string) => void
  onShare: (c: Collection) => void
  onCreate: () => void
}) {
  const { canEdit } = useAccount()
  const [tab, setTab] = useState('all')
  const list = collections.filter((c) => tab === 'all' || collectionState(c) === tab)
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">COLLECTIONS</p>
          <h1>让收集，有条不紊。</h1>
          <p>一个链接收齐文件，进展尽在掌握。</p>
        </div>
        {canEdit && (
          <button type="button" className="button primary" onClick={onCreate}>
            <Plus size={17} />
            新建收集
          </button>
        )}
      </div>
      <div className="tabs collection-tabs">
        {[
          ['all', '全部收集'],
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
              {collections.filter((c) => value === 'all' || collectionState(c) === value).length}
            </span>
          </button>
        ))}
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
            />
          ))}
          {canEdit && (
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
        <Empty title="暂无这类收集" text="新建一项收集，或切换其他状态查看。" />
      )}
    </>
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
  const qrDataUrl = useMemo(
    () => qrSvgDataUrl(url, { size: 200, margin: 3, title: `${collection.title} 二维码` }),
    [url, collection.title],
  )
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
    setDownloadingCard(true)
    setCopyError('')
    const safeTitle = collection.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 40) || '收集'
    const svg = renderShareCardSvg({
      title: collection.title,
      description: collection.description,
      url,
      deadline: collection.deadline,
      formats: collection.formats,
      passcode: passcode.trim() || undefined,
      hasAccessCode: collection.hasAccessCode,
      materials: collection.materials?.map((m) => `${m.name}${m.required ? '' : '（选填）'}`),
    })
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
          <img
            src={qrDataUrl}
            alt={`${collection.title} 收集链接二维码`}
            width={176}
            height={176}
          />
          <small>纯本地生成 SVG 二维码 · 扫码免登录提交</small>
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
              disabled={downloadingCard}
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
