import type { Collection, MaterialParticipant, Participant } from '../types.ts'
import { effectiveFileLimit } from './collections.ts'

export function maskIdentifier(value: string): string {
  const chars = [...value.trim()]
  const len = chars.length
  if (len === 0) return ''
  if (len === 1) return '*'
  if (len === 2) return `${chars[0]}*`
  if (len <= 4) return `${chars[0]}${'*'.repeat(len - 2)}${chars[len - 1]}`
  if (len <= 7) return `${chars.slice(0, 2).join('')}${'*'.repeat(len - 3)}${chars[len - 1]}`
  return `${chars.slice(0, 3).join('')}***${chars.slice(-2).join('')}`
}

function formatPersonLabel(identity: string, owner: string, masked: boolean): string {
  const idLabel = masked ? maskIdentifier(identity) : identity.trim()
  const ownerTrimmed = owner.trim()
  if (!ownerTrimmed || ownerTrimmed === identity.trim()) return idLabel
  const ownerLabel = masked ? maskIdentifier(ownerTrimmed) : ownerTrimmed
  return `${idLabel}（${ownerLabel}）`
}

function passcodeNotice(collection: Collection, passcode?: string): string {
  const code = passcode?.trim()
  if (code) return `提取码：${code}`
  if (collection.hasAccessCode) return '提取码：已开启提取码保护（请随通知附上提取码）'
  return ''
}

export function buildShareAnnouncement(options: {
  collection: Collection
  url: string
  passcode?: string
}): string {
  const { collection: c, url, passcode } = options
  const lines: string[] = [`【文件收集】${c.title}`]
  if (c.description.trim()) lines.push(`说明：${c.description.trim()}`)
  lines.push(`截止时间：${c.deadline} 23:59（UTC+8）`)
  if (c.materials?.length) {
    const required = c.materials.filter((m) => m.required).map((m) => m.name)
    const optional = c.materials.filter((m) => !m.required).map((m) => m.name)
    if (required.length) lines.push(`必需材料：${required.join('、')}`)
    if (optional.length) lines.push(`选填材料：${optional.join('、')}`)
  }
  lines.push(
    `文件要求：${c.formats}，单文件 ≤ ${effectiveFileLimit(c)} MB，单次最多 ${c.maxFilesPerSubmission} 份`,
  )
  lines.push(`提交链接：${url}`)
  const codeLine = passcodeNotice(c, passcode)
  if (codeLine) lines.push(codeLine)
  lines.push('温馨提示：无需注册登录，提交成功后请保存好个人私密回执，用于查看核对进度或后续替换。')
  return lines.join('\n')
}

export interface GroupReminderResult {
  text: string
  pendingCount: number
  missingCount: number
  needsChangesCount: number
}

export function buildGroupReminder(options: {
  collection: Collection
  url: string
  maskNames?: boolean
  passcode?: string
  materialParticipants?: MaterialParticipant[]
  participants?: Participant[]
}): GroupReminderResult {
  const { collection: c, url, maskNames = true, passcode } = options
  const lines: string[] = [`【催交提醒】${c.title}`]
  const codeLine = passcodeNotice(c, passcode)

  if (options.materialParticipants) {
    const people = options.materialParticipants
    const missing = people.filter((p) => !p.receivedComplete)
    const needsChanges = people.filter((p) => p.status === 'needs_changes')
    const pendingSet = new Set([
      ...missing.map((p) => p.identity),
      ...needsChanges.map((p) => p.identity),
    ])
    const roster = c.expectedSubmitters?.length ? people.filter((p) => p.expected) : people
    const receivedCount = roster.filter((p) => p.receivedComplete).length

    lines.push(
      `当前进度：${roster.length} 人中已有 ${receivedCount} 人收齐必需材料；截至 ${c.deadline} 23:59（UTC+8）。`,
    )

    if (missing.length) {
      const items = missing.map((p) => {
        const missingSlots = p.slots
          .filter((s) => s.requirement.required && !s.files.length)
          .map((s) => s.requirement.name)
        const label = formatPersonLabel(p.identity, p.owner, maskNames)
        if (missingSlots.length) return `${label}（缺：${missingSlots.join('、')}）`
        return `${label}（存在重复内容，需补交不同材料）`
      })
      lines.push(`尚未收齐（${missing.length} 人）：${items.join('；')}`)
    }

    if (needsChanges.length) {
      const items = needsChanges.map((p) => formatPersonLabel(p.identity, p.owner, maskNames))
      lines.push(`材料需补充/重交（${needsChanges.length} 人）：${items.join('、')}`)
    }

    if (!pendingSet.size) {
      lines.push('目前名单内应交材料均已收齐，暂无待催交人员。')
    }

    lines.push(`提交链接：${url}`)
    if (codeLine) lines.push(codeLine)
    if (needsChanges.length && c.allowReplacement !== false) {
      lines.push(
        '退回替换指引：打开提交链接 → 点击「已经交过？查询回执 / 替换文件」→ 导入或输入原私密回执 → 按核对说明修改后点击「按说明替换本批文件」。',
      )
    }
    return {
      text: lines.join('\n'),
      pendingCount: pendingSet.size,
      missingCount: missing.length,
      needsChangesCount: needsChanges.length,
    }
  }

  const people = options.participants || []
  const missing = people.filter((p) => p.expected && !p.fileIds.length)
  const submitted = people.filter((p) => p.fileIds.length > 0).length
  const expectedTotal = c.expectedSubmitters?.length || people.length

  lines.push(
    `当前进度：共 ${expectedTotal} 人中已有 ${submitted} 人提交；截止时间 ${c.deadline} 23:59（UTC+8）。`,
  )
  if (missing.length) {
    const names = missing.map((p) => formatPersonLabel(p.identity, p.owner, maskNames))
    lines.push(`尚未提交（${missing.length} 人）：${names.join('、')}`)
  } else if (c.expectedSubmitters?.length) {
    lines.push('应交名单内人员均已提交，感谢配合！')
  } else {
    lines.push('尚未配置应交名单，请尚未提交的同学尽快按链接提交。')
  }
  lines.push(`提交链接：${url}`)
  if (codeLine) lines.push(codeLine)

  return {
    text: lines.join('\n'),
    pendingCount: missing.length,
    missingCount: missing.length,
    needsChangesCount: 0,
  }
}

export function buildDirectReminder(options: {
  collection: Collection
  url: string
  passcode?: string
  materialParticipant?: MaterialParticipant
  participant?: Participant
}): string {
  const { collection: c, url, passcode } = options
  const codeLine = passcodeNotice(c, passcode)

  if (options.materialParticipant) {
    const p = options.materialParticipant
    const greetingName =
      p.owner && p.owner !== p.identity ? `${p.owner}（${p.identity}）` : p.identity
    const lines: string[] = [`你好 ${greetingName}，关于「${c.title}」的材料提交提醒如下：`]

    const missingSlots = p.slots
      .filter((s) => s.requirement.required && !s.files.length)
      .map((s) => s.requirement.name)
    if (missingSlots.length) {
      lines.push(`- 尚未提交的必需材料：${missingSlots.join('、')}`)
    } else if (!p.receivedComplete) {
      lines.push('- 检测到不同必需材料项提交了相同内容的文件，请分别上传对应材料。')
    }

    const rejectedDetails: string[] = []
    for (const slot of p.slots) {
      for (const f of slot.files) {
        if (f.materialReview?.decision === 'needs_changes') {
          const note = f.materialReview.note?.trim() || '请核对材料要求后重新提交'
          rejectedDetails.push(`${slot.requirement.name}（${f.name}）：${note}`)
        }
      }
    }
    if (rejectedDetails.length) {
      lines.push('- 以下材料核对退回，需按说明补充或修改：')
      for (const detail of rejectedDetails) lines.push(`  · ${detail}`)
    }

    if (p.unclassified.length) {
      lines.push(
        `- 你有 ${p.unclassified.length} 份文件暂未归属到具体材料项（${p.unclassified.map((f) => f.name).join('、')}），请确认是否需要按对应材料项重新提交。`,
      )
    }

    if (
      !missingSlots.length &&
      !rejectedDetails.length &&
      p.receivedComplete &&
      !p.reviewComplete
    ) {
      lines.push('- 你的必需材料已收到，目前正在等待人工核对，无需重复提交。')
    }

    lines.push(`截止时间：${c.deadline} 23:59（UTC+8）`)
    lines.push(`提交链接：${url}`)
    if (codeLine) lines.push(codeLine)

    if (rejectedDetails.length && c.allowReplacement !== false) {
      lines.push(
        '回执替换指引：打开上方链接 → 点击「已经交过？查询回执 / 替换文件」→ 导入当时保存的 .txt 回执（或输入回执编号与私密凭证）→ 点击「按说明替换本批文件」并重新选择本批完整文件即可，原旧批次会自动移入回收站。',
      )
    } else if (missingSlots.length && c.submissionMode !== 'single') {
      lines.push('补交指引：直接打开上方链接补传缺少的材料即可，已提交的文件会继续保留。')
    }
    return lines.join('\n')
  }

  const p = options.participant
  const greetingName = p
    ? p.owner && p.owner !== p.identity
      ? `${p.owner}（${p.identity}）`
      : p.identity
    : '同学'
  const lines: string[] = [`你好 ${greetingName}，提醒你尽快完成「${c.title}」的文件提交：`]
  if (p && p.fileIds.length && p.duplicates > 0) {
    lines.push(
      `- 系统检测到你已提交的 ${p.fileIds.length} 份文件中存在 ${p.duplicates} 份内容完全相同，请确认是否漏传或重复上传。`,
    )
  } else {
    lines.push(
      `- 尚未收到你的文件，请准备 ${c.formats} 格式（单文件 ≤ ${effectiveFileLimit(c)} MB）。`,
    )
  }
  lines.push(`截止时间：${c.deadline} 23:59（UTC+8）`)
  lines.push(`提交链接：${url}`)
  if (codeLine) lines.push(codeLine)
  if (c.allowReplacement !== false) {
    lines.push('如需修改已提交文件，可打开链接使用个人私密回执替换原批次。')
  }
  return lines.join('\n')
}
