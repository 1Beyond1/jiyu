import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { Modal } from '../components/ui'
import type { Collection, CollectionTemplate, StorageProfile } from '../types'
import { storageNames } from '../types'
import { api } from '../lib/api'
import { defaultCollectionLimits, fileExtensions, localDate, nextWeek } from '../lib/collections'
import { CollectionRules } from './collection-rules'
import { TemplatePicker } from './collection-templates'

export function CollectionForm({ collection, initialStorage = 'local', onClose, onSave, busy = false, serverError }: { collection?: Collection; initialStorage?: Collection['storage']; onClose: () => void; onSave: (c: Collection) => void; busy?: boolean; serverError?: string }) {
  const [title, setTitle] = useState(collection?.title || '')
  const [description, setDescription] = useState(collection?.description || '')
  const [target, setTarget] = useState(collection?.target || 20)
  const [deadline, setDeadline] = useState(collection?.deadline || nextWeek())
  const [category, setCategory] = useState<Collection['category']>(collection?.category || 'document')
  const [formats, setFormats] = useState(collection?.formats || 'PDF, DOCX, XLSX, ZIP')
  const [maxFileSizeMB, setMaxFileSizeMB] = useState(collection?.maxFileSizeMB || defaultCollectionLimits.maxFileSizeMB)
  const [maxFilesPerSubmission, setMaxFilesPerSubmission] = useState(collection?.maxFilesPerSubmission || defaultCollectionLimits.maxFilesPerSubmission)
  const [maxTotalSizeMB, setMaxTotalSizeMB] = useState(collection?.maxTotalSizeMB || 2048)
  const [rules, setRules] = useState<Partial<Collection>>(collection || {})
  const [templateName, setTemplateName] = useState(''), [error, setError] = useState(''), [step, setStep] = useState(0)
  const [templateId, setTemplateId] = useState('blank')
  const [storage, setStorage] = useState<Collection['storage']>(collection?.storage || initialStorage), [connections, setConnections] = useState<StorageProfile[]>([])
  const [storageError, setStorageError] = useState('')
  const form = useRef<HTMLFormElement>(null), stepHeading = useRef<HTMLHeadingElement>(null)
  const steps = ['基本信息', '提交规则', '命名与确认']
  useEffect(() => { void api<{ profiles: StorageProfile[] }>('/api/storage/connections').then(s => { setConnections(s.profiles.filter(p => p.enabled)); setStorageError('') }).catch(() => setStorageError('暂时无法读取云端连接，可继续选择本机，或关闭后重试。')) }, [])
  useEffect(() => { stepHeading.current?.focus(); stepHeading.current?.scrollIntoView({ block: 'nearest' }) }, [step])
  function applyTemplate(t: CollectionTemplate | null) {
    const r = t?.rules || {}
    setTemplateId(t?.id || 'blank'); setTemplateName(t?.name || ''); setTitle(r.title || ''); setDescription(r.description || '')
    setCategory(r.category || 'document'); setTarget(r.target || 20); setFormats(r.formats || 'PDF, DOCX, XLSX, ZIP')
    setMaxFileSizeMB(r.maxFileSizeMB || 100); setMaxFilesPerSubmission(r.maxFilesPerSubmission || 20); setMaxTotalSizeMB(r.maxTotalSizeMB || 2048)
    setRules({ ...r, expectedSubmitters: [] }); setError('')
  }
  function validate() {
    const invalid = form.current?.querySelector<HTMLInputElement>('input:invalid, select:invalid, textarea:invalid')
    if (invalid) { const details = invalid.closest('details'); if (details) details.open = true; setError('请检查当前步骤中标记的输入内容。'); invalid.reportValidity(); invalid.focus(); return false }
    if (step === 1) {
      const extensions = fileExtensions(formats)
      if (!extensions.length || extensions.length > 20 || extensions.some(ext => !/^[a-z0-9]{1,12}$/.test(ext))) { setError('请填写有效后缀，例如 PDF, JPG, ZIP，最多 20 种。'); return false }
      const fields = rules.fields || [], roster = (rules.expectedSubmitters || []).map(v => v.trim()).filter(Boolean)
      if (fields.some(f => !f.label.trim())) { setError('请为每个提交字段填写名称。'); return false }
      if (new Set(fields.map(f => f.label.trim())).size !== fields.length) { setError('提交字段名称不能重复。'); return false }
      if (roster.length > 1000 || new Set(roster.map(v => v.normalize('NFKC').toLowerCase())).size !== roster.length) { setError('名单最多 1000 人，请移除重复标识。'); return false }
    }
    setError(''); return true
  }
  return <Modal title={collection ? '编辑收集规则' : '发起一项新收集'} subtitle={collection ? '原分享链接保持有效，已有文件会保留。' : '选好规则，再用一个链接收齐文件。'} onClose={() => { if (!busy) onClose() }}>
    <ol className="collection-steps" aria-label="收集设置步骤">{steps.map((label, i) => <li key={label} aria-current={step === i ? 'step' : undefined}><span>{i + 1}</span>{label}</li>)}</ol>
    <h3 ref={stepHeading} className="wizard-heading" tabIndex={-1}>{steps[step]}</h3>
    <form ref={form} noValidate onSubmit={e => {
      e.preventDefault(); if (busy || !validate()) return
      if (step < 2) { setStep(step + 1); return }
      onSave({ ...rules, expectedSubmitters: (rules.expectedSubmitters || []).map(v => v.trim()).filter(Boolean), id: collection?.id || crypto.randomUUID(), title: title.trim(), description: description.trim() || '期待每一份认真准备的文件', target, deadline, category, formats: fileExtensions(formats).join(', ').toUpperCase(), received: collection?.received || 0, storage, status: collection?.status || 'active', maxFileSizeMB, maxFilesPerSubmission, maxTotalSizeMB })
    }}>
      <fieldset disabled={busy}>
      {step === 0 && <>
        {!collection && <TemplatePicker onSelect={applyTemplate} selectedId={templateId} />}
        {templateName && <p className="success-text" role="status">已应用「{templateName}」，规则可继续调整。</p>}
        <label className="field">收集名称<input required maxLength={50} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：十月作业收集" /></label>
        <label className="field">收集说明<textarea maxLength={150} value={description} onChange={e => setDescription(e.target.value)} placeholder="说明需要什么、如何准备…" rows={2} /></label>
        <div className="form-row"><label className="field">预计收集份数<input type="number" min={1} max={10000} required value={target} onChange={e => setTarget(Number(e.target.value))} /><small>仅作文件份数的进度参考。</small></label><label className="field">截止日期<input type="date" required min={!collection || collection.status === 'active' ? localDate() : undefined} value={deadline} onChange={e => setDeadline(e.target.value)} /><small>当天 23:59（UTC+8）。</small></label></div>
        <div className="form-row"><label className="field">收集类型<select value={category} onChange={e => setCategory(e.target.value as Collection['category'])}><option value="document">文档资料</option><option value="design">设计素材</option><option value="photo">摄影图片</option></select></label><label className="field">存储位置<select value={storage} onChange={e => setStorage(e.target.value as Collection['storage'])}><option value="local">服务器本地存储</option>{connections.map(p => <option key={p.id} value={p.id}>{storageNames[p.id]} + 本机副本</option>)}{storage !== 'local' && !connections.some(p => p.id === storage) && <option value={storage}>{storageNames[storage]}（连接已停用）</option>}</select></label></div>
        {storageError && <p role="alert" className="error-text">{storageError}</p>}
      </>}
      {step === 1 && <>
        <label className="field">允许的文件格式<input required maxLength={260} value={formats} onChange={e => setFormats(e.target.value)} /><small>多个后缀用逗号分隔，例如 PDF, JPG, ZIP。</small></label>
        <details className="collection-limits"><summary>大小与数量：每个 ≤ {maxFileSizeMB} MB，每次 ≤ {maxFilesPerSubmission} 个</summary><div className="form-row"><label className="field">单文件上限（MB）<input type="number" required min={1} max={1024} value={maxFileSizeMB} onChange={e => setMaxFileSizeMB(Number(e.target.value))} /></label><label className="field">每次最多提交（个）<input type="number" required min={1} max={100} value={maxFilesPerSubmission} onChange={e => setMaxFilesPerSubmission(Number(e.target.value))} /></label></div><label className="field">任务总容量（MB）<input type="number" required min={1} max={1048576} value={maxTotalSizeMB} onChange={e => setMaxTotalSizeMB(Number(e.target.value))} /><small>回收站文件也计入容量。</small></label></details>
        <CollectionRules section="submission" value={rules} onChange={setRules} locked={!!collection?.received} />
      </>}
      {step === 2 && <>
        <CollectionRules section="naming" value={rules} onChange={setRules} locked={!!collection?.received} title={title} received={collection?.received || 0} />
        <dl className="collection-confirm"><div><dt>收集</dt><dd>{title} · {deadline} 截止</dd></div><div><dt>提交</dt><dd>{formats} · 单文件 ≤ {maxFileSizeMB} MB · 每次 {maxFilesPerSubmission} 个</dd></div><div><dt>提交人</dt><dd>按{rules.fields?.find(f => f.id === rules.identityField)?.label || '姓名'}识别 · {(rules.expectedSubmitters || []).filter(v => v.trim()).length} 人应交名单</dd></div><div><dt>存储</dt><dd>{storageNames[storage]}{storage !== 'local' && ' + 本机副本'}</dd></div></dl>
        <p className="field-hint">规则影响后续提交；已有文件保持原名。创建后可预览提交页再分享。</p>
      </>}
      </fieldset>
      {(error || serverError) && <p className="error-text" role="alert">{error || serverError} {serverError && '可返回前两步调整规则后重试。'}</p>}
      <footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={step ? () => { setError(''); setStep(step - 1) } : onClose}>{step ? '上一步' : '取消'}</button><button className="button primary" disabled={busy} type="submit">{step === 2 && <Check size={16} />}{busy ? '正在保存…' : step < 2 ? '下一步' : collection ? '保存修改' : '创建收集'}</button></footer>
    </form>
  </Modal>
}
