import { isExpired } from '../lib/collections'
import { useRef, useState } from 'react'
import type { Collection, ReceiptDetail, UploadReceipt } from '../types'
import { formatSize } from '../lib/workspace'
import { parseReceiptFile } from '../lib/receipt-file'

export function ReceiptManager({ c, uploadToken, receipt, onOpen, onContinue }: { c: Collection; uploadToken: string; receipt: UploadReceipt | null; onOpen: (r: UploadReceipt) => void; onContinue: (detail: ReceiptDetail, replacement: boolean, key: string) => void }) {
  const [open, setOpen] = useState(false), [id, setId] = useState(''), [key, setKey] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [detail, setDetail] = useState<ReceiptDetail | null>(null)
  const closed = c.status !== 'active' || isExpired(c)
  const picker = useRef<HTMLInputElement>(null)
  async function importReceipt(file?: File) {
    if (!file || busy) return
    setBusy(true); setError(''); setDetail(null)
    try {
      if (file.size > 16384) throw new Error('回执文件过大，请选择集屿保存的 .txt 回执。')
      const saved = parseReceiptFile(await file.text(), location.origin, uploadToken)
      setId(saved.receiptId); setKey(saved.key)
      const result = await read(saved.receiptId, saved.key)
      if (result) { try { localStorage.setItem(`jiyu:receipt:${uploadToken}`, JSON.stringify({ ...result.receipt, editKey: saved.key })) } catch { /* The imported file remains a portable receipt. */ } }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function read(receiptId: string, secret: string) {
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/public/${encodeURIComponent(uploadToken)}/receipts/${encodeURIComponent(receiptId)}`, { credentials: 'same-origin', headers: { 'X-Receipt-Key': secret } })
      const data = await res.json(); if (!res.ok) throw new Error(data.error || '暂时无法读取回执')
      setDetail(data); setId(receiptId); setKey(secret); return data as ReceiptDetail
    } catch (e) { setDetail(null); setError((e as Error).message); return null } finally { setBusy(false) }
  }
  function saveReceipt() {
    if (!receipt) return
    const content = `集屿 · ${c.title}\n收集链接：${location.origin}/#/submit/${uploadToken}\n回执编号：${receipt.receiptId}\n私密凭证：${receipt.editKey || ''}\n请妥善保管，持有人可查询本批次并在允许时替换文件。\n`
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = '集屿提交回执.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function continueFrom(receiptId: string, secret: string, replacement: boolean) {
    const current = await read(receiptId, secret)
    if (!current) return
    if (current.superseded) { setError('此回执已被替换，请使用最新回执。'); return }
    setOpen(false); setDetail(null)
    onContinue(current, replacement, secret)
  }
  function nextActions(receiptId: string, secret: string, superseded = false) {
    return <><div className="receipt-next-actions"><div><button type="button" className="button" disabled={busy || closed || superseded || c.submissionMode === 'single'} onClick={() => void continueFrom(receiptId, secret, false)}>继续补交</button><p>新增一批文件，原来提交的文件继续保留。</p></div><div><button type="button" className="button" disabled={busy || closed || superseded || c.allowReplacement === false} onClick={() => void continueFrom(receiptId, secret, true)}>替换本批文件</button><p>请重新选择本批完整文件。成功后原批次进入回收站，其他补交批次保持保留。</p></div></div>{closed ? <p className="field-hint">收集已关闭，当前仅可查询和保存回执。</p> : superseded ? <p className="field-hint">此回执已被替换，请使用最新回执继续操作。</p> : <>{c.submissionMode === 'single' && <p className="field-hint">此任务仅允许提交一次，不能补交。</p>}{c.allowReplacement === false && <p className="field-hint">发起人未开放文件替换。</p>}</>}</>
  }
  if (receipt) return <div className="receipt-actions"><p className="field-hint">请保存私密回执，换设备后也可查询或替换本批文件。此浏览器会记住最新一次回执。</p><button className="button" onClick={saveReceipt}>保存私密回执</button>{nextActions(receipt.receiptId, receipt.editKey || '', detail?.receipt.receiptId === receipt.receiptId && detail.superseded)}{error && <p className="error-text" role="alert">{error}</p>}</div>
  return <div className="receipt-manager"><button type="button" className="text-button" onClick={() => { setOpen(!open); setError(''); try { const saved = JSON.parse(localStorage.getItem(`jiyu:receipt:${uploadToken}`) || 'null'); if (saved) { setId(saved.receiptId); setKey(saved.editKey) } } catch { /* Manual recovery remains available. */ } }}>{open ? '收起回执查询' : '已经交过？查询回执 / 替换文件'}</button>{open && <div><div className="receipt-import"><input ref={picker} type="file" accept=".txt,text/plain" className="sr-only" aria-label="选择私密回执文件" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void importReceipt(file) }} /><button type="button" className="button" disabled={busy} onClick={() => picker.current?.click()}>{busy ? '正在核验…' : '导入私密回执文件'}</button><p>选择之前保存的 .txt 回执，自动查询本人记录；也可在下方手动填写。</p></div><label className="field">回执编号<input value={id} disabled={busy} onChange={e => { setId(e.target.value); setDetail(null) }} maxLength={36} autoComplete="off" /></label><label className="field">私密凭证<input type="password" value={key} disabled={busy} onChange={e => { setKey(e.target.value); setDetail(null) }} maxLength={100} autoComplete="off" /></label><button type="button" className="button" disabled={busy || !id || !key} onClick={() => void read(id, key)}>{busy ? '查询中…' : '查询本人回执'}</button>{detail && <div className="receipt-result"><strong>{detail.owner} · {detail.superseded ? '已被替换' : `${detail.files.length} 份有效文件`}</strong>{detail.files.map(f => <p key={f.id}>{f.name} · {formatSize(f.size)}</p>)}<button type="button" className="text-button" onClick={() => onOpen({ ...detail.receipt, editKey: key })}>打开并保存回执</button>{nextActions(detail.receipt.receiptId, key, detail.superseded)}</div>}{error && <p className="error-text" role="alert">{error}</p>}<small>只能查询持有私密凭证的回执。遗失凭证请联系发起人。</small></div>}</div>
}
