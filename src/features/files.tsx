import { useState } from 'react'
import { ArrowDown, ArrowUpRight, Check, ChevronDown, Download, Ellipsis, RotateCcw, Search, Sparkles, Trash2, WandSparkles, X } from 'lucide-react'
import { Empty, FileIcon, Modal } from '../components/ui'
import type { CollectedFile, Collection } from '../types'
import { storageNames } from '../types'
import { csvCell, downloadText, formatDate, formatSize } from '../lib/workspace'

interface FileTableProps {
  files: CollectedFile[]
  collections: Collection[]
  compact?: boolean
  search?: string
  collectionId?: string
  onRename: (files: CollectedFile[]) => void
  onReview: (ids: string[]) => void
  onDetail: (file: CollectedFile) => void
  onTrash?: (ids: string[]) => void
  onAI?: (files: CollectedFile[]) => void
}

export function FileTable({ files, collections, compact = false, search = '', collectionId = '', onRename, onReview, onDetail, onTrash, onAI }: FileTableProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<string[]>([])
  const [sortAsc, setSortAsc] = useState(false)
  const visible = files.filter(f => (!collectionId || f.collectionId === collectionId) && `${f.name} ${f.owner}`.toLowerCase().includes((search || query).toLowerCase()) && (filter === 'all' || (filter === 'pending' ? f.status === 'pending' : ['jpg', 'jpeg', 'png', 'heic', 'svg'].includes(f.name.split('.').pop()?.toLowerCase() || '')))).sort((a, b) => (sortAsc ? 1 : -1) * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()))
  const list = compact ? visible.slice(0, 5) : visible
  const chosen = files.filter(f => selected.includes(f.id))
  const allChecked = list.length > 0 && list.every(f => selected.includes(f.id))
  function exportCsv() {
    const rows = (chosen.length ? chosen : visible).map(f => [f.name, f.owner, collections.find(c => c.id === f.collectionId)?.title || '', formatSize(f.size), formatDate(f.createdAt)].map(csvCell).join(','))
    downloadText('集屿-文件清单.csv', '\uFEFF文件名称,提交人,收集任务,文件大小,提交时间\n' + rows.join('\n'), 'text/csv;charset=utf-8')
  }
  return <div className="file-panel">
    {!compact && <div className="file-toolbar"><div className="input-with-icon"><Search size={16} /><input placeholder="搜索文件名、提交人…" aria-label="搜索文件" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="toolbar-actions"><label className="select-filter"><select aria-label="筛选文件" value={filter} onChange={e => { setFilter(e.target.value); setSelected([]) }}><option value="all">全部文件</option><option value="pending">待整理</option><option value="image">图片文件</option></select><ChevronDown size={14} /></label><button className="button" onClick={exportCsv}><Download size={15} />导出清单</button></div></div>}
    {!!selected.length && <div className="selection-bar"><span>已选择 <b>{selected.length}</b> 个文件</span><button onClick={() => onRename(chosen)}><WandSparkles size={15} />批量重命名</button>{onAI && <button disabled={chosen.length > 30} title="AI 每次最多处理 30 个文件" onClick={() => onAI(chosen)}><Sparkles size={15} />AI 建议</button>}<button onClick={() => { onReview(selected); setSelected([]) }}><Check size={15} />标记已整理</button>{onTrash && <button onClick={() => { onTrash(selected); setSelected([]) }}><Trash2 size={15} />移入回收站</button>}<button className="icon-button" aria-label="取消选择" onClick={() => setSelected([])}><X size={16} /></button></div>}
    <div className="table-scroll"><table><thead><tr><th className="check-column"><input type="checkbox" aria-label="全选当前文件" checked={allChecked} onChange={() => setSelected(allChecked ? [] : [...new Set([...selected, ...list.map(f => f.id)])])} /></th><th>文件名称</th><th>所属收集</th><th>提交人</th><th><button className="table-sort" onClick={() => setSortAsc(!sortAsc)}>提交时间<ArrowDown size={12} className={sortAsc ? 'rotated' : ''} /></button></th><th>大小</th><th aria-label="操作" /></tr></thead>
      <tbody>{list.map(f => <tr key={f.id} className={selected.includes(f.id) ? 'selected' : ''}><td><input type="checkbox" checked={selected.includes(f.id)} aria-label={`选择${f.name}`} onChange={() => setSelected(selected.includes(f.id) ? selected.filter(id => id !== f.id) : [...selected, f.id])} /></td><td><button className="file-name" onClick={() => onDetail(f)}><FileIcon name={f.name} /><span>{f.name}{f.status === 'pending' && <i className="pending-dot" title="待整理" />}</span></button></td><td><span className="collection-label">{collections.find(c => c.id === f.collectionId)?.title || '未分类'}</span></td><td><span className={`avatar tiny color-${f.owner.length % 3}`}>{f.owner.slice(0, 1)}</span><span className="owner-name">{f.owner}</span></td><td className="cell-muted numeric">{formatDate(f.createdAt)}</td><td className="cell-muted numeric">{formatSize(f.size)}</td><td><button className="icon-button" onClick={() => onDetail(f)} aria-label={`查看${f.name}详情`}><Ellipsis size={18} /></button></td></tr>)}</tbody>
    </table></div>
    {!list.length && <Empty />}
    {!compact && <footer className="table-footer"><span>共 {visible.length} 个文件</span><span>所有文件都已显示<Check size={13} /></span></footer>}
  </div>
}

export function FileDetail({ file, collection, onClose, onRename, onReview, onTrash }: { file: CollectedFile; collection?: Collection; onClose: () => void; onRename: () => void; onReview: () => void; onTrash: () => void }) {
  return <Modal title="文件详情" onClose={onClose}>
    <div className="file-detail-title"><FileIcon name={file.name} large /><h3>{file.name}</h3><span className={`status ${file.status === 'ready' ? 'active' : 'paused'}`}><i />{file.status === 'ready' ? '已整理' : '待整理'}</span></div>
    <dl className="detail-list"><div><dt>所属收集</dt><dd>{collection?.title}</dd></div><div><dt>提交人</dt><dd>{file.owner}</dd></div><div><dt>文件大小</dt><dd>{formatSize(file.size)}</dd></div><div><dt>提交时间</dt><dd>{formatDate(file.createdAt)}</dd></div><div><dt>存储位置</dt><dd>{storageNames[file.storage]}</dd></div></dl>
    <div className="checksum"><span>SHA-256 内容校验</span><code>{file.sha256}</code></div>
    <footer className="modal-footer file-detail-actions"><button className="icon-button" onClick={onTrash} aria-label="移入回收站"><Trash2 size={17} /></button><button className="button" onClick={onRename}>重命名<ArrowUpRight size={15} /></button><button className="button" onClick={onReview}><Check size={15} />已整理</button><a className="button primary" href={`/api/files/${file.id}/download`}><Download size={15} />下载</a></footer>
  </Modal>
}

export function TrashPage({ files, onRestore }: { files: CollectedFile[]; onRestore: (ids: string[]) => void }) {
  return <><div className="page-title"><div><p className="eyebrow">A SECOND CHANCE</p><h1>暂时放下，也能找回。</h1><p>移入回收站的文件仍占用存储空间，可随时恢复。</p></div>{!!files.length && <button className="button" onClick={() => onRestore(files.slice(0, 500).map(f => f.id))}><RotateCcw size={15} />恢复全部（最多 500 个）</button>}</div>{files.length ? <div className="trash-list">{files.map(f => <div key={f.id}><FileIcon name={f.name} /><div><strong>{f.name}</strong><small>{f.owner} · {formatSize(f.size)} · {formatDate(f.deletedAt!)}</small></div><button className="button" onClick={() => onRestore([f.id])}><RotateCcw size={14} />恢复</button></div>)}</div> : <Empty title="回收站是空的" text="移除的文件会先放在这里，方便找回。" />}<div className="form-note">第一版不提供不可逆的在线清空，避免误删。需要释放空间时，先完成备份并按部署文档执行离线清理。</div></>
}
