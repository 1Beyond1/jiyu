import { useMemo, useState } from 'react'
import { Check, Copy, MessageSquareText, Users } from 'lucide-react'
import { Modal } from '../components/ui'
import { buildDirectReminder, buildGroupReminder } from '../lib/reminder'
import type { Collection, MaterialParticipant, Participant } from '../types'

interface ReminderModalProps {
  collection: Collection
  initialMode?: 'group' | 'direct'
  initialPersonId?: string
  materialParticipants?: MaterialParticipant[]
  participants?: Participant[]
  onClose: () => void
}

function readCachedPasscode(collectionId: string): string {
  try {
    return sessionStorage.getItem(`jiyu:passcode:${collectionId}`) || ''
  } catch {
    return ''
  }
}

export function ReminderModal({
  collection,
  initialMode = 'group',
  initialPersonId = '',
  materialParticipants,
  participants,
  onClose,
}: ReminderModalProps) {
  const [mode, setMode] = useState<'group' | 'direct'>(initialMode)
  const [maskNames, setMaskNames] = useState(true)
  const [passcode, setPasscode] = useState(() => readCachedPasscode(collection.id))
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')

  const targets = useMemo(() => {
    if (materialParticipants) {
      const priority = (p: MaterialParticipant) =>
        p.status === 'needs_changes'
          ? 0
          : p.status === 'missing'
            ? 1
            : p.status === 'unclassified'
              ? 2
              : p.status === 'pending'
                ? 3
                : 4
      return [...materialParticipants]
        .sort((a, b) => priority(a) - priority(b))
        .map((p) => ({
          id: p.identity,
          label: `${p.identity}${p.owner && p.owner !== p.identity ? ` · ${p.owner}` : ''}（${
            p.status === 'needs_changes'
              ? '需补充'
              : p.status === 'missing'
                ? '缺项'
                : p.status === 'unclassified'
                  ? '待归属'
                  : p.reviewComplete
                    ? '已通过'
                    : '待核对'
          }）`,
        }))
    }
    const list = participants || []
    return [...list]
      .sort((a, b) => Number(a.fileIds.length > 0) - Number(b.fileIds.length > 0))
      .map((p) => ({
        id: p.identity,
        label: `${p.identity}${p.owner && p.owner !== p.identity ? ` · ${p.owner}` : ''}（${
          !p.fileIds.length ? '未提交' : p.duplicates ? '含重复内容' : '已提交'
        }）`,
      }))
  }, [materialParticipants, participants])

  const [selectedId, setSelectedId] = useState(() => initialPersonId || targets[0]?.id || '')
  const effectiveSelectedId = targets.some((t) => t.id === selectedId)
    ? selectedId
    : targets[0]?.id || ''

  const url = `${location.origin}/#/submit/${collection.uploadToken || ''}`

  const groupResult = useMemo(
    () =>
      buildGroupReminder({
        collection,
        url,
        maskNames,
        passcode,
        materialParticipants,
        participants,
      }),
    [collection, url, maskNames, passcode, materialParticipants, participants],
  )

  const directText = useMemo(() => {
    const mp = materialParticipants?.find((p) => p.identity === effectiveSelectedId)
    const sp = participants?.find((p) => p.identity === effectiveSelectedId)
    return buildDirectReminder({
      collection,
      url,
      passcode,
      materialParticipant: mp,
      participant: sp,
    })
  }, [collection, url, passcode, materialParticipants, participants, effectiveSelectedId])

  const generatedText = mode === 'group' ? groupResult.text : directText
  const [customDraft, setCustomDraft] = useState<{ base: string; value: string } | null>(null)
  const textValue = customDraft?.base === generatedText ? customDraft.value : generatedText

  async function copyText() {
    try {
      await navigator.clipboard.writeText(textValue)
      setCopied(true)
      setCopyError('')
    } catch {
      setCopied(false)
      setCopyError('无法自动复制，请手动全选下方文本复制。')
    }
  }

  return (
    <Modal
      title="一键催交话术"
      subtitle={`${collection.title} · 本地生成，零外发`}
      onClose={onClose}
      wide
    >
      <div className="tabs reminder-tabs">
        <button
          type="button"
          className={mode === 'group' ? 'active' : ''}
          onClick={() => {
            setMode('group')
            setCopied(false)
          }}
        >
          <Users size={14} />
          群公告汇总
        </button>
        <button
          type="button"
          className={mode === 'direct' ? 'active' : ''}
          disabled={!targets.length}
          onClick={() => {
            setMode('direct')
            setCopied(false)
          }}
        >
          <MessageSquareText size={14} />
          单人私聊
        </button>
      </div>

      {mode === 'group' ? (
        <div className="reminder-controls">
          <label className="check-field">
            <input
              type="checkbox"
              checked={maskNames}
              onChange={(e) => {
                setMaskNames(e.target.checked)
                setCopied(false)
              }}
            />
            对姓名与标识脱敏处理（推荐用于大群公告，避免直接暴露完整信息）
          </label>
          <p className="field-hint">
            待提醒 {groupResult.pendingCount} 人
            {groupResult.missingCount ? ` · 未交/缺项 ${groupResult.missingCount} 人` : ''}
            {groupResult.needsChangesCount
              ? ` · 退回需补充 ${groupResult.needsChangesCount} 人`
              : ''}
          </p>
        </div>
      ) : (
        <label className="field">
          选择提醒对象
          <select
            value={effectiveSelectedId}
            onChange={(e) => {
              setSelectedId(e.target.value)
              setCopied(false)
            }}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <small>自动带入精确缺项、核对退回说明（materialReview.note）与回执替换指引。</small>
        </label>
      )}

      {collection.hasAccessCode && (
        <label className="field">
          附带提取码（选填，仅本地写入话术）
          <input
            value={passcode}
            maxLength={8}
            placeholder="填写 4–8 位提取码以自动拼入话术"
            onChange={(e) => {
              setPasscode(e.target.value)
              setCopied(false)
            }}
          />
        </label>
      )}

      <label className="field">
        话术内容（复制前可自由微调）
        <textarea
          className="reminder-textarea"
          rows={9}
          value={textValue}
          onChange={(e) => {
            setCustomDraft({ base: generatedText, value: e.target.value })
            setCopied(false)
          }}
        />
      </label>

      {copied && (
        <p className="success-text" role="status">
          催交话术已复制到剪贴板，可直接粘贴发送。
        </p>
      )}
      {copyError && (
        <p className="error-text" role="alert">
          {copyError}
        </p>
      )}
      <div className="form-note">
        集屿不会连接任何外部聊天平台或自动发送消息；全部催交文本均在当前浏览器本地生成。
      </div>
      <footer className="modal-footer">
        <button type="button" className="button" onClick={onClose}>
          关闭
        </button>
        <button type="button" className="button primary" onClick={() => void copyText()}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? '已复制话术' : mode === 'group' ? '复制群公告话术' : '复制单人私聊话术'}
        </button>
      </footer>
    </Modal>
  )
}
