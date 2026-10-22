import { useState } from 'react'
import type { Collection, ReceiptDetail, UploadReceipt } from '../types'
import { formatSize } from '../lib/workspace'

export function ReceiptManager({ c, uploadToken, receipt, onOpen, onContinue }: { c: Collection; uploadToken: string; receipt: UploadReceipt | null; onOpen: (r: UploadReceipt) => void; onContinue: (detail: ReceiptDetail, replacement: boolean, key: string) => void }) {
  const [open, setOpen] = useState(false), [id, setId] = useState(''), [key, setKey] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [detail, setDetail] = useState<ReceiptDetail | null>(null)
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
  if (receipt) return <div className="receipt-actions"><p className="field-hint">请保存私密回执，换设备后也可查询或替换本批文件。此浏览器会记住最新一次回执。</p><button className="button" onClick={saveReceipt}>保存私密回执</button><div className="button-row"><button className="button" disabled={busy || c.submissionMode === 'single'} onClick={async () => { const d = await read(receipt.receiptId, receipt.editKey || ''); if (d) onContinue(d, false, receipt.editKey || '') }}>继续补交</button><button className="button" disabled={busy || c.allowReplacement === false} onClick={async () => { const d = await read(receipt.receiptId, receipt.editKey || ''); if (d && !d.superseded) onContinue(d, true, receipt.editKey || ''); else if (d) setError('此回执已被替换，请使用最新回执') }}>替换本批文件</button></div>{error && <p className="error-text" role="alert">{error}</p>}</div>
  return <div className="receipt-manager"><button type="button" className="text-button" onClick={() => { setOpen(!open); setError(''); try { const saved = JSON.parse(localStorage.getItem(`jiyu:receipt:${uploadToken}`) || 'null'); if (saved) { setId(saved.receiptId); setKey(saved.editKey) } } catch { /* Manual recovery remains available. */ } }}>{open ? '收起回执查询' : '已经交过？查询回执 / 替换文件'}</button>{open && <div><label className="field">回执编号<input value={id} onChange={e => { setId(e.target.value); setDetail(null) }} maxLength={36} autoComplete="off" /></label><label className="field">私密凭证<input type="password" value={key} onChange={e => { setKey(e.target.value); setDetail(null) }} maxLength={100} autoComplete="off" /></label><button type="button" className="button" disabled={busy || !id || !key} onClick={() => void read(id, key)}>{busy ? '查询中…' : '查询本人回执'}</button>{detail && <div className="receipt-result"><strong>{detail.owner} · {detail.superseded ? '已被替换' : `${detail.files.length} 份有效文件`}</strong>{detail.files.map(f => <p key={f.id}>{f.name} · {formatSize(f.size)}</p>)}<button type="button" className="text-button" onClick={() => onOpen({ ...detail.receipt, editKey: key })}>打开并保存回执</button>{!detail.superseded && c.allowReplacement !== false && <button type="button" className="button" onClick={() => onContinue(detail, true, key)}>替换这一批文件</button>}</div>}{error && <p className="error-text" role="alert">{error}</p>}<small>只能查询持有私密凭证的回执。遗失凭证请联系发起人。</small></div>}</div>
}
