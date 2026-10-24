import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Files, FolderClosed, HardDrive, LayoutDashboard, Link, Menu, Plus, Search, Settings, ShieldCheck, Sparkles, Trash2, WandSparkles, X } from 'lucide-react'
import { Brand, Empty, Modal } from './components/ui'
import { CollectionCard, Collections, CollectionForm, ShareCollection } from './features/collections'
import { CollectionDetail } from './features/collection-detail'
import { FileDetail, FileTable, TrashPage } from './features/files'
import { RenameModal } from './features/rename'
import { ToolsPage } from './features/workspace-pages'
import { StoragePage } from './features/storage'
import { SettingsPage } from './features/settings'
import { ContentPanel } from './features/content'
import { Assistant } from './features/assistant'
import { AIPlan } from './features/ai-plan'
import { PublicSubmission } from './features/submission'
import { StartChecklist } from './features/start-checklist'
import { AdminGate, useAccount } from './features/auth'
import { formatSize, useWorkspace } from './lib/workspace'
import { api } from './lib/api'
import { collectionState, isExpired } from './lib/collections'
import type { AIReply, CollectedFile, Collection, CollectionStatus, Page, StorageId, Workspace } from './types'

const navigation = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard },
  { id: 'collections', label: '收集任务', icon: FolderClosed },
  { id: 'files', label: '文件管理', icon: Files },
  { id: 'tools', label: '批量工具', icon: WandSparkles },
] as const
const pageNames: Record<Page, string> = { overview: '工作台', collections: '收集任务', files: '文件管理', tools: '批量工具', storage: '存储空间', settings: '设置', trash: '回收站' }

function readPage(): Page {
  const candidate = location.hash.replace('#/', '').split('/')[0]
  return candidate in pageNames ? candidate as Page : 'overview'
}

export default function App() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => { const sync = () => setHash(location.hash); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync) }, [])
  return hash.startsWith('#/submit/') ? <PublicSubmission key={hash} uploadToken={hash.slice('#/submit/'.length)} /> : <AdminGate><WorkspaceApp /></AdminGate>
}

function WorkspaceApp() {
  const { canEdit, user, isAdmin } = useAccount()
  const { workspace, loading, error, refresh, refreshing, updatedAt, mutate } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState('')
  const busyRef = useRef(false)
  const [trashing, setTrashing] = useState<string[] | null>(null)
  const [page, setPage] = useState<Page>(readPage)
  const [hash, setHash] = useState(location.hash)
  const [menuOpen, setMenuOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const [createOpen, setCreateOpen] = useState(false)
  const [createStorage, setCreateStorage] = useState<StorageId>('local')
  const [editing, setEditing] = useState<Collection | null>(null)
  const [share, setShare] = useState<Collection | null>(null)
  const [detail, setDetail] = useState<CollectedFile | null>(null)
  const [renaming, setRenaming] = useState<CollectedFile[] | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [assistantFileIds, setAssistantFileIds] = useState<string[]>([])
  const [assistantCollectionId, setAssistantCollectionId] = useState('')
  const [aiProposal, setAiProposal] = useState<AIReply | null>(null)
  const [notifications, setNotifications] = useState(false)
  const [help, setHelp] = useState(false)
  const [search, setSearch] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [toast, setToast] = useState('')
  const [toastError, setToastError] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notificationRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = () => { setPage(readPage()); setHash(location.hash); setMenuOpen(false); setNotifications(false) }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])
  useEffect(() => {
    const section = page === 'settings' ? hash.split('/')[2] : ''
    const targetId = section === 'diagnostics' ? 'settings-diagnostics' : section === 'backups' ? 'settings-backups' : ''
    const target = targetId ? document.getElementById(targetId) : null
    if (!target) { window.scrollTo(0, 0); return }
    const align = () => target.scrollIntoView({ block: 'start' })
    align(); target.focus({ preventScroll: true })
    // Settings panels load independently. Keep the initial destination in view until interaction.
    const observer = new ResizeObserver(align)
    const layout = target.closest('.settings-layout')
    if (layout) { observer.observe(layout); for (const panel of layout.children) observer.observe(panel) }
    const stop = () => observer.disconnect()
    const inputs = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
    for (const event of inputs) window.addEventListener(event, stop, { passive: true, once: true })
    const timer = window.setTimeout(stop, 5000)
    return () => { observer.disconnect(); clearTimeout(timer); for (const event of inputs) window.removeEventListener(event, stop) }
  }, [page, hash, loading])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const resize = () => { setIsMobile(media.matches); setMenuOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    media.addEventListener('change', resize); window.addEventListener('keydown', escape)
    return () => { media.removeEventListener('change', resize); window.removeEventListener('keydown', escape) }
  }, [])
  useEffect(() => {
    const handler = (e: PointerEvent) => { if (notificationRef.current && !notificationRef.current.contains(e.target as Node)) setNotifications(false) }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => setOperationError(''), [createOpen, editing, renaming, share, trashing, aiProposal])
  function notify(text: string, failed = false) {
    setToastError(failed)
    setToast(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 3500)
  }
  async function action(path: string, body: unknown, method = 'POST'): Promise<Workspace | undefined> {
    if (!canEdit) { notify('当前账号为只读成员', true); return }
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setOperationError('')
    try { const result = await mutate(path, body, method); return 'workspace' in result ? result.workspace : result }
    catch (e) { const message = (e as Error).message; setOperationError(message); notify(message, true) }
    finally { busyRef.current = false; setBusy(false) }
  }
  function navigate(next: Page) {
    setPage(next); setMenuOpen(false); setNotifications(false)
    if (next !== 'files') { setSearch(''); setCollectionId('') }
    location.hash = `/${next}`
  }
  function openCollection(id: string) { setPage('collections'); setHash(`#/collections/${id}`); setMenuOpen(false); setSearch(''); location.hash = `/collections/${id}` }
  function openSettings(section: 'diagnostics' | 'backups') { setPage('settings'); setHash(`#/settings/${section}`); setMenuOpen(false); setNotifications(false); setSearch(''); location.hash = `/settings/${section}` }
  async function review(ids: string[]) {
    if (await action('/api/files/review', { ids })) { setDetail(null); notify(`已将 ${ids.length} 个文件标记为已整理`) }
  }
  const active = workspace.collections.filter(c => collectionState(c) === 'active')
  const currentCollection = workspace.collections.find(c => c.id === collectionId)
  const taskId = page === 'collections' && hash.startsWith('#/collections/') ? hash.slice('#/collections/'.length) : ''
  const viewedCollection = workspace.collections.find(c => c.id === taskId)
  const total = workspace.collections.reduce((sum, c) => sum + c.received, 0)
  const pending = workspace.files.filter(f => f.status === 'pending').length
  const fileProps = { files: workspace.files, collections: workspace.collections, onRename: setRenaming, onReview: review, onDetail: setDetail, onTrash: setTrashing, onAI: openAssistant }
  function startCollection(storage: StorageId = 'local') { if (!canEdit) return; setCreateStorage(storage); setCreateOpen(true) }
  function openRename() { if (!canEdit) return; const list = workspace.files.filter(f => f.status === 'pending'); if (workspace.files.length) setRenaming(list.length ? list : workspace.files); else notify('先添加一些文件，再来试试重命名') }
  function openAssistant(files: CollectedFile[] = []) { if (!canEdit) return; setAssistantCollectionId(viewedCollection?.id || (files.length && files.every(f => f.collectionId === files[0].collectionId) ? files[0].collectionId : '')); setAssistantFileIds(files.slice(0, 30).map(f => f.id)); setAiOpen(true) }
  async function changeCollectionStatus(id: string, status: CollectionStatus) {
    const current = workspace.collections.find(c => c.id === id)
    if (!current) return
    if (status === 'active' && isExpired(current)) { notify('请先编辑规则，延长截止日期'); return }
    const label = status === 'active' ? '重新开放' : status === 'paused' ? '暂停' : '结束'
    if (await action(`/api/collections/${id}/status`, { status })) notify(`收集已${label}`)
  }
  const usedBytes = workspace.storage?.usedBytes || 0, quotaBytes = workspace.storage?.quotaBytes || 1
  const usedPercent = Math.min(100, usedBytes / quotaBytes * 100)
  if (loading) return <main className="auth-page"><p role="status">正在读取工作台…</p></main>

  return <div className={`app-shell ${canEdit ? '' : 'read-only-workspace'}`} aria-busy={busy}>
    {menuOpen && <button className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-label="收起导航" />}
    <aside inert={isMobile && !menuOpen} className={`sidebar ${menuOpen ? 'open' : ''}`}><a className="brand-link" href="#/overview" onClick={() => navigate('overview')} aria-label="集屿首页"><Brand /></a>
      <button className="workspace-switch" onClick={() => navigate('settings')}><span className="workspace-avatar">{workspace.displayName.slice(0, 1)}</span><span>我的工作空间<small>个人工作台</small></span><ChevronDown size={13} /></button>
      <p className="nav-caption">工作空间</p><nav aria-label="主导航">{navigation.map(n => <button className={page === n.id ? 'active' : ''} key={n.id} onClick={() => { setCollectionId(''); setSearch(''); navigate(n.id) }}><n.icon size={18} strokeWidth={1.7} /><span>{n.label}</span>{n.id === 'collections' && <em>{active.length}</em>}{n.id === 'tools' && <span className="nav-new">NEW</span>}</button>)}</nav>
      <p className="nav-caption second">管理</p><nav aria-label="文件恢复"><button className={page === 'trash' ? 'active' : ''} onClick={() => navigate('trash')}><Trash2 size={18} strokeWidth={1.7} /><span>回收站</span></button></nav><nav aria-label="工作空间管理"><button className={page === 'storage' ? 'active' : ''} onClick={() => navigate('storage')}><HardDrive size={18} strokeWidth={1.7} /><span>存储空间</span></button><button className={page === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}><Settings size={18} strokeWidth={1.7} /><span>设置</span></button></nav>
      <div className="sidebar-bottom"><div className="storage-meter"><div><span><HardDrive size={14} />本地存储</span><span className="meter-dot" /></div><p><b>{formatSize(usedBytes)}</b><span> / {formatSize(quotaBytes)}</span></p><div className="progress"><span style={{ width: `${usedPercent}%` }} /></div><button onClick={() => navigate('storage')}>管理存储空间<ArrowUpRight size={13} /></button><small>含回收站 · 收集配额</small></div><button className="sidebar-help" onClick={() => setHelp(true)}><CircleHelp size={16} /><span>使用指南</span><ArrowUpRight size={13} /></button><button className="account" onClick={() => navigate('settings')}><span className="account-avatar">{(user?.displayName || workspace.displayName).slice(0, 1)}</span><span><b>{user?.displayName || workspace.displayName}</b><small>{user?.role === 'admin' ? '管理员' : user?.role === 'editor' ? '编辑者' : '只读成员'}</small></span><Settings size={15} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="展开导航"><Menu size={20} /></button><span>我的工作空间</span><ChevronRight size={13} /><strong>{pageNames[page]}</strong></div><div className="topbar-right"><span className="preview-badge"><i />自托管工作台</span><form className="global-search" onSubmit={e => { e.preventDefault(); setCollectionId(''); navigate('files') }}><Search size={15} /><input aria-label="全局搜索" placeholder="搜索文件、提交人…" value={search} onChange={e => { setSearch(e.target.value); setCollectionId(''); if (e.target.value) navigate('files') }} /><span>⌕</span></form><div className="notification-container" ref={notificationRef}><button className={`icon-button notification-button ${notifications ? 'on' : ''}`} aria-label="查看最近动态" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><Bell size={19} strokeWidth={1.6} /><i /></button>{notifications && <div className="notification-popover"><h3>最近动态<span>{workspace.activities.length}</span></h3>{workspace.activities.map(a => <div key={a.id}><span className="activity-dot" /><p>{a.text}<small>{a.time}</small></p></div>)}</div>}</div><span className="topbar-avatar">{(user?.displayName || workspace.displayName).slice(0, 1)}</span></div></header>
      <main className="main-content" id="main-content">
        <div className="workspace-refresh"><span>{updatedAt ? `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 每 15 秒刷新` : '尚未更新'}</span><button className="text-button" disabled={refreshing || busy} onClick={() => void refresh()}>{refreshing ? '刷新中…' : '刷新工作台'}</button></div>
        {!canEdit && <div className="action-notice">{user?.displayName} · 只读访问，可查看、预览和下载文件。</div>}
        {error && <div className="error-banner" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>重新连接</button></div>}
        {busy && <div className="operation-progress" role="status">正在保存，请稍候…</div>}
        {workspace.lastRenameId && <div className="action-notice"><span>最近的批量整理可撤销</span><button className="text-button" onClick={async () => { if (await action(`/api/files/rename/${workspace.lastRenameId}/undo`, {})) notify('已撤销批量命名') }}>撤销上次整理</button></div>}
        {page === 'overview' && <>
          <div className="page-title home-title"><div><p className="greeting"><span className="greeting-line" />{workspace.displayName}，欢迎回到集屿</p><h1>每一份文件，都有归处<span className="title-dot">。</span></h1><p>收集、整理、妥善存放。把时间留给更重要的事。</p></div><button className="button primary" onClick={() => startCollection()}><Plus size={17} />新建收集</button></div>
          {isAdmin && <StartChecklist workspace={workspace} onCreate={() => startCollection()} onSettings={openSettings} onFiles={() => navigate('files')} />}
          <div className="overview-stats"><div><span><FolderClosed size={16} />进行中的收集</span><p>{active.length}<small>项</small><em><span />正在有序进行</em></p></div><div><span><ArrowDownToLine size={16} />累计收到文件</span><p>{total}<small>份</small><em className="stat-note">来自 {workspace.collections.length} 项收集</em></p></div><div><span><Clock3 size={16} />待整理文件</span><p>{pending}<small>份</small><button onClick={() => navigate('tools')}>去整理<ArrowUpRight size={13} /></button></p></div><div><span><HardDrive size={16} />已用存储空间</span><p className="real-storage-value">{formatSize(usedBytes)}<em className="stat-note">配额 {formatSize(quotaBytes)}</em></p></div></div>
          <section className="collections-section"><div className="section-heading"><h2>进行中的收集<span className="count-badge">{active.length}</span></h2><button className="text-button" onClick={() => navigate('collections')}>全部收集<ArrowRight size={15} /></button></div>{active.length ? <div className="collection-grid">{active.slice(0, 3).map(c => <CollectionCard key={c.id} collection={c} onOpen={openCollection} onShare={setShare} />)}</div> : <Empty title="从第一项收集开始" text="点击新建收集，告别零散的文件消息。" />}</section>
          <section className="recent-section"><div className="section-heading"><div className="heading-with-note"><h2>最近收到</h2><span>每一份新提交，都在这里</span></div><button className="text-button" onClick={() => { setCollectionId(''); navigate('files') }}>查看全部文件<ArrowRight size={15} /></button></div><FileTable {...fileProps} compact /></section>
          <div className="ai-banner"><div className="ai-banner-symbol"><Sparkles size={24} strokeWidth={1.5} /></div><div><h3>有些整理，一句话就好。</h3><p>试着说「帮我统一文件名」，先看看集屿 AI 的整理建议。</p></div><button className="text-button" disabled={!canEdit} onClick={() => openAssistant()}>和集屿 AI 聊聊<ArrowUpRight size={15} /></button></div>
          <div className="workspace-footnote"><span><ShieldCheck size={13} />你的文件，你来掌控</span><span>少一点繁琐，多一点从容。</span></div>
        </>}
        {page === 'collections' && !taskId && <Collections collections={workspace.collections} onOpen={openCollection} onShare={setShare} onCreate={() => startCollection()} />}
        {page === 'collections' && taskId && (viewedCollection ? <CollectionDetail key={viewedCollection.id} onMaterialAction={async (kind, body) => { await mutate(`/api/materials/${kind}`, body) }} onRefresh={refresh} collection={viewedCollection} {...fileProps} files={workspace.files.filter(f => f.collectionId === taskId)} onBack={() => navigate('collections')} onEdit={() => setEditing(viewedCollection)} onShare={() => setShare(viewedCollection)} onStatus={status => changeCollectionStatus(taskId, status)} /> : <><Empty title="没有找到这项收集" text="任务可能已被重置，请返回收集列表查看。" /><button className="button" onClick={() => navigate('collections')}>返回全部收集</button></>)}
        {page === 'files' && <><div className="page-title"><div><p className="eyebrow">A PLACE FOR EVERY FILE</p><h1>{currentCollection?.title || '所有文件，井井有条。'}</h1><p>{currentCollection?.description || '告别散落的文件，在这里找到每一份认真。'}</p></div>{currentCollection ? <button className="button primary" onClick={() => setShare(currentCollection)}><Link size={16} />分享收集</button> : <button className="button primary" onClick={openRename}><WandSparkles size={16} />批量重命名</button>}</div>
          <div className="files-view-header"><div className="files-tabs"><button className={!collectionId ? 'active' : ''} onClick={() => { setCollectionId(''); setSearch('') }}>全部文件<span>{workspace.files.length}</span></button><label><FolderClosed size={15} /><select aria-label="按收集任务筛选" value={collectionId} onChange={e => setCollectionId(e.target.value)}><option value="">按收集筛选</option>{workspace.collections.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label></div>{currentCollection && <button className="text-button" onClick={() => openCollection(currentCollection.id)}>管理这项收集<ArrowUpRight size={14} /></button>}</div>
          {search && <div className="search-result-note">搜索「{search}」<button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button></div>}
          <FileTable key={`files-${collectionId}`} {...fileProps} search={search} collectionId={collectionId} />
        </>}
        {page === 'tools' && <><ToolsPage workspace={workspace} onRename={openRename} onFiles={() => { setCollectionId(''); navigate('files') }} onAI={() => openAssistant()} /><ContentPanel files={workspace.files} /></>}
        {page === 'storage' && <StoragePage workspace={workspace} onCreate={startCollection} />}
        {page === 'trash' && <TrashPage files={workspace.trash || []} onRestore={async ids => { if (await action('/api/files/restore', { ids })) notify('文件已恢复') }} />}
        {page === 'settings' && <SettingsPage workspace={workspace} onSave={async name => { if (await action('/api/settings', { displayName: name }, 'PATCH')) notify('设置已保存') }} onLogout={async () => { try { await api('/api/auth/logout', 'POST', {}); window.dispatchEvent(new Event('jiyu:session-expired')) } catch (e) { notify((e as Error).message) } }} />}
      </main>
    </div>
    {canEdit && !aiOpen && <button className="ai-fab" onClick={() => openAssistant()}><Sparkles size={19} strokeWidth={1.6} /><span>集屿 AI</span><span className="ai-fab-dot" /></button>}
    {aiOpen && <Assistant workspace={workspace} initialFileIds={assistantFileIds} initialCollectionId={assistantCollectionId} onClose={() => setAiOpen(false)} onRename={files => files.length ? setRenaming(files) : openRename()} onConfigure={() => { setAiOpen(false); navigate('settings') }} onProposal={setAiProposal} />}
    {aiProposal && <AIPlan proposal={aiProposal} busy={busy} error={operationError} onClose={() => { if (!busy) setAiProposal(null) }} onApply={async () => { if (await action('/api/files/rename', { changes: aiProposal.changes, tags: aiProposal.tags, aiRunId: aiProposal.runId })) { setAiProposal(null); notify('AI 整理方案已应用，可撤销上次整理') } }} />}
    {(createOpen || editing) && <CollectionForm requestLimitMB={workspace.requestLimitMB} initialStorage={createStorage} collection={editing || undefined} busy={busy} serverError={operationError} onClose={() => { if (!busy) { setCreateOpen(false); setEditing(null) } }} onSave={async updated => {
      const saved = await action(editing ? `/api/collections/${editing.id}` : '/api/collections', updated, editing ? 'PATCH' : 'POST')
      if (!saved) return
      if (editing) { setEditing(null); notify('收集规则已更新，原链接保持有效') }
      else { const created = saved.collections[0]; setCreateOpen(false); openCollection(created.id); setShare(created); notify('新收集已创建') }
    }} />}
    {share && <ShareCollection collection={workspace.collections.find(c => c.id === share.id) || share} busy={busy} serverError={operationError} onRotate={async () => { if (await action(`/api/collections/${share.id}/rotate-token`, {})) notify('已生成新链接，旧链接已失效') }} onClose={() => setShare(null)} />}
    {detail && <FileDetail file={workspace.files.find(f => f.id === detail.id) || detail} collection={workspace.collections.find(c => c.id === detail.collectionId)} onClose={() => setDetail(null)} onRename={() => { setRenaming([detail]); setDetail(null) }} onReview={() => void review([detail.id])} onTrash={() => { setTrashing([detail.id]); setDetail(null) }} />}
    {renaming && <RenameModal files={renaming} allFiles={workspace.files} collections={workspace.collections} busy={busy} serverError={operationError} onClose={() => { if (!busy) setRenaming(null) }} onApply={async changes => { if (await action('/api/files/rename', { changes })) { setRenaming(null); notify(`已重命名 ${changes.length} 个文件`) } }} />}
    {trashing && <Modal title="将文件移入回收站？" onClose={() => { if (!busy) setTrashing(null) }}><p className="body-copy">所选 {trashing.length} 个文件将从列表隐藏，可在回收站恢复。文件内容仍占用存储空间。</p>{operationError && <p className="error-text" role="alert">{operationError}</p>}<footer className="modal-footer"><button className="button" disabled={busy} onClick={() => setTrashing(null)}>取消</button><button className="button primary" disabled={busy} onClick={async () => { if (await action('/api/files/trash', { ids: trashing })) { setTrashing(null); notify('文件已移入回收站') } }}>移入回收站</button></footer></Modal>}
    {help && <Modal title="从一个链接开始，轻松收齐文件" subtitle="集屿使用指南" onClose={() => setHelp(false)}><div className="guide-steps">{[['发起收集', '设置名称、截止时间和文件格式，创建收集任务。'], ['分享链接', '点击任务上的分享收集，打开提交者看到的页面，将链接发给需要提交文件的人。'], ['集中整理', '在文件管理中选择文件，用命名规则批量整理。']].map(([title, text], i) => <div key={title}><span>{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="form-note">在存储空间连接本机或云端，收集规则中选择目标；云端同步状态可单独查看。本机保留完整副本。设置页可管理成员、模型与自动备份。</div><footer className="modal-footer"><button className="button primary" onClick={() => setHelp(false)}>开始使用<ArrowRight size={15} /></button></footer></Modal>}
    {toast && <div className={`toast ${toastError ? 'failed' : ''}`} role={toastError ? 'alert' : 'status'}><span>{toastError ? <X size={14} /> : <Check size={14} />}</span>{toast}</div>}
  </div>
}
