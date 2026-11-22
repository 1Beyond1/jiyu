import { useState } from 'react'
import { submissionFileName } from '../lib/submission-naming'
import { safeRandomUUID } from '../lib/browser-crypto'
import type { Collection, CollectionInput } from '../types'
import { MaterialRulesEditor } from './material-rules'

export function CollectionRules({
  value,
  onChange,
  locked,
  section = 'all',
  title = '示例收集',
  received = 0,
}: {
  value: Partial<CollectionInput>
  onChange: (v: Partial<CollectionInput>) => void
  locked: boolean
  section?: 'all' | 'submission' | 'naming'
  title?: string
  received?: number
}) {
  const fields = value.fields || [],
    naming = value.naming || { parts: [], separator: '_' as const }
  const update = (v: Partial<CollectionInput>) => onChange({ ...value, ...v })
  const rosterCount = (value.expectedSubmitters || []).filter((v) => v.trim()).length
  const labels: Record<string, string> = {
    owner: '姓名',
    collection: '任务名称',
    date: '提交日期',
    sequence: '累计序号',
    original: '原文件名',
    ...Object.fromEntries(fields.map((f) => [f.id, f.label])),
  }
  return (
    <div className="collection-rules-editor">
      {section !== 'naming' && (
        <>
          <div className="rule-heading">
            <h3>提交信息</h3>
            <small>姓名始终必填 · 最多 8 个自定义字段</small>
          </div>
          {fields.map((f, i) => (
            <div className="custom-field-row" key={f.id}>
              <label className="field">
                字段 {i + 1}
                <input
                  aria-label={`字段 ${i + 1} 名称`}
                  value={f.label}
                  maxLength={20}
                  required
                  onChange={(e) =>
                    update({
                      fields: fields.map((v) =>
                        v.id === f.id ? { ...v, label: e.target.value } : v,
                      ),
                    })
                  }
                  placeholder="例如：班级、学号"
                />
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={f.required}
                  disabled={value.identityField === f.id}
                  onChange={(e) =>
                    update({
                      fields: fields.map((v) =>
                        v.id === f.id ? { ...v, required: e.target.checked } : v,
                      ),
                    })
                  }
                />
                必填
              </label>
              <button
                className="text-button"
                type="button"
                disabled={locked && value.identityField === f.id}
                onClick={() =>
                  update({
                    fields: fields.filter((v) => v.id !== f.id),
                    identityField: value.identityField === f.id ? 'owner' : value.identityField,
                    naming: { ...naming, parts: naming.parts.filter((p) => p !== f.id) },
                  })
                }
              >
                移除
              </button>
            </div>
          ))}
          <button
            className="button"
            type="button"
            disabled={fields.length >= 8}
            onClick={() =>
              update({
                fields: [
                  ...fields,
                  { id: `field_${safeRandomUUID().slice(0, 8)}`, label: '', required: true },
                ],
              })
            }
          >
            添加提交字段
          </button>
          <div className="form-row">
            <label className="field">
              按什么识别提交人
              <select
                disabled={locked}
                value={value.identityField || 'owner'}
                onChange={(e) => update({ identityField: e.target.value })}
              >
                <option value="owner">姓名</option>
                {fields
                  .filter((f) => f.required)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label || '未命名字段'}
                    </option>
                  ))}
              </select>
              <small>
                {locked ? '已有提交，标识字段已锁定。' : '同名较多时，建议选择学号或项目编号。'}
              </small>
            </label>
            <label className="field">
              同一标识重复提交
              <select
                value={value.submissionMode || 'append'}
                onChange={(e) =>
                  update({ submissionMode: e.target.value as Collection['submissionMode'] })
                }
              >
                <option value="append">允许补交，合并统计</option>
                <option value="single">仅一次，后续凭回执替换</option>
              </select>
            </label>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={value.allowReplacement !== false}
              onChange={(e) => update({ allowReplacement: e.target.checked })}
            />
            允许提交者凭本人回执替换文件
          </label>
          <label className="field">
            应交名单（选填）
            <textarea
              rows={3}
              value={(value.expectedSubmitters || []).join('\n')}
              onChange={(e) => {
                const lines = e.target.value.split('\n')
                const hasAny = lines.some((v) => v.trim())
                update({
                  expectedSubmitters: lines,
                  ...(!hasAny ? { restrictToExpectedSubmitters: false } : {}),
                })
              }}
              placeholder="每行一个姓名或所选标识，例如学号"
            />
            <small>
              仅工作台成员可见；按上面选择的标识对照，最多 1000
              人。默认仅用于对照统计，勾选下方开关可限制提交准入。
            </small>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={Boolean(value.restrictToExpectedSubmitters)}
              disabled={!rosterCount}
              onChange={(e) => update({ restrictToExpectedSubmitters: e.target.checked })}
            />
            仅允许应交名单内标识提交（名单外返回通用提示，不泄露名单内容）
          </label>
          <div className="access-code-rule">
            <div className="rule-heading">
              <h3>访问提取码（选填）</h3>
              <small>
                {value.hasAccessCode
                  ? value.clearAccessCode
                    ? '保存后将关闭提取码保护'
                    : '已启用 · 验证提取码前不展示任务详情与材料清单'
                  : '设置 4–8 位提取码，防止链接误传后被无关人员查看'}
              </small>
            </div>
            <label className="field">
              {value.hasAccessCode ? '更换提取码（留空保持原提取码不变）' : '设置 4–8 位提取码'}
              <input
                value={value.accessCode || ''}
                disabled={Boolean(value.clearAccessCode)}
                maxLength={8}
                placeholder="例如：2026 或 AB12cd（4–8 位非空白字符）"
                onChange={(e) => update({ accessCode: e.target.value })}
              />
              <small>
                服务端仅保存加盐 scrypt 哈希，不保存明文；修改提取码会使旧解锁凭证失效。
              </small>
            </label>
            {value.hasAccessCode && (
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={Boolean(value.clearAccessCode)}
                  onChange={(e) =>
                    update({
                      clearAccessCode: e.target.checked,
                      ...(e.target.checked ? { accessCode: '' } : {}),
                    })
                  }
                />
                清除当前提取码（恢复为持链接直接访问）
              </label>
            )}
          </div>
          <MaterialRulesEditor value={value} onChange={onChange} />
        </>
      )}
      {section !== 'submission' && (
        <>
          <div className="rule-heading">
            <h3>收到后自动命名</h3>
            <small>按点击顺序组合，最多 6 段</small>
          </div>
          <div className="naming-tokens">
            {Object.entries(labels).map(([id, label]) => (
              <button
                className={`button ${naming.parts.includes(id) ? 'chosen' : ''}`}
                type="button"
                key={id}
                disabled={naming.parts.length >= 6 && !naming.parts.includes(id)}
                onClick={() =>
                  update({
                    naming: {
                      ...naming,
                      parts: naming.parts.includes(id)
                        ? naming.parts.filter((p) => p !== id)
                        : [...naming.parts, id],
                    },
                  })
                }
              >
                {naming.parts.includes(id) ? `${naming.parts.indexOf(id) + 1}. ` : '+ '}
                {label || '未命名字段'}
              </button>
            ))}
          </div>
          {!!naming.parts.length && (
            <label className="field">
              分隔符
              <select
                value={naming.separator}
                onChange={(e) =>
                  update({ naming: { ...naming, separator: e.target.value as '_' | '-' } })
                }
              >
                <option value="_">下划线 _</option>
                <option value="-">短横线 -</option>
              </select>
            </label>
          )}
          <div className="naming-example">
            <span>命名示意</span>
            <code>
              {naming.parts.length
                ? naming.parts.map((p) => labels[p] || p).join(naming.separator) + '.pdf'
                : '保留原文件名.pdf'}
            </code>
            <small>保留原扩展名与原名记录，重名自动加序号。</small>
          </div>
          <NamingPreview value={value} title={title} received={received} />
        </>
      )}
    </div>
  )
}

function NamingPreview({
  value,
  title,
  received,
}: {
  value: Partial<Collection>
  title: string
  received: number
}) {
  const [owner, setOwner] = useState('张同学'),
    [file, setFile] = useState('作业.pdf'),
    [fields, setFields] = useState<Record<string, string>>({})
  const examples = Object.fromEntries(
    (value.fields || []).map((f) => [
      f.id,
      fields[f.id] ??
        (/学号/.test(f.label)
          ? '2026001'
          : /版本/.test(f.label)
            ? 'v1'
            : /班级/.test(f.label)
              ? '一班'
              : /编号/.test(f.label)
                ? 'P001'
                : '示例内容'),
    ]),
  )
  const name = submissionFileName(
    { title, naming: value.naming },
    file || '作业.pdf',
    owner,
    examples,
    received + 1,
    new Date().toISOString(),
  )
  return (
    <section className="naming-live" aria-label="实时命名预览">
      <div className="rule-heading">
        <h3>用一份文件试试看</h3>
        <small>仅示例，不会创建文件</small>
      </div>
      <div className="form-row">
        <label className="field">
          示例姓名
          <input value={owner} maxLength={30} onChange={(e) => setOwner(e.target.value)} />
        </label>
        <label className="field">
          示例原文件名
          <input value={file} maxLength={200} onChange={(e) => setFile(e.target.value)} />
        </label>
      </div>
      {!!value.fields?.length && (
        <details>
          <summary>修改示例提交信息</summary>
          <div className="preview-fields">
            {value.fields.map((f) => (
              <label className="field" key={f.id}>
                {f.label || '未命名字段'}（示例）
                <input
                  value={examples[f.id]}
                  maxLength={80}
                  onChange={(e) => setFields((old) => ({ ...old, [f.id]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        </details>
      )}
      <output className="naming-output" aria-label="预览文件名" aria-live="polite">
        {name}
      </output>
      <small>实际日期、累计序号与重名后缀以提交成功时为准。</small>
    </section>
  )
}
