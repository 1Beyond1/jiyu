import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Files, FolderClosed, HardDrive, LayoutDashboard, Link, Menu, Plus, Search, Settings, ShieldCheck, Sparkles, WandSparkles, X } from 'lucide-react'
import { Brand, Empty, Modal } from './components/ui'
import { CollectionCard, Collections, CreateCollection, ShareCollection } from './features/collections'
import { FileDetail, FileTable } from './features/files'
import { RenameModal } from './features/rename'
import { SettingsPage, StoragePage, ToolsPage } from './features/workspace-pages'
import { Assistant } from './features/assistant'
import { Submission } from './features/submission'
import { createWorkspace, useWorkspace } from './lib/workspace'
import type { CollectedFile, Collection, Page } from './types'

const navigation = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard },
  { id: 'collections', label: '收集任务', icon: FolderClosed },
  { id: 'files', label: '文件管理', icon: Files },
  { id: 'tools', label: '批量工具', icon: WandSparkles },
] as const
const pageNames: Record<Page, string> = { overview: '工作台', collections: '收集任务', files: '文件管理', tools: '批量工具', storage: '存储空间', settings: '设置' }

function readPage(): Page {
  const candidate = location.hash.replace('#/', '').split('/')[0]
  return candidate in pageNames ? candidate as Page : 'overview'
}

export default function App() {
  const { workspace, setWorkspace, saveError } = useWorkspace()
  const [page, setPage] = useState<Page>(readPage)
  const [hash, setHash] = useState(location.hash)
  const [menuOpen, setMenuOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [share, setShare] = useState<Collection | null>(null)
  const [detail, setDetail] = useState<CollectedFile | null>(null)
  const [renaming, setRenaming] = useState<CollectedFile[] | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [notifications, setNotifications] = useState(false)
  const [help, setHelp] = useState(false)
  const [search, setSearch] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [toast, setToast] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notificationRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = () => { setPage(readPage()); setHash(location.hash); setMenuOpen(false); setNotifications(false) }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])
  useEffect(() => {
    const handler = (e: PointerEvent) => { if (notificationRef.current && !notificationRef.current.contains(e.target as Node)) setNotifications(false) }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  function notify(text: string) {
    setToast(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 3500)
  }
  function navigate(next: Page) {
    setPage(next); setMenuOpen(false); setNotifications(false)
    if (next !== 'files') { setSearch(''); setCollectionId('') }
    location.hash = `/${next}`
  }
  function openCollection(id: string) { setCollectionId(id); setSearch(''); navigate('files') }
  function review(ids: string[]) {
    setWorkspace(w => ({ ...w, files: w.files.map(f => ids.includes(f.id) ? { ...f, status: 'ready' } : f) }))
    setDetail(null); notify(`已将 ${ids.length} 个文件标记为已整理`)
  }
  const active = workspace.collections.filter(c => c.status === 'active')
  const currentCollection = workspace.collections.find(c => c.id === collectionId)
  const total = workspace.collections.reduce((sum, c) => sum + c.received, 0)
  const pending = workspace.files.filter(f => f.status === 'pending').length
  const fileProps = { files: workspace.files, collections: workspace.collections, onRename: setRenaming, onReview: review, onDetail: setDetail }
  function openRename() { const list = workspace.files.filter(f => f.status === 'pending'); if (workspace.files.length) setRenaming(list.length ? list : workspace.files); else notify('先添加一些文件，再来试试重命名') }

  if (hash.startsWith('#/submit/')) return <Submission ownerName={workspace.displayName} collection={workspace.collections.find(c => c.id === hash.slice('#/submit/'.length))} onSubmit={files => setWorkspace(w => ({ ...w, files: [...files, ...w.files], collections: w.collections.map(c => c.id === files[0]?.collectionId ? { ...c, received: c.received + files.length } : c), activities: [{ id: crypto.randomUUID(), text: `${files[0]?.owner}提交了 ${files.length} 份文件（演示）`, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }) }, ...w.activities].slice(0, 20) }))} />

  return <div className="app-shell">
    {menuOpen && <button className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-label="收起导航" />}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}><a className="brand-link" href="#/overview" onClick={() => navigate('overview')} aria-label="集屿首页"><Brand /></a>
      <button className="workspace-switch" onClick={() => navigate('settings')}><span className="workspace-avatar">林</span><span>我的工作空间<small>个人工作台</small></span><ChevronDown size={13} /></button>
      <p className="nav-caption">工作空间</p><nav aria-label="主导航">{navigation.map(n => <button className={page === n.id ? 'active' : ''} key={n.id} onClick={() => { setCollectionId(''); setSearch(''); navigate(n.id) }}><n.icon size={18} strokeWidth={1.7} /><span>{n.label}</span>{n.id === 'collections' && <em>{active.length}</em>}{n.id === 'tools' && <span className="nav-new">NEW</span>}</button>)}</nav>
      <p className="nav-caption second">管理</p><nav aria-label="工作空间管理"><button className={page === 'storage' ? 'active' : ''} onClick={() => navigate('storage')}><HardDrive size={18} strokeWidth={1.7} /><span>存储空间</span></button><button className={page === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}><Settings size={18} strokeWidth={1.7} /><span>设置</span></button></nav>
      <div className="sidebar-bottom"><div className="storage-meter"><div><span><HardDrive size={14} />本地存储</span><span className="meter-dot" /></div><p><b>12.8 GB</b><span> / 100 GB</span></p><div className="progress"><span style={{ width: '12.8%' }} /></div><button onClick={() => navigate('storage')}>管理存储空间<ArrowUpRight size={13} /></button><small>演示容量</small></div><button className="sidebar-help" onClick={() => setHelp(true)}><CircleHelp size={16} /><span>使用指南</span><ArrowUpRight size={13} /></button><button className="account" onClick={() => navigate('settings')}><span className="account-avatar">{workspace.displayName.slice(0, 1)}</span><span><b>{workspace.displayName}</b><small>个人账号</small></span><Settings size={15} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="展开导航"><Menu size={20} /></button><span>我的工作空间</span><ChevronRight size={13} /><strong>{pageNames[page]}</strong></div><div className="topbar-right"><span className="preview-badge"><i />界面预览</span><form className="global-search" onSubmit={e => { e.preventDefault(); setCollectionId(''); navigate('files') }}><Search size={15} /><input aria-label="全局搜索" placeholder="搜索文件、提交人…" value={search} onChange={e => { setSearch(e.target.value); setCollectionId(''); if (e.target.value) navigate('files') }} /><span>⌕</span></form><div className="notification-container" ref={notificationRef}><button className={`icon-button notification-button ${notifications ? 'on' : ''}`} aria-label="查看最近动态" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><Bell size={19} strokeWidth={1.6} /><i /></button>{notifications && <div className="notification-popover"><h3>最近动态<span>{workspace.activities.length}</span></h3>{workspace.activities.map(a => <div key={a.id}><span className="activity-dot" /><p>{a.text}<small>{a.time}</small></p></div>)}</div>}</div><span className="topbar-avatar">{workspace.displayName.slice(0, 1)}</span></div></header>
      <main className="main-content" id="main-content">
        {saveError && <div className="error-banner" role="alert">浏览器存储空间不足，最新修改暂未保存。请在设置里导出记录。</div>}
        {page === 'overview' && <>
          <div className="page-title home-title"><div><p className="greeting">生活有序，工作从容<span className="greeting-line" /></p><h1>每一份文件，都有归处<span className="title-dot">。</span></h1><p>收集、整理、妥善存放。把时间留给更重要的事。</p></div><button className="button primary" onClick={() => setCreateOpen(true)}><Plus size={17} />新建收集</button></div>
          <div className="overview-stats"><div><span><FolderClosed size={16} />进行中的收集</span><p>{active.length}<small>项</small><em><span />正在有序进行</em></p></div><div><span><ArrowDownToLine size={16} />累计收到文件</span><p>{total}<small>份</small><em className="stat-note">来自 {workspace.collections.length} 项收集</em></p></div><div><span><Clock3 size={16} />待整理文件</span><p>{pending}<small>份</small><button onClick={() => navigate('tools')}>去整理<ArrowUpRight size={13} /></button></p></div><div><span><HardDrive size={16} />已用存储空间</span><p>12.8<small>GB</small><em className="stat-note">共 100 GB · 演示</em></p></div></div>
          <section className="collections-section"><div className="section-heading"><h2>进行中的收集<span className="count-badge">{active.length}</span></h2><button className="text-button" onClick={() => navigate('collections')}>全部收集<ArrowRight size={15} /></button></div>{active.length ? <div className="collection-grid">{active.slice(0, 3).map(c => <CollectionCard key={c.id} collection={c} onOpen={openCollection} onShare={setShare} />)}</div> : <Empty title="从第一项收集开始" text="点击新建收集，告别零散的文件消息。" />}</section>
          <section className="recent-section"><div className="section-heading"><div className="heading-with-note"><h2>最近收到</h2><span>每一份新提交，都在这里</span></div><button className="text-button" onClick={() => { setCollectionId(''); navigate('files') }}>查看全部文件<ArrowRight size={15} /></button></div><FileTable {...fileProps} compact /></section>
          <div className="ai-banner"><div className="ai-banner-symbol"><Sparkles size={24} strokeWidth={1.5} /></div><div><h3>文件有点多？让 AI 搭把手。</h3><p>统一命名、梳理进度，让井井有条变得轻而易举。</p></div><button className="text-button" onClick={() => setAiOpen(true)}>和集屿 AI 聊聊<ArrowUpRight size={15} /></button><div className="banner-lines"><span /><span /><span /></div></div>
          <div className="workspace-footnote"><span><ShieldCheck size={13} />你的文件，你来掌控</span><span>少一点繁琐，多一点从容。</span></div>
        </>}
        {page === 'collections' && <Collections collections={workspace.collections} onOpen={openCollection} onShare={setShare} onCreate={() => setCreateOpen(true)} />}
        {page === 'files' && <><div className="page-title"><div><p className="eyebrow">A PLACE FOR EVERY FILE</p><h1>{currentCollection?.title || '所有文件，井井有条。'}</h1><p>{currentCollection?.description || '告别散落的文件，在这里找到每一份认真。'}</p></div>{currentCollection ? <button className="button primary" onClick={() => setShare(currentCollection)}><Link size={16} />分享收集</button> : <button className="button primary" onClick={openRename}><WandSparkles size={16} />批量重命名</button>}</div>
          <div className="files-view-header"><div className="files-tabs"><button className={!collectionId ? 'active' : ''} onClick={() => { setCollectionId(''); setSearch('') }}>全部文件<span>{workspace.files.length}</span></button><label><FolderClosed size={15} /><select aria-label="按收集任务筛选" value={collectionId} onChange={e => setCollectionId(e.target.value)}><option value="">按收集筛选</option>{workspace.collections.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label></div>{currentCollection && <button className="text-button" onClick={() => { setWorkspace(w => ({ ...w, collections: w.collections.map(c => c.id === collectionId ? { ...c, status: c.status === 'active' ? 'paused' : 'active' } : c) })); notify(currentCollection.status === 'active' ? '收集已暂停' : '收集已恢复') }}>{currentCollection.status === 'active' ? '暂停收集' : '重新开启'}</button>}</div>
          {search && <div className="search-result-note">搜索「{search}」<button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button></div>}
          <FileTable key={`files-${collectionId}`} {...fileProps} search={search} collectionId={collectionId} />
        </>}
        {page === 'tools' && <ToolsPage workspace={workspace} onRename={openRename} onFiles={() => { setCollectionId(''); navigate('files') }} onAI={() => setAiOpen(true)} />}
        {page === 'storage' && <StoragePage />}
        {page === 'settings' && <SettingsPage workspace={workspace} onSave={name => { setWorkspace(w => ({ ...w, displayName: name })); notify('设置已保存') }} onReset={() => { setWorkspace(createWorkspace()); notify('已恢复初始演示') }} />}
      </main>
    </div>
    {!aiOpen && <button className="ai-fab" onClick={() => setAiOpen(true)}><Sparkles size={19} strokeWidth={1.6} /><span>集屿 AI</span><span className="ai-fab-dot" /></button>}
    {aiOpen && <Assistant workspace={workspace} onClose={() => setAiOpen(false)} onRename={openRename} />}
    {createOpen && <CreateCollection onClose={() => setCreateOpen(false)} onCreate={c => { setWorkspace(w => ({ ...w, collections: [c, ...w.collections] })); setCreateOpen(false); setShare(c); notify('新收集已创建') }} />}
    {share && <ShareCollection collection={share} onClose={() => setShare(null)} />}
    {detail && <FileDetail file={detail} collection={workspace.collections.find(c => c.id === detail.collectionId)} onClose={() => setDetail(null)} onRename={() => { setRenaming([detail]); setDetail(null) }} onReview={() => review([detail.id])} />}
    {renaming && <RenameModal files={renaming} allFiles={workspace.files} collections={workspace.collections} onClose={() => setRenaming(null)} onApply={changes => { setWorkspace(w => ({ ...w, files: w.files.map(f => { const change = changes.find(c => c.id === f.id); return change ? { ...f, name: change.name } : f }) })); setRenaming(null); notify(`已重命名 ${changes.length} 个文件`) }} />}
    {help && <Modal title="从一个链接开始，轻松收齐文件" subtitle="集屿使用指南" onClose={() => setHelp(false)}><div className="guide-steps">{[['发起收集', '设置名称、截止时间和文件格式，创建收集任务。'], ['分享链接', '点击任务上的分享收集，预览提交者看到的页面。'], ['集中整理', '在文件管理中选择文件，用命名规则批量整理。']].map(([title, text], i) => <div key={title}><span>{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="form-note">当前为本地界面原型。文件只保存信息；网盘授权、真实上传和 AI 模型尚未接入。</div><footer className="modal-footer"><button className="button primary" onClick={() => setHelp(false)}>开始使用<ArrowRight size={15} /></button></footer></Modal>}
    {toast && <div className="toast" role="status"><span><Check size={14} /></span>{toast}</div>}
  </div>
}
