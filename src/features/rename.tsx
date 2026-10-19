import { useState } from 'react'
import { ArrowRight, Check, Info, WandSparkles } from 'lucide-react'
import { FileIcon, Modal } from '../components/ui'
import type { CollectedFile, Collection } from '../types'

export function getRenames(files: CollectedFile[], collections: Collection[], pattern: string) {
  return files.map((file, index) => {
    const dot = file.name.lastIndexOf('.')
    const extension = dot > 0 ? file.name.slice(dot) : ''
    const base = dot > 0 ? file.name.slice(0, dot) : file.name
    const title = collections.find(c => c.id === file.collectionId)?.title || '未分类'
    const name = pattern.replaceAll('{任务}', title).replaceAll('{提交人}', file.owner).replaceAll('{序号}', String(index + 1).padStart(2, '0')).replaceAll('{原名}', base).replaceAll('{日期}', file.createdAt.slice(0, 10).replaceAll('-', '')).trim() + extension
    return { id: file.id, oldName: file.name, name }
  })
}

export function RenameModal({ files, allFiles, collections, onClose, onApply }: { files: CollectedFile[]; allFiles: CollectedFile[]; collections: Collection[]; onClose: () => void; onApply: (changes: { id: string; name: string }[]) => void }) {
  const [pattern, setPattern] = useState('{任务}_{提交人}_{序号}')
  const changes = getRenames(files, collections, pattern)
  const names = changes.map(c => c.name.toLowerCase())
  const unchanged = allFiles.filter(f => !files.some(chosen => chosen.id === f.id)).map(f => f.name.toLowerCase())
  const invalid = !pattern.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(pattern) || /[{}]/.test(pattern.replace(/\{(任务|提交人|序号|原名|日期)\}/g, '')) || changes.some(c => c.name.length > 200 || !c.name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(c.name))
  const duplicate = new Set(names).size !== names.length || names.some(name => unchanged.includes(name))
  return <Modal title="给文件，一个整齐的名字" subtitle={`批量重命名 · 已选择 ${files.length} 个文件`} onClose={onClose} wide>
    <label className="field">命名规则<input autoFocus value={pattern} onChange={e => setPattern(e.target.value)} aria-label="命名规则" /></label>
    <div className="token-list">{['{任务}', '{提交人}', '{序号}', '{原名}', '{日期}'].map(token => <button key={token} onClick={() => setPattern(pattern + token)}>{token}</button>)}<span>点击插入变量 · 自动保留扩展名</span></div>
    <div className="rename-preview"><div className="rename-labels"><span>原文件名</span><span>重命名后</span></div>{changes.map(c => <div className="rename-row" key={c.id}><span><FileIcon name={c.oldName} />{c.oldName}</span><ArrowRight size={15} /><strong>{c.name}</strong></div>)}</div>
    {invalid ? <p className="error-text" role="alert">请输入有效规则，仅支持上面的变量，且不能包含路径或特殊符号。</p> : duplicate ? <p className="error-text" role="alert">发现重名文件，请加入「序号」或调整规则。</p> : <p className="success-text"><Check size={15} />命名检查通过，没有重名文件</p>}
    <div className="form-note"><Info size={15} />预览确认后才会应用。当前仅修改演示文件记录。</div>
    <footer className="modal-footer"><button className="button" onClick={onClose}>取消</button><button className="button primary" disabled={invalid || duplicate || !files.length} onClick={() => onApply(changes)}><WandSparkles size={15} />应用到 {files.length} 个文件</button></footer>
  </Modal>
}
