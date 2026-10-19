import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { X, FileText, Image, FileArchive, FileSpreadsheet, Shapes, FolderOpen, Inbox } from 'lucide-react'

export function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'small' : ''}`}><img src="/favicon.svg" alt="" /><div><strong>集屿<span>jiyu</span></strong>{!small && <p>让文件，各得其所</p>}</div></div>
}

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={id} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="modal-inner"><header className="modal-heading"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={19} /></button></header>{children}</div>
  </dialog>
}

export function FileIcon({ name, large = false }: { name: string; large?: boolean }) {
  const ext = name.split('.').pop()?.toLowerCase()
  const kind = ext === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'heic', 'svg'].includes(ext || '') ? 'image' : ext === 'fig' ? 'fig' : ['xlsx', 'csv', 'xls'].includes(ext || '') ? 'sheet' : ['zip', 'rar', '7z'].includes(ext || '') ? 'archive' : 'doc'
  const Icon = { pdf: FileText, image: Image, fig: Shapes, sheet: FileSpreadsheet, archive: FileArchive, doc: FileText }[kind]
  return <span className={`file-icon ${kind} ${large ? 'large' : ''}`}><Icon size={large ? 30 : 19} strokeWidth={1.6} /></span>
}

export function Empty({ title = '这里还没有文件', text = '试试调整筛选条件，或发起一项新的收集。' }: { title?: string; text?: string }) {
  return <div className="empty"><Inbox size={35} strokeWidth={1.3} /><h3>{title}</h3><p>{text}</p></div>
}

export function CollectionIcon({ category }: { category: string }) {
  return <span className={`collection-icon ${category}`}>{category === 'photo' ? <Image size={24} strokeWidth={1.5} /> : category === 'document' ? <FileText size={24} strokeWidth={1.5} /> : <FolderOpen size={25} strokeWidth={1.5} />}</span>
}
