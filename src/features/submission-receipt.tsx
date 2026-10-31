import { isExpired } from '../lib/collections'
import { useEffect, useRef, useState } from 'react'
import type { Collection, ReceiptDetail, UploadReceipt } from '../types'
import { formatSize } from '../lib/workspace'
import { materialStateLabels } from '../lib/materials'
import { parseReceiptFile } from '../lib/receipt-file'

export function ReceiptManager({ c, uploadToken, receipt, onOpen, onContinue }: { c: Collection; uploadToken: string; receipt: UploadReceipt | null; onOpen: (r: UploadReceipt) => void; onContinue: (detail: ReceiptDetail, replacement: boolean, key: string) => void }) {
  const [open, setOpen] = useState(false), [id, setId] = useState(''), [key, setKey] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [detail, setDetail] = useState<ReceiptDetail | null>(null)
  const closed = c.status !== 'active' || isExpired(c)
  const picker = useRef<HTMLInputElement>(null)
  const readSequence = useRef(0), readController = useRef<AbortController | null>(null), reading = useRef(false)
  useEffect(() => {
    const update = () => { if (receipt?.editKey && !reading.current && document.visibilityState === 'visible') void read(receipt.receiptId, receipt.editKey) }
    update()
    const timer = window.setInterval(update, 15000)
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update)
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); readSequence.current++; readController.current?.abort(); reading.current = false }
  }, [uploadToken, receipt?.receiptId, receipt?.editKey])
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
    const ticket = ++readSequence.current
    readController.current?.abort()
    const controller = new AbortController(); readController.current = controller; reading.current = true
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/public/${encodeURIComponent(uploadToken)}/receipts/${encodeURIComponent(receiptId)}`, { signal: controller.signal, credentials: 'same-origin', headers: { 'X-Receipt-Key': secret } })
      const data = await res.json(); if (!res.ok) throw new Error(data.error || '暂时无法读取回执')
      if (ticket !== readSequence.current || controller.signal.aborted) return null
      setDetail(data); setId(receiptId); setKey(secret); return data as ReceiptDetail
    } catch (e) { if (ticket === readSequence.current && !controller.signal.aborted) { setDetail(null); setError((e as Error).message) } return null } finally { if (ticket === readSequence.current) { reading.current = false; setBusy(false) } }
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
  const needsChanges = detail?.files.some(f => f.materialState === 'needs_changes') || false
  function progress(value: ReceiptDetail) {
    return <section className="receipt-progress" aria-label="本批材料核对进度">
      {value.superseded ? <p className="form-note">这批文件已经被替换。请使用替换成功后保存的新回执查看当前文件。</p> : <><p className="field-hint">只显示你这一批的文件，不代表全部材料已收齐或人工通过。</p>{value.files.some(f => f.materialState === 'needs_changes') && <div className="receipt-needs-change"><strong>有材料需要补充</strong><p>按下方具体说明修改，再选择“按说明替换本批文件”。请重新选择本批完整文件。</p></div>}</>}
      <strong>{value.owner} · {value.superseded ? '已被替换' : `${value.files.length} 份有效文件`}</strong>
      {value.files.map(f => <div className={`receipt-material-file ${f.materialState || ''}`} key={f.id}><p>{f.name} · {formatSize(f.size)}</p>{!!c.materials?.length && <><span className={`mstate ${f.materialState || 'unclassified'}`}>{c.materials.find(m => m.id === f.materialId)?.name || '未分类'} · {materialStateLabels[f.materialState || 'unclassified']}</span>{f.materialNote && <p className="receipt-material-note">{f.materialState === 'stale' ? '旧核对说明（已过期）：' : '核对说明：'}{f.materialNote}</p>}</>}</div>)}
    </section>
  }
  function nextActions(receiptId: string, secret: string, superseded = false) {
    return <><div className={`receipt-next-actions ${needsChanges ? 'has-needs-changes' : ''}`}><div><button type="button" className="button" disabled={busy || closed || superseded || c.submissionMode === 'single'} onClick={() => void continueFrom(receiptId, secret, false)}>继续补交</button><p>新增一批文件，原来提交的文件继续保留。</p></div><div className="receipt-replace-action"><button type="button" className={`button ${needsChanges ? 'primary' : ''}`} disabled={busy || closed || superseded || c.allowReplacement === false} onClick={() => void continueFrom(receiptId, secret, true)}>{needsChanges ? '按说明替换本批文件' : '替换本批文件'}</button><p>请重新选择本批完整文件。成功后原批次进入回收站，其他补交批次保持保留。</p></div></div>{closed ? <p className="field-hint">收集已关闭，当前仅可查询和保存回执。</p> : superseded ? <p className="field-hint">此回执已被替换，请使用最新回执继续操作。</p> : <>{c.submissionMode === 'single' && <p className="field-hint">此任务仅允许提交一次，不能补交。</p>}{c.allowReplacement === false && <p className="field-hint">发起人未开放文件替换。</p>}</>}</>
  }
  if (receipt) {
    const current = detail?.receipt.receiptId === receipt.receiptId ? detail : null
    return <div className="receipt-actions"><p className="field-hint">请保存私密回执，换设备后也能查看补充原因或替换文件。这个浏览器会记住最新回执。</p><button className="button primary receipt-save" onClick={saveReceipt}>保存私密回执</button><div className="receipt-progress-heading"><h2>本批材料核对进度</h2><button type="button" className="text-button" disabled={busy} onClick={() => void read(receipt.receiptId, receipt.editKey || '')}>{busy ? '更新中…' : '更新核对进度'}</button></div>{current ? progress(current) : <p className="field-hint" role="status">{busy ? '正在读取你的材料进度…' : '暂未读到核对进度，可点上方更新。'}</p>}<small className="field-hint">返回此页会自动更新，也可手动刷新。只有发起人明确核对后才显示通过。</small>{nextActions(receipt.receiptId, receipt.editKey || '', !!current?.superseded)}{error && <p className="error-text" role="alert">{error} 请保留回执并重试更新。</p>}</div>
  }
  return <div className="receipt-manager"><button type="button" className="text-button" onClick={() => { setOpen(!open); setError(''); try { const saved = JSON.parse(localStorage.getItem(`jiyu:receipt:${uploadToken}`) || 'null'); if (saved && typeof saved.receiptId === 'string' && typeof saved.editKey === 'string') { setId(saved.receiptId); setKey(saved.editKey); if (!open) void read(saved.receiptId, saved.editKey) } } catch { /* Manual recovery remains available. */ } }}>{open ? '收起回执查询' : '已经交过？查询回执 / 替换文件'}</button>{open && <div><div className="receipt-import"><input ref={picker} type="file" accept=".txt,text/plain" className="sr-only" aria-label="选择私密回执文件" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void importReceipt(file) }} /><button type="button" className="button" disabled={busy} onClick={() => picker.current?.click()}>{busy ? '正在核验…' : '导入私密回执文件'}</button><p>选择之前保存的 .txt 回执，自动查询本人记录；也可在下方手动填写。</p></div><label className="field">回执编号<input value={id} disabled={busy} onChange={e => { setId(e.target.value); setDetail(null) }} maxLength={36} autoComplete="off" /></label><label className="field">私密凭证<input type="password" value={key} disabled={busy} onChange={e => { setKey(e.target.value); setDetail(null) }} maxLength={100} autoComplete="off" /></label><button type="button" className="button" disabled={busy || !id || !key} onClick={() => void read(id, key)}>{busy ? '查询中…' : '查询本人回执'}</button>{detail && <div className="receipt-result">{progress(detail)}<button type="button" className="text-button" onClick={() => onOpen({ ...detail.receipt, editKey: key })}>打开并保存回执</button>{nextActions(detail.receipt.receiptId, key, detail.superseded)}</div>}{error && <p className="error-text" role="alert">{error}</p>}<small>只能查询持有私密凭证的回执。遗失凭证请联系发起人。</small></div>}</div>
}
