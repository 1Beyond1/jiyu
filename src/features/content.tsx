import { useEffect, useState } from 'react'
import { FileSearch, ScanText } from 'lucide-react'
import { api } from '../lib/api'
import type { CollectedFile, DocumentInfo, FileContent } from '../types'
import { useAccount } from './auth'

const labels: Record<DocumentInfo['status'], string> = { queued: '等待识别', processing: '正在本机识别', ready: '已建立正文索引', failed: '识别未完成', unsupported: '此类型暂不支持' }
export function FilePreview({ file }: { file: CollectedFile }) {
  const { canEdit } = useAccount()
  const [content, setContent] = useState<FileContent | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => { try { setContent(await api<FileContent>(`/api/files/${file.id}/content`)); setError('') } catch (e) { setError((e as Error).message) } }
  useEffect(() => { void load() }, [file.id])
  const processing = content?.document?.status === 'queued' || content?.document?.status === 'processing'
  useEffect(() => { if (!processing) return; const timer = setInterval(() => void load(), 2000); return () => clearInterval(timer) }, [processing])
  return <section className="file-preview" aria-label="文件预览">{!content ? <p className="field-hint">{error || '正在读取预览…'}</p> : <>
    {content.preview === 'image' && <img src={`/api/files/${file.id}/preview`} alt={file.name} loading="lazy" />}
    {content.preview === 'pdf' && <iframe title={`${file.name} PDF 预览`} src={`/api/files/${file.id}/preview#toolbar=0`} />}
    {content.preview === 'none' && <p className="field-hint">此文件暂不支持直接预览，可以下载查看或识别正文。</p>}
    {content.text && <details className="extracted-text" open={content.preview === 'text'}><summary>识别内容 · {content.document?.chars.toLocaleString()} 字符{content.document?.truncated ? ' · 已截取' : ''}</summary><pre>{content.text}</pre></details>}
    <div className="content-status"><span>{content.document ? `${labels[content.document.status]}${content.document.kind ? ` · ${content.document.kind}` : ''}` : '尚未识别正文'}</span>{canEdit && <button className="text-button" disabled={busy || processing} onClick={async () => { setBusy(true); setError(''); try { await api('/api/content/index', 'POST', { ids: [file.id] }); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}><ScanText size={14} />{processing ? '识别中…' : content.document?.status === 'ready' ? '重新识别' : '识别正文 / OCR'}</button>}</div>
    {content.document?.error && <p className="error-text">{content.document.error}</p>}{error && <p className="error-text" role="alert">{error}</p>}
  </>}</section>
}

export function ContentPanel({ files }: { files: CollectedFile[] }) {
  const { canEdit } = useAccount()
  const [documents, setDocuments] = useState<DocumentInfo[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const load = async () => { try { const data = await api<{ documents: DocumentInfo[] }>('/api/content/status'); setDocuments(data.documents) } catch (e) { setError((e as Error).message) } }
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer) }, [])
  const active = new Set(files.map(f => f.id)), visible = documents.filter(d => active.has(d.file_id))
  const ready = visible.filter(d => d.status === 'ready'), pending = visible.filter(d => ['queued', 'processing'].includes(d.status)), failed = visible.filter(d => ['failed', 'unsupported'].includes(d.status))
  const candidates = files.filter(f => !visible.some(d => d.file_id === f.id && ['ready', 'queued', 'processing', 'unsupported'].includes(d.status)) && /\.(pdf|docx|txt|md|csv|json|log|png|jpe?g|webp|gif)$/i.test(f.name)).slice(0, 50)
  return <section className="settings-panel content-panel"><div className="section-heading"><div><h2><FileSearch size={18} />正文识别与检索</h2><p>在本机识别文字，找到文件名没有写出的内容。</p></div><span className="subtle-label">本机处理</span></div><div className="content-counters"><span><b>{ready.length}</b>已索引</span><span><b>{pending.length}</b>队列中</span><span><b>{failed.length}</b>待检查</span></div><p className="field-hint">支持 PDF、DOCX、UTF-8 文本和常见图片。每份正文最多索引 64,000 字符，PDF 文本读取前 50 页，扫描 PDF OCR 前 10 页。</p>{canEdit && <button className="button" disabled={busy || !candidates.length} onClick={async () => { setBusy(true); setError(''); setNotice(''); try { await api('/api/content/index', 'POST', { ids: candidates.map(f => f.id) }); setNotice(`已安排 ${candidates.length} 个文件。可在文件详情查看识别状态。`); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}><ScanText size={15} />识别待处理文件{candidates.length ? `（${candidates.length}）` : ''}</button>}{error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="success-text" role="status">{notice}</p>}<div className="form-note">识别文字随数据库备份保存，不会自动发给模型。图片 OCR 需要 Tesseract，PDF 需要 Poppler，Docker 镜像已包含。识别能力受扫描清晰度与语言影响。</div></section>
}
