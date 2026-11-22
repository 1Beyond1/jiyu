import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Ellipsis,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { Empty, FileIcon, Modal } from '../components/ui'
import type { CollectedFile, Collection, FileSortOption, PaginatedFiles } from '../types'
import { storageNames } from '../types'
import { csvCell, downloadText, formatDate, formatSize } from '../lib/workspace'
import { fileExtension } from '../lib/collections'
import { ArchiveModal } from './archive'
import { useAccount } from './auth'
import { FilePreview } from './content'
import { api, EtagCache, fetchAllPaginatedFiles } from '../lib/api'

const SORT_OPTIONS: { value: FileSortOption; label: string }[] = [
  { value: 'created_desc', label: '最新提交优先' },
  { value: 'created_asc', label: '最早提交优先' },
  { value: 'name_asc', label: '文件名 A → Z' },
  { value: 'name_desc', label: '文件名 Z → A' },
  { value: 'size_desc', label: '文件由大到小' },
  { value: 'size_asc', label: '文件由小到大' },
]

function compareFiles(a: CollectedFile, b: CollectedFile, sort: FileSortOption): number {
  switch (sort) {
    case 'created_asc':
      return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
    case 'name_asc':
      return a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id)
    case 'name_desc':
      return b.name.localeCompare(a.name, 'zh-CN') || b.id.localeCompare(a.id)
    case 'size_asc':
      return a.size - b.size || a.id.localeCompare(b.id)
    case 'size_desc':
      return b.size - a.size || b.id.localeCompare(a.id)
    default:
      return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)
  }
}

interface FileTableProps {
  files: CollectedFile[]
  collections: Collection[]
  compact?: boolean
  serverPagination?: boolean
  search?: string
  collectionId?: string
  onRename: (files: CollectedFile[]) => void
  onReview: (ids: string[]) => void
  onDetail: (file: CollectedFile) => void
  onTrash?: (ids: string[]) => void
  onAI?: (files: CollectedFile[]) => void
}

export function FileTable({
  files,
  collections,
  compact = false,
  serverPagination = false,
  search = '',
  collectionId = '',
  onRename,
  onReview,
  onDetail,
  onTrash,
  onAI,
}: FileTableProps) {
  const { canEdit } = useAccount()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<string[]>([])
  const [sort, setSort] = useState<FileSortOption>('created_desc')
  const [pageSize, setPageSize] = useState(50)
  const [pageData, setPageData] = useState<PaginatedFiles | null>(null)
  const [pageLoading, setPageLoading] = useState(false)
  const [pageError, setPageError] = useState('')
  const [retryTick, setRetryTick] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [actionError, setActionError] = useState('')
  const pageCache = useRef(new EtagCache<PaginatedFiles>(40))
  const [archiveFiles, setArchiveFiles] = useState<CollectedFile[] | null>(null)
  const [matches, setMatches] = useState<{ id: string; excerpt: string }[]>([]),
    [searchError, setSearchError] = useState(''),
    [searching, setSearching] = useState(false)
  const term = (search || query).trim()
  const useServerPaging = !compact && serverPagination
  const queryKey = `${term}\0${filter}\0${sort}\0${collectionId}\0${pageSize}`
  const [pageState, setPageState] = useState<{ key: string; page: number }>({
    key: queryKey,
    page: 1,
  })
  const page = pageState.key === queryKey ? pageState.page : 1
  const setPage = (next: number | ((current: number) => number)) => {
    setPageState((prev) => {
      const base = prev.key === queryKey ? prev.page : 1
      const resolved = typeof next === 'function' ? next(base) : next
      return { key: queryKey, page: resolved }
    })
  }

  const serverBasePath = collectionId
    ? `/api/collections/${encodeURIComponent(collectionId)}/files`
    : '/api/files'

  function buildServerFilterParams() {
    const params = new URLSearchParams({ sort })
    if (filter === 'pending') params.set('status', 'pending')
    else if (filter === 'ready') params.set('status', 'ready')
    else if (filter === 'image') params.set('kind', 'image')
    if (term) params.set('q', term)
    return params
  }

  useEffect(() => {
    if (!useServerPaging) {
      setPageData(null)
      setPageError('')
      return
    }
    const workspaceTick = files
    void workspaceTick
    void retryTick
    const controller = new AbortController()
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sort,
    })
    if (filter === 'pending') params.set('status', 'pending')
    else if (filter === 'ready') params.set('status', 'ready')
    else if (filter === 'image') params.set('kind', 'image')
    if (term) params.set('q', term)
    const endpoint = `${serverBasePath}?${params}`
    setPageLoading(true)
    setPageError('')
    const timer = setTimeout(
      () => {
        void pageCache.current
          .fetch(endpoint, controller.signal)
          .then((res) => {
            if (controller.signal.aborted) return
            setPageData(res.data)
            setPageError('')
            const maxPage = Math.max(1, Math.ceil(res.data.total / res.data.pageSize))
            if (page > maxPage) setPageState({ key: queryKey, page: maxPage })
            setPageLoading(false)
          })
          .catch((err) => {
            if (controller.signal.aborted) return
            setPageData(null)
            setPageError((err as Error).message || '文件列表加载失败，请重试')
            setPageLoading(false)
          })
      },
      term ? 200 : 0,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [
    useServerPaging,
    serverBasePath,
    queryKey,
    filter,
    term,
    sort,
    page,
    pageSize,
    files,
    retryTick,
  ])

  useEffect(() => {
    setMatches([])
    setSearchError('')
    // 后端分页模式已由 /api/files?q=... 在服务端合并 FTS5 正文检索，避免重复请求 /api/content/search
    if (compact || useServerPaging || term.length < 2) {
      setSearching(false)
      return
    }
    const controller = new AbortController()
    setSearching(true)
    const timer = setTimeout(() => {
      void api<{ matches: { id: string; excerpt: string }[] }>(
        `/api/content/search?q=${encodeURIComponent(term)}`,
        'GET',
        undefined,
        controller.signal,
      )
        .then((data) => {
          setMatches(data.matches)
          setSearching(false)
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setSearchError((e as Error).message)
            setSearching(false)
          }
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [term, compact, useServerPaging])
  const visible = files
    .filter(
      (f) =>
        (!collectionId || f.collectionId === collectionId) &&
        (`${f.name} ${f.owner} ${(f.tags || []).join(' ')}`
          .toLowerCase()
          .includes(term.toLowerCase()) ||
          matches.some((m) => m.id === f.id)) &&
        (filter === 'all' ||
          (filter === 'pending'
            ? f.status === 'pending'
            : filter === 'ready'
              ? f.status === 'ready'
              : ['jpg', 'jpeg', 'png', 'heic', 'svg', 'webp', 'gif'].includes(
                  fileExtension(f.name),
                ))),
    )
    .sort((a, b) => compareFiles(a, b, sort))
  const totalCount = useServerPaging
    ? pageError
      ? 0
      : pageData
        ? pageData.total
        : visible.length
    : visible.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const list = compact
    ? visible.slice(0, 5)
    : useServerPaging
      ? pageError
        ? []
        : pageData
          ? pageData.items
          : visible.slice((page - 1) * pageSize, page * pageSize)
      : visible
  const chosenMap = new Map<string, CollectedFile>()
  for (const f of files) chosenMap.set(f.id, f)
  for (const f of list) chosenMap.set(f.id, f)
  const chosen = selected.map((id) => chosenMap.get(id)).filter((f): f is CollectedFile => !!f)
  const allChecked = list.length > 0 && list.every((f) => selected.includes(f.id))

  async function resolveFilteredFiles(maxItems: number): Promise<CollectedFile[]> {
    if (!useServerPaging) return visible.slice(0, maxItems)
    if (
      pageData &&
      pageData.page === 1 &&
      pageData.items.length >= pageData.total &&
      pageData.items.length <= maxItems
    ) {
      return pageData.items
    }
    const result = await fetchAllPaginatedFiles(serverBasePath, buildServerFilterParams(), maxItems)
    return result.items
  }

  async function openArchiveForFiltered() {
    if (exporting) return
    setActionError('')
    setExporting(true)
    try {
      const targets = await resolveFilteredFiles(500)
      if (!targets.length) {
        setActionError('当前筛选结果为空，暂无可打包的文件。')
        return
      }
      setArchiveFiles(targets)
    } catch (err) {
      setActionError((err as Error).message || '读取筛选结果失败，请稍后重试')
    } finally {
      setExporting(false)
    }
  }

  async function exportCsv() {
    if (exporting) return
    setActionError('')
    setExporting(true)
    try {
      const targetFiles = chosen.length ? chosen : await resolveFilteredFiles(2000)
      const rows = targetFiles.map((f) =>
        [
          f.name,
          f.owner,
          collections.find((c) => c.id === f.collectionId)?.title || '',
          formatSize(f.size),
          formatDate(f.createdAt),
        ]
          .map(csvCell)
          .join(','),
      )
      downloadText(
        '集屿-文件清单.csv',
        '\uFEFF文件名称,提交人,收集任务,文件大小,提交时间\n' + rows.join('\n'),
        'text/csv;charset=utf-8',
      )
    } catch (err) {
      setActionError((err as Error).message || '导出清单失败，请稍后重试')
    } finally {
      setExporting(false)
    }
  }
  return (
    <div className="file-panel">
      {!compact && term && (
        <p className="search-hint">
          {useServerPaging
            ? pageLoading
              ? '正在搜索名称、提交人、分类标签和已识别正文…'
              : term.length < 2
                ? '输入至少两个字符，同时搜索已识别正文。'
                : `已按名称、提交人、分类标签和已识别正文筛选，共命中 ${totalCount} 个文件。`
            : searching
              ? '正在搜索已识别的正文…'
              : searchError ||
                (term.length < 2
                  ? '输入至少两个字符，同时搜索正文。'
                  : '搜索名称、提交人、分类标签和已识别正文。')}
          {!useServerPaging && !!matches.length && ` 正文命中 ${matches.length} 个文件。`}
        </p>
      )}
      {!compact && (
        <div className="file-toolbar">
          <div className="input-with-icon">
            <Search size={16} />
            <input
              placeholder="搜索文件名、提交人…"
              aria-label="搜索文件"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="toolbar-actions">
            <label className="select-filter">
              <select
                aria-label="筛选文件"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setSelected([])
                }}
              >
                <option value="all">全部文件</option>
                <option value="pending">待整理</option>
                <option value="ready">已整理</option>
                <option value="image">图片文件</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="select-filter">
              <select
                aria-label="排序方式"
                value={sort}
                onChange={(e) => setSort(e.target.value as FileSortOption)}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            {!selected.length && (
              <button
                type="button"
                className="button"
                disabled={
                  exporting || pageLoading || Boolean(pageError) || !totalCount || totalCount > 500
                }
                onClick={() => void openArchiveForFiltered()}
                title="打包当前筛选结果，最多 500 个文件"
              >
                <Download size={15} />
                {exporting ? '准备中…' : '打包筛选结果'}
              </button>
            )}
            <button
              type="button"
              className="button"
              disabled={exporting || (!chosen.length && (Boolean(pageError) || !totalCount))}
              onClick={() => void exportCsv()}
            >
              <Download size={15} />
              导出清单
            </button>
          </div>
        </div>
      )}
      {!compact && pageError && (
        <div className="error-banner" role="alert">
          <span>文件列表加载失败：{pageError}</span>
          <button type="button" className="button" onClick={() => setRetryTick((n) => n + 1)}>
            重新加载
          </button>
        </div>
      )}
      {!compact && actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}
      {!!selected.length && (
        <div className="selection-bar">
          <span>
            已选择 <b>{selected.length}</b> 个文件
          </span>
          <button
            type="button"
            disabled={!chosen.length || chosen.length > 500}
            onClick={() => setArchiveFiles(chosen)}
            title="每次最多 500 个文件"
          >
            <Download size={15} />
            打包下载
          </button>
          {canEdit && (
            <>
              <button type="button" onClick={() => onRename(chosen)}>
                <WandSparkles size={15} />
                批量重命名
              </button>
              {onAI && (
                <button
                  type="button"
                  disabled={chosen.length > 30}
                  title="AI 每次最多处理 30 个文件"
                  onClick={() => onAI(chosen)}
                >
                  <Sparkles size={15} />
                  AI 建议
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onReview(selected)
                  setSelected([])
                }}
              >
                <Check size={15} />
                标记已整理
              </button>
              {onTrash && (
                <button
                  type="button"
                  onClick={() => {
                    onTrash(selected)
                    setSelected([])
                  }}
                >
                  <Trash2 size={15} />
                  移入回收站
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="取消选择"
            onClick={() => setSelected([])}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="check-column">
                <input
                  type="checkbox"
                  aria-label="全选当前文件"
                  checked={allChecked}
                  onChange={() =>
                    setSelected(
                      allChecked ? [] : [...new Set([...selected, ...list.map((f) => f.id)])],
                    )
                  }
                />
              </th>
              <th>
                <button
                  type="button"
                  className={`table-sort ${sort.startsWith('name_') ? 'active' : ''}`}
                  onClick={() => setSort(sort === 'name_asc' ? 'name_desc' : 'name_asc')}
                >
                  文件名称
                  {sort.startsWith('name_') && (
                    <ArrowDown size={12} className={sort === 'name_asc' ? 'rotated' : ''} />
                  )}
                </button>
              </th>
              <th>所属收集</th>
              <th>提交人</th>
              <th>
                <button
                  type="button"
                  className={`table-sort ${sort.startsWith('created_') ? 'active' : ''}`}
                  onClick={() => setSort(sort === 'created_desc' ? 'created_asc' : 'created_desc')}
                >
                  提交时间
                  {sort.startsWith('created_') && (
                    <ArrowDown size={12} className={sort === 'created_asc' ? 'rotated' : ''} />
                  )}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className={`table-sort ${sort.startsWith('size_') ? 'active' : ''}`}
                  onClick={() => setSort(sort === 'size_desc' ? 'size_asc' : 'size_desc')}
                >
                  大小
                  {sort.startsWith('size_') && (
                    <ArrowDown size={12} className={sort === 'size_asc' ? 'rotated' : ''} />
                  )}
                </button>
              </th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.id} className={selected.includes(f.id) ? 'selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.includes(f.id)}
                    aria-label={`选择${f.name}`}
                    onChange={() =>
                      setSelected(
                        selected.includes(f.id)
                          ? selected.filter((id) => id !== f.id)
                          : [...selected, f.id],
                      )
                    }
                  />
                </td>
                <td>
                  <button type="button" className="file-name" onClick={() => onDetail(f)}>
                    <FileIcon name={f.name} />
                    <span>
                      {f.name}
                      {f.status === 'pending' && <i className="pending-dot" title="待整理" />}
                    </span>
                  </button>
                </td>
                <td>
                  <span className="collection-label">
                    {collections.find((c) => c.id === f.collectionId)?.title || '未分类'}
                  </span>
                </td>
                <td>
                  <span className={`avatar tiny color-${f.owner.length % 3}`}>
                    {f.owner.slice(0, 1)}
                  </span>
                  <span className="owner-name">{f.owner}</span>
                </td>
                <td className="cell-muted numeric">{formatDate(f.createdAt)}</td>
                <td className="cell-muted numeric">{formatSize(f.size)}</td>
                <td>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => onDetail(f)}
                    aria-label={`查看${f.name}详情`}
                  >
                    <Ellipsis size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!list.length && !pageError && <Empty />}
      {!compact && (
        <footer className="table-footer">
          <span>
            共 {totalCount} 个文件
            {useServerPaging && totalPages > 1 ? ` · 第 ${page} / ${totalPages} 页` : ''}
            {pageLoading ? ' · 同步中…' : ''}
          </span>
          {useServerPaging ? (
            <div className="table-pagination">
              <label className="page-size-select">
                <span>每页</span>
                <select
                  aria-label="每页显示数量"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                >
                  <option value={20}>20 条</option>
                  <option value={50}>50 条</option>
                  <option value={100}>100 条</option>
                </select>
              </label>
              {totalPages > 1 ? (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft size={14} />
                    上一页
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    下一页
                    <ChevronRight size={14} />
                  </button>
                </>
              ) : (
                <span>
                  所有文件都已显示
                  <Check size={13} />
                </span>
              )}
            </div>
          ) : (
            <span>
              所有文件都已显示
              <Check size={13} />
            </span>
          )}
        </footer>
      )}
      {archiveFiles && (
        <ArchiveModal
          files={archiveFiles}
          collections={collections}
          onClose={() => setArchiveFiles(null)}
        />
      )}
    </div>
  )
}

export function FileDetail({
  file,
  collection,
  onClose,
  onRename,
  onReview,
  onTrash,
}: {
  file: CollectedFile
  collection?: Collection
  onClose: () => void
  onRename: () => void
  onReview: () => void
  onTrash: () => void
}) {
  const { canEdit } = useAccount()
  return (
    <Modal title="文件详情" onClose={onClose}>
      <div className="file-detail-title">
        <FileIcon name={file.name} large />
        <h3>{file.name}</h3>
        <span className={`status ${file.status === 'ready' ? 'active' : 'paused'}`}>
          <i />
          {file.status === 'ready' ? '已整理' : '待整理'}
        </span>
      </div>
      <FilePreview key={file.id} file={file} />
      <dl className="detail-list">
        <div>
          <dt>所属收集</dt>
          <dd>{collection?.title}</dd>
        </div>
        <div>
          <dt>提交人</dt>
          <dd>{file.owner}</dd>
        </div>
        <div>
          <dt>文件大小</dt>
          <dd>{formatSize(file.size)}</dd>
        </div>
        <div>
          <dt>提交时间</dt>
          <dd>{formatDate(file.createdAt)}</dd>
        </div>
        <div>
          <dt>存储位置</dt>
          <dd>{storageNames[file.storage]}</dd>
        </div>
      </dl>
      {file.storage !== 'local' && (
        <p className="form-note">
          本机原件已保存。云端同步：
          {
            {
              queued: '等待同步',
              transferring: '正在传输并校验',
              ready: '云端已保存',
              failed: '同步失败，可在存储空间重试',
            }[file.remoteStatus || 'queued']
          }
          。
        </p>
      )}
      {!!file.originalName && file.originalName !== file.name && (
        <p className="form-note">原文件名：{file.originalName}</p>
      )}
      {!!file.submissionFields && (
        <dl className="detail-list">
          {Object.entries(file.submissionFields).map(([id, value]) => (
            <div key={id}>
              <dt>{file.fieldLabels?.[id] || id}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="checksum">
        <span>SHA-256 内容校验</span>
        <code>{file.sha256}</code>
      </div>
      {!!file.tags?.length && (
        <div className="file-tags">
          {file.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      )}
      <footer className="modal-footer file-detail-actions">
        {canEdit && (
          <>
            <button type="button" className="icon-button" onClick={onTrash} aria-label="移入回收站">
              <Trash2 size={17} />
            </button>
            <button type="button" className="button" onClick={onRename}>
              重命名
              <ArrowUpRight size={15} />
            </button>
            <button type="button" className="button" onClick={onReview}>
              <Check size={15} />
              已整理
            </button>
          </>
        )}
        <a className="button primary" href={`/api/files/${file.id}/download`}>
          <Download size={15} />
          下载
        </a>
      </footer>
    </Modal>
  )
}

export function TrashPage({
  files,
  onRestore,
  onPurge,
  busy = false,
  serverError = '',
}: {
  files: CollectedFile[]
  onRestore: (ids: string[]) => Promise<void> | void
  onPurge?: (ids: string[]) => Promise<boolean>
  busy?: boolean
  serverError?: string
}) {
  const { canEdit, isAdmin } = useAccount()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<FileSortOption>('created_desc')
  const [pageSize, setPageSize] = useState(50)
  const [pageData, setPageData] = useState<PaginatedFiles | null>(null)
  const [loading, setLoading] = useState(false)
  const [pageError, setPageError] = useState('')
  const [retryTick, setRetryTick] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [purgeTargets, setPurgeTargets] = useState<CollectedFile[] | null>(null)
  const [purgeChecked, setPurgeChecked] = useState(false)
  const [purgeText, setPurgeText] = useState('')
  const cacheRef = useRef(new EtagCache<PaginatedFiles>(30))

  const term = query.trim()
  const queryKey = `${term}\0${sort}\0${pageSize}`
  const [pageState, setPageState] = useState<{ key: string; page: number }>({
    key: queryKey,
    page: 1,
  })
  const page = pageState.key === queryKey ? pageState.page : 1
  const setPage = (next: number | ((current: number) => number)) => {
    setPageState((prev) => {
      const base = prev.key === queryKey ? prev.page : 1
      const resolved = typeof next === 'function' ? next(base) : next
      return { key: queryKey, page: resolved }
    })
  }

  useEffect(() => {
    const syncTick = files
    void syncTick
    void retryTick
    const controller = new AbortController()
    const params = new URLSearchParams({
      trashed: 'true',
      page: String(page),
      pageSize: String(pageSize),
      sort,
    })
    if (term) params.set('q', term)
    const endpoint = `/api/files?${params}`
    setLoading(true)
    setPageError('')
    const timer = setTimeout(
      () => {
        void cacheRef.current
          .fetch(endpoint, controller.signal)
          .then((res) => {
            if (controller.signal.aborted) return
            setPageData(res.data)
            setPageError('')
            const maxPage = Math.max(1, Math.ceil(res.data.total / res.data.pageSize))
            if (page > maxPage) setPageState({ key: queryKey, page: maxPage })
            setLoading(false)
          })
          .catch((err) => {
            if (controller.signal.aborted) return
            setPageData(null)
            setPageError((err as Error).message || '回收站列表加载失败，请重试')
            setLoading(false)
          })
      },
      term ? 200 : 0,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [term, sort, page, pageSize, queryKey, files, retryTick])

  const fallbackVisible = files
    .filter((f) => `${f.name} ${f.owner}`.toLowerCase().includes(term.toLowerCase()))
    .sort((a, b) => compareFiles(a, b, sort))
  const items = pageError
    ? []
    : pageData
      ? pageData.items
      : fallbackVisible.slice((page - 1) * pageSize, page * pageSize)
  const totalCount = pageError ? 0 : pageData ? pageData.total : fallbackVisible.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const fileMap = new Map<string, CollectedFile>()
  for (const f of files) fileMap.set(f.id, f)
  for (const f of items) fileMap.set(f.id, f)
  const chosen = selected.map((id) => fileMap.get(id)).filter((f): f is CollectedFile => Boolean(f))
  const allChecked = items.length > 0 && items.every((f) => selected.includes(f.id))

  function openPurge(targets: CollectedFile[]) {
    if (!isAdmin || !targets.length) return
    setPurgeTargets(targets.slice(0, 500))
    setPurgeChecked(false)
    setPurgeText('')
  }

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">A SECOND CHANCE</p>
          <h1>暂时放下，也能找回。</h1>
          <p>移入回收站的文件仍占用存储空间，可随时恢复；管理员可在确认备份后永久清理。</p>
        </div>
        <div className="button-row">
          {!!files.length && (
            <button
              type="button"
              className="button"
              disabled={!canEdit || busy}
              onClick={async () => {
                await onRestore(files.slice(0, 500).map((f) => f.id))
                setSelected([])
              }}
            >
              <RotateCcw size={15} />
              恢复全部（最多 500 个）
            </button>
          )}
          {isAdmin && onPurge && !!files.length && (
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => openPurge(chosen.length ? chosen : items)}
            >
              <Trash2 size={15} />
              {chosen.length
                ? `永久清理所选（${chosen.length}）`
                : `永久清理本页（${items.length}）`}
            </button>
          )}
        </div>
      </div>

      <div className="file-panel">
        <div className="file-toolbar">
          <div className="input-with-icon">
            <Search size={16} />
            <input
              placeholder="搜索回收站文件名、提交人…"
              aria-label="搜索回收站文件"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="toolbar-actions">
            <label className="select-filter">
              <select
                aria-label="回收站排序方式"
                value={sort}
                onChange={(e) => setSort(e.target.value as FileSortOption)}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
        </div>

        {pageError && (
          <div className="error-banner" role="alert">
            <span>回收站加载失败：{pageError}</span>
            <button type="button" className="button" onClick={() => setRetryTick((n) => n + 1)}>
              重新加载
            </button>
          </div>
        )}

        {!!chosen.length && (
          <div className="selection-bar">
            <span>
              已选择 <b>{chosen.length}</b> 个回收站文件
            </span>
            {canEdit && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  await onRestore(chosen.map((f) => f.id))
                  setSelected([])
                }}
              >
                <RotateCcw size={15} />
                恢复所选
              </button>
            )}
            {isAdmin && onPurge && (
              <button
                type="button"
                className="danger-inline"
                disabled={busy}
                onClick={() => openPurge(chosen)}
              >
                <Trash2 size={15} />
                永久清理所选
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="取消选择"
              onClick={() => setSelected([])}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {items.length ? (
          <div className="trash-list">
            <div className="trash-select-all">
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() =>
                    setSelected(
                      allChecked ? [] : [...new Set([...selected, ...items.map((f) => f.id)])],
                    )
                  }
                />
                全选当前页（{items.length} 个）
              </label>
            </div>
            {items.map((f) => (
              <div key={f.id} className={selected.includes(f.id) ? 'selected' : ''}>
                <input
                  type="checkbox"
                  aria-label={`选择回收站文件${f.name}`}
                  checked={selected.includes(f.id)}
                  onChange={() =>
                    setSelected(
                      selected.includes(f.id)
                        ? selected.filter((id) => id !== f.id)
                        : [...selected, f.id],
                    )
                  }
                />
                <FileIcon name={f.name} />
                <div>
                  <strong>{f.name}</strong>
                  <small>
                    {f.owner} · {formatSize(f.size)} · 移入于 {formatDate(f.deletedAt!)}
                  </small>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="button"
                    disabled={!canEdit || busy}
                    onClick={() => void onRestore([f.id])}
                  >
                    <RotateCcw size={14} />
                    恢复
                  </button>
                  {isAdmin && onPurge && (
                    <button
                      type="button"
                      className="button danger"
                      disabled={busy}
                      onClick={() => openPurge([f])}
                    >
                      <Trash2 size={14} />
                      永久清理
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : !pageError ? (
          <Empty
            title={term ? '没有匹配的回收站文件' : '回收站是空的'}
            text={term ? '换个关键词试试。' : '移除的文件会先放在这里，方便找回。'}
          />
        ) : null}

        <footer className="table-footer">
          <span>
            共 {totalCount} 个文件
            {totalPages > 1 ? ` · 第 ${page} / ${totalPages} 页` : ''}
            {loading ? ' · 同步中…' : ''}
          </span>
          <div className="table-pagination">
            <label className="page-size-select">
              <span>每页</span>
              <select
                aria-label="回收站每页显示数量"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
              >
                <option value={20}>20 条</option>
                <option value={50}>50 条</option>
                <option value={100}>100 条</option>
              </select>
            </label>
            {totalPages > 1 && (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={14} />
                  上一页
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  下一页
                  <ChevronRight size={14} />
                </button>
              </>
            )}
          </div>
        </footer>
      </div>

      <div className="form-note">
        {isAdmin
          ? '管理员在线永久清理会立即删除服务器本地正文与全文索引并释放空间，且会自动阻止正在被打包或备份引用的文件。清理前建议先在「设置 → 完整备份」完成快照。'
          : '移入回收站的文件可由编辑者或管理员恢复；永久清理释放空间仅限管理员执行。'}
      </div>

      {purgeTargets && isAdmin && onPurge && (
        <Modal
          title="永久清理回收站文件？"
          subtitle="此操作不可撤销，请务必完成二次确认。"
          onClose={() => {
            if (!busy) setPurgeTargets(null)
          }}
        >
          <div className="danger-banner" role="alert">
            <AlertTriangle size={18} />
            <div>
              <strong>
                即将彻底删除 {purgeTargets.length} 个文件，释放约{' '}
                {formatSize(purgeTargets.reduce((sum, f) => sum + f.size, 0))} 空间
              </strong>
              <p>
                删除后本地正文与全文检索记录无法找回。若部分文件正被活跃 ZIP
                打包或在线备份引用，服务端会自动拦截本次清理。
              </p>
            </div>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={purgeChecked}
              disabled={busy}
              onChange={(e) => setPurgeChecked(e.target.checked)}
            />
            我已确认已完成必要备份，了解永久清理不可恢复
          </label>
          <label className="field">
            请输入「永久清理」以确认
            <input
              value={purgeText}
              disabled={busy}
              placeholder="永久清理"
              onChange={(e) => setPurgeText(e.target.value)}
            />
          </label>
          {serverError && (
            <p className="error-text" role="alert">
              {serverError}
            </p>
          )}
          <footer className="modal-footer">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setPurgeTargets(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button danger-solid"
              disabled={busy || !purgeChecked || purgeText.trim() !== '永久清理'}
              onClick={async () => {
                const ok = await onPurge(purgeTargets.map((f) => f.id))
                if (ok) {
                  setSelected((old) =>
                    old.filter((id) => !purgeTargets.some((target) => target.id === id)),
                  )
                  setPurgeTargets(null)
                }
              }}
            >
              <Trash2 size={15} />
              {busy ? '清理中…' : `确认永久清理 ${purgeTargets.length} 个文件`}
            </button>
          </footer>
        </Modal>
      )}
    </>
  )
}
