import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  buildDirectReminder,
  buildGroupReminder,
  buildShareAnnouncement,
  maskIdentifier,
} from './reminder.ts'
import { materialFileVersion } from './materials.ts'
import type { Collection, CollectedFile, MaterialParticipant, Participant } from '../types.ts'

const baseCollection: Collection = {
  id: 'col-1',
  title: '社团作品征集',
  description: '请提交报名表与作品说明',
  category: 'document',
  received: 3,
  target: 20,
  deadline: '2026-12-20',
  storage: 'local',
  status: 'active',
  formats: 'PDF, DOCX',
  maxFileSizeMB: 50,
  maxFilesPerSubmission: 5,
  expectedSubmitters: ['20260001', '20260002', '20260003'],
  allowReplacement: true,
  hasAccessCode: true,
  materials: [
    { id: 'mat_form', name: '报名表', required: true, description: '需签字盖章' },
    { id: 'mat_doc', name: '作品说明', required: true, description: '不少于 500 字' },
    { id: 'mat_extra', name: '演示截图', required: false, description: '选填' },
  ],
  materialRevision: 'rev-1',
}

test('maskIdentifier 正确脱敏中文姓名与学号/编号标识', () => {
  assert.equal(maskIdentifier('李'), '*')
  assert.equal(maskIdentifier('张三'), '张*')
  assert.equal(maskIdentifier('张小明'), '张*明')
  assert.equal(maskIdentifier('欧阳小明'), '欧**明')
  assert.equal(maskIdentifier('202601'), '20***1')
  assert.equal(maskIdentifier('20260001'), '202***01')
})

test('buildShareAnnouncement 输出完整结构化群通知并支持可选提取码', () => {
  const withCode = buildShareAnnouncement({
    collection: baseCollection,
    url: 'https://jiyu.example.com/#/submit/tok1',
    passcode: '654321',
  })
  assert.ok(withCode.includes('【文件收集】社团作品征集'))
  assert.ok(withCode.includes('必需材料：报名表、作品说明'))
  assert.ok(withCode.includes('选填材料：演示截图'))
  assert.ok(withCode.includes('提取码：654321'))
  assert.ok(withCode.includes('https://jiyu.example.com/#/submit/tok1'))

  const withoutPlainCode = buildShareAnnouncement({
    collection: baseCollection,
    url: 'https://jiyu.example.com/#/submit/tok1',
  })
  assert.ok(withoutPlainCode.includes('已开启提取码保护'))
})

test('buildGroupReminder 支持群公告脱敏与明文切换，准确汇总缺项与退回人员', () => {
  const rejectedFile: CollectedFile = {
    id: 'f-1',
    name: '作品说明.pdf',
    size: 1024,
    collectionId: 'col-1',
    owner: '李四',
    createdAt: '2026-11-22T00:00:00.000Z',
    storage: 'local',
    status: 'pending',
    materialId: 'mat_doc',
    materialReview: {
      decision: 'needs_changes',
      note: '缺少项目成员分工表',
      rulesRevision: 'rev-1',
      fileVersion: 'v1',
      operationId: 'op-1',
      reviewerId: 'primary',
      reviewerName: '管理员',
      reviewedAt: '2026-11-22T01:00:00.000Z',
    },
  }
  const people: MaterialParticipant[] = [
    {
      identity: '20260001',
      owner: '张三',
      expected: true,
      files: [],
      slots: [
        {
          requirement: baseCollection.materials![0],
          files: [],
          state: 'missing',
          duplicate: false,
        },
        {
          requirement: baseCollection.materials![1],
          files: [],
          state: 'missing',
          duplicate: false,
        },
      ],
      unclassified: [],
      receivedComplete: false,
      reviewComplete: false,
      status: 'missing',
      duplicateCount: 0,
    },
    {
      identity: '20260002',
      owner: '李四',
      expected: true,
      files: [rejectedFile],
      slots: [
        {
          requirement: baseCollection.materials![0],
          files: [
            { ...rejectedFile, id: 'f-0', materialId: 'mat_form', materialReview: undefined },
          ],
          state: 'accepted',
          duplicate: false,
        },
        {
          requirement: baseCollection.materials![1],
          files: [rejectedFile],
          state: 'needs_changes',
          duplicate: false,
        },
      ],
      unclassified: [],
      receivedComplete: true,
      reviewComplete: false,
      status: 'needs_changes',
      duplicateCount: 0,
    },
  ]

  const masked = buildGroupReminder({
    collection: baseCollection,
    url: 'https://jiyu.example.com/#/submit/tok1',
    maskNames: true,
    materialParticipants: people,
  })
  assert.equal(masked.missingCount, 1)
  assert.equal(masked.needsChangesCount, 1)
  assert.equal(masked.pendingCount, 2)
  assert.ok(masked.text.includes('202***01（张*）'))
  assert.ok(masked.text.includes('202***02（李*）'))
  assert.ok(!masked.text.includes('20260001'))
  assert.ok(!masked.text.includes('张三'))
  assert.ok(masked.text.includes('退回替换指引'))

  const unmasked = buildGroupReminder({
    collection: baseCollection,
    url: 'https://jiyu.example.com/#/submit/tok1',
    maskNames: false,
    materialParticipants: people,
  })
  assert.ok(unmasked.text.includes('20260001（张三）'))
  assert.ok(unmasked.text.includes('20260002（李四）'))
})

test('buildDirectReminder 精确列出缺项、materialReview.note 退回说明与回执替换指引，并过滤已过期 stale 退回说明', () => {
  const rejectedBase: CollectedFile = {
    id: 'f-2',
    name: '报名表.pdf',
    size: 2048,
    collectionId: 'col-1',
    owner: '王五',
    createdAt: '2026-11-22T00:00:00.000Z',
    storage: 'local',
    status: 'pending',
    materialId: 'mat_form',
  }
  const rejectedFile: CollectedFile = {
    ...rejectedBase,
    materialReview: {
      decision: 'needs_changes',
      note: '指导老师签字处空白，请签字后重新扫描上传',
      rulesRevision: 'rev-1',
      fileVersion: materialFileVersion(rejectedBase),
      operationId: 'op-2',
      reviewerId: 'primary',
      reviewerName: '管理员',
      reviewedAt: '2026-11-22T02:00:00.000Z',
    },
  }
  const staleRejectedBase: CollectedFile = {
    id: 'f-stale',
    name: '已改名旧材料.pdf',
    size: 2048,
    collectionId: 'col-1',
    owner: '王五',
    createdAt: '2026-11-22T00:00:00.000Z',
    storage: 'local',
    status: 'pending',
    materialId: 'mat_form',
    materialVersion: 2,
  }
  const staleRejectedFile: CollectedFile = {
    ...staleRejectedBase,
    materialReview: {
      decision: 'needs_changes',
      note: '这条旧规则或旧版本的过期退回原因绝不能出现在新催交话术中',
      rulesRevision: 'rev-0-expired',
      fileVersion: 'stale-version',
      operationId: 'op-stale',
      reviewerId: 'primary',
      reviewerName: '管理员',
      reviewedAt: '2026-11-21T02:00:00.000Z',
    },
  }
  const person: MaterialParticipant = {
    identity: '20260003',
    owner: '王五',
    expected: true,
    files: [rejectedFile, staleRejectedFile],
    slots: [
      {
        requirement: baseCollection.materials![0],
        files: [rejectedFile, staleRejectedFile],
        state: 'needs_changes',
        duplicate: false,
      },
      { requirement: baseCollection.materials![1], files: [], state: 'missing', duplicate: false },
    ],
    unclassified: [],
    receivedComplete: false,
    reviewComplete: false,
    status: 'needs_changes',
    duplicateCount: 0,
  }

  const dm = buildDirectReminder({
    collection: baseCollection,
    url: 'https://jiyu.example.com/#/submit/tok1',
    passcode: 'AB12',
    materialParticipant: person,
  })
  assert.ok(dm.includes('你好 王五（20260003）'))
  assert.ok(dm.includes('尚未提交的必需材料：作品说明'))
  assert.ok(dm.includes('报名表（报名表.pdf）：指导老师签字处空白，请签字后重新扫描上传'))
  assert.ok(
    !dm.includes('过期退回原因绝不能出现在新催交话术中'),
    '已过期（stale）的旧退回说明不应带入催交话术',
  )
  assert.ok(dm.includes('回执替换指引'))
  assert.ok(dm.includes('按说明替换本批文件'))
  assert.ok(dm.includes('提取码：AB12'))

  const simpleParticipant: Participant = {
    identity: '赵六',
    owner: '赵六',
    expected: true,
    fileIds: [],
    bytes: 0,
    submissions: 0,
    latestAt: '',
    duplicates: 0,
  }
  const simpleDm = buildDirectReminder({
    collection: { ...baseCollection, materials: [] },
    url: 'https://jiyu.example.com/#/submit/tok1',
    participant: simpleParticipant,
  })
  assert.ok(simpleDm.includes('你好 赵六'))
  assert.ok(simpleDm.includes('尚未收到你的文件'))
})
