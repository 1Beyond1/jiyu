import { useEffect, useRef, useState } from 'react'
import { Download, FolderCog, Upload } from 'lucide-react'
import type { CollectionTemplate, ExportedCollectionTemplate } from '../types'
import { api } from '../lib/api'
import { downloadText } from '../lib/workspace'
import { Modal } from '../components/ui'
import { collectionPresets } from '../lib/collection-presets'
import { useAccount } from './auth'

const MAX_IMPORT_FILE_BYTES = 64 * 1024

async function exportTemplateJson(t: CollectionTemplate): Promise<void> {
  const response = await fetch(`/api/templates/${encodeURIComponent(t.id)}/export`, {
    credentials: 'same-origin',
  })
  const textContent = await response.text()
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('jiyu:session-expired'))
    let msg = '导出模板失败，请重试'
    try {
      const parsed = JSON.parse(textContent) as { error?: string }
      if (parsed.error) msg = parsed.error
    } catch {
      /* keep fallback message */
    }
    throw new Error(msg)
  }
  const parsed = JSON.parse(textContent) as ExportedCollectionTemplate
  const safeBase = t.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'jiyu-template'
  downloadText(
    `${safeBase}.jiyu-template.json`,
    `${JSON.stringify(parsed, null, 2)}\n`,
    'application/json;charset=utf-8',
  )
}

async function importTemplateFile(file: File): Promise<CollectionTemplate> {
  if (file.size === 0) throw new Error('所选模板文件为空，请选择有效的 JSON 模板文件。')
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error('模板文件超过 64 KB 上限，请确认选择的是集屿标准 JSON 模板。')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('JSON 格式无效，请检查模板文件内容。')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { schema?: unknown }).schema !== 'jiyu-template-v1'
  ) {
    throw new Error('模板格式不受支持，仅支持 jiyu-template-v1 标准 JSON 文件。')
  }
  return api<CollectionTemplate>('/api/templates/import', 'POST', parsed)
}

export function TemplatePicker({
  onSelect,
  selectedId = 'blank',
}: {
  onSelect: (t: CollectionTemplate | null) => void
  selectedId?: string
}) {
  const { canEdit } = useAccount()
  const [templates, setTemplates] = useState<CollectionTemplate[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [manage, setManage] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    void api<{ templates: CollectionTemplate[] }>('/api/templates')
      .then((s) => setTemplates(s.templates))
      .catch((e) => setError(e.message))
  }, [])
  const [selected, setSelected] = useState(selectedId)
  useEffect(() => setSelected(selectedId), [selectedId])
  const choose = (t: CollectionTemplate | null) => {
    setSelected(t?.id || 'blank')
    onSelect(t)
  }
  async function handleImport(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const created = await importTemplateFile(file)
      setTemplates((old) => [created, ...old])
      setManage(true)
      setNotice(`已导入模板「${created.name}」，可立即应用到当前收集。`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }
  async function handleExport(t: CollectionTemplate) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await exportTemplateJson(t)
      setNotice(`已导出模板「${t.name}」的 JSON 文件（已自动剔除名单、截止时间与访问密钥）。`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="template-picker">
      <div className="preset-grid">
        {collectionPresets.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={selected === t.id}
            className={`preset-card ${selected === t.id ? 'selected' : ''}`}
            onClick={() => choose(t)}
          >
            <strong>{t.name}</strong>
            <small>{t.summary}</small>
          </button>
        ))}
        <button
          className={`preset-card ${selected === 'blank' ? 'selected' : ''}`}
          type="button"
          aria-pressed={selected === 'blank'}
          onClick={() => choose(null)}
        >
          <strong>空白收集</strong>
          <small>从默认规则开始，自由设置</small>
        </button>
      </div>
      <label className="field">
        我的模板
        <select
          aria-label="选择收集模板"
          defaultValue=""
          onChange={(e) => {
            const t = templates.find((t) => t.id === e.target.value)
            if (t) choose(t)
            e.target.value = ''
          }}
        >
          <option value="">选择模板（选填）</option>
          {templates
            .filter((t) => !t.archived)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
        <small>在任务详情中可将规则保存为模板，也支持标准 JSON 跨工作台导入导出。</small>
      </label>
      <div className="template-toolbar">
        {!!templates.length && (
          <button className="text-button" type="button" onClick={() => setManage(!manage)}>
            {manage ? '收起模板管理' : `管理模板（${templates.length}）`}
          </button>
        )}
        {canEdit && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label="选择要导入的 JSON 模板文件"
              onChange={(e) => void handleImport(e.target.files?.[0])}
            />
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} />
              导入 JSON 模板
            </button>
          </>
        )}
      </div>
      {manage && (
        <div className="template-list">
          {templates.map((t) => (
            <div key={t.id}>
              <span>
                {t.name}
                {t.archived ? ' · 已归档' : ''}
              </span>
              <div className="template-row-actions">
                {!t.archived && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    onClick={() => choose(t)}
                  >
                    应用
                  </button>
                )}
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleExport(t)}
                >
                  <Download size={13} />
                  导出 JSON 模板
                </button>
                {canEdit && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setError('')
                      setNotice('')
                      try {
                        const next = await api<CollectionTemplate>(
                          `/api/templates/${t.id}`,
                          'PATCH',
                          {
                            archived: !t.archived,
                          },
                        )
                        setTemplates((old) => old.map((v) => (v.id === t.id ? next : v)))
                      } catch (e) {
                        setError((e as Error).message)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    {t.archived ? '恢复' : '归档'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {notice && (
        <p className="success-text" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function TemplateManagerModal({ onClose }: { onClose: () => void }) {
  const { canEdit } = useAccount()
  const [templates, setTemplates] = useState<CollectionTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void api<{ templates: CollectionTemplate[] }>('/api/templates')
      .then((s) => {
        setTemplates(s.templates)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [])

  async function handleImport(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const created = await importTemplateFile(file)
      setTemplates((old) => [created, ...old])
      setNotice(`已成功导入模板「${created.name}」，新建收集时即可直接选用。`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleExport(t: CollectionTemplate) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await exportTemplateJson(t)
      setNotice(`已导出「${t.name}」为标准 jiyu-template-v1 JSON 文件。`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="收集模板管理"
      subtitle="标准 jiyu-template-v1 JSON 导入导出自动剥离名单、截止日期、提取码与存储凭证。"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="template-manager-head">
        <span className="muted">
          <FolderCog size={14} /> 共 {templates.length} / 50 个模板
        </span>
        {canEdit && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label="选择要导入的 JSON 模板文件"
              onChange={(e) => void handleImport(e.target.files?.[0])}
            />
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} />
              导入 JSON 模板
            </button>
          </>
        )}
      </div>
      {notice && (
        <p className="success-text" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted" role="status">
          正在读取模板列表…
        </p>
      ) : templates.length ? (
        <div className="template-list">
          {templates.map((t) => (
            <div key={t.id}>
              <div>
                <strong>
                  {t.name}
                  {t.archived ? ' · 已归档' : ''}
                </strong>
                <small className="template-meta-line">
                  {t.rules.formats || '默认格式'}
                  {t.rules.materials?.length ? ` · ${t.rules.materials.length} 项材料` : ''}
                  {t.rules.deadlineReminder?.enabled
                    ? ` · 提前 ${t.rules.deadlineReminder.hoursBefore}h 预警`
                    : ''}
                </small>
              </div>
              <div className="template-row-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void handleExport(t)}
                >
                  <Download size={13} />
                  导出 JSON 模板
                </button>
                {canEdit && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      setError('')
                      setNotice('')
                      try {
                        const next = await api<CollectionTemplate>(
                          `/api/templates/${t.id}`,
                          'PATCH',
                          { archived: !t.archived },
                        )
                        setTemplates((old) => old.map((v) => (v.id === t.id ? next : v)))
                        setNotice(`已${next.archived ? '归档' : '恢复'}模板「${next.name}」`)
                      } catch (e) {
                        setError((e as Error).message)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    {t.archived ? '恢复' : '归档'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="form-note">
          尚未保存任何自定义模板。你可以在收集任务详情页点击「保存为模板」，或直接点击上方「导入
          JSON 模板」导入他人分享的标准模板。
        </div>
      )}
      <footer className="modal-footer">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          关闭
        </button>
      </footer>
    </Modal>
  )
}

export function SaveTemplate({
  collectionId,
  title,
  onClose,
}: {
  collectionId: string
  title: string
  onClose: () => void
}) {
  const [name, setName] = useState(title.slice(0, 40)),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [savedTemplate, setSavedTemplate] = useState<CollectionTemplate | null>(null)
  return (
    <Modal
      title={savedTemplate ? '模板已保存' : '保存为收集模板'}
      subtitle="以后创建同类收集，可以直接复用这些规则。"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          setNotice('')
          try {
            const created = await api<CollectionTemplate>('/api/templates', 'POST', {
              collectionId,
              name,
            })
            setSavedTemplate(created)
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {savedTemplate ? (
          <p className="success-text" role="status">
            新建收集时选择「{savedTemplate.name}」即可使用。
          </p>
        ) : (
          <label className="field">
            模板名称
            <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <div className="form-note">
          复制字段、命名、材料清单、定时预警和提交规则。名单、截止日期、提取码、分享链接和存储连接将在新任务单独设置。
        </div>
        {notice && (
          <p className="success-text" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-footer">
          {savedTemplate && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await exportTemplateJson(savedTemplate)
                  setNotice(`已导出模板「${savedTemplate.name}」的标准 JSON 文件。`)
                } catch (e) {
                  setError((e as Error).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Download size={14} />
              导出 JSON 模板
            </button>
          )}
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {savedTemplate ? '完成' : '取消'}
          </button>
          {!savedTemplate && (
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? '保存中…' : '保存模板'}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  )
}
