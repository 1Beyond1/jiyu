import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isEditableTarget, resolveReviewShortcut, stepFileIndex } from './review-shortcuts.ts'

test('分栏审阅快捷键解析：支持 J/K/A/R/Ctrl+Enter 并在输入聚焦与修饰键时合理放行', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true)
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true)
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isEditableTarget(null), false)

  // 非编辑态支持单键快捷键（兼容大小写）
  assert.equal(resolveReviewShortcut({ key: 'j' }, false), 'next')
  assert.equal(resolveReviewShortcut({ key: 'J' }, false), 'next')
  assert.equal(resolveReviewShortcut({ key: 'k' }, false), 'prev')
  assert.equal(resolveReviewShortcut({ key: 'a' }, false), 'approve')
  assert.equal(resolveReviewShortcut({ key: 'r' }, false), 'reject')

  // 长按重复触发 A/R 时忽略防误操作
  assert.equal(resolveReviewShortcut({ key: 'a', repeat: true }, false), null)
  assert.equal(resolveReviewShortcut({ key: 'r', repeat: true }, false), null)

  // 修饰键组合不得劫持浏览器快捷键（Ctrl+A / Cmd+R / Alt+J）
  assert.equal(resolveReviewShortcut({ key: 'a', ctrlKey: true }, false), null)
  assert.equal(resolveReviewShortcut({ key: 'r', metaKey: true }, false), null)
  assert.equal(resolveReviewShortcut({ key: 'j', altKey: true }, false), null)

  // 输入框 / 文本框聚焦时，普通字符键全部放行
  assert.equal(resolveReviewShortcut({ key: 'j' }, true), null)
  assert.equal(resolveReviewShortcut({ key: 'k' }, true), null)
  assert.equal(resolveReviewShortcut({ key: 'a' }, true), null)
  assert.equal(resolveReviewShortcut({ key: 'r' }, true), null)

  // Ctrl+Enter / Cmd+Enter 在聚焦文本框与非聚焦状态都允许提交审核意见
  assert.equal(resolveReviewShortcut({ key: 'Enter', ctrlKey: true }, true), 'submit')
  assert.equal(resolveReviewShortcut({ key: 'Enter', metaKey: true }, true), 'submit')
  assert.equal(resolveReviewShortcut({ key: 'Enter', ctrlKey: true }, false), 'submit')
  assert.equal(resolveReviewShortcut({ key: 'Enter', ctrlKey: true, altKey: true }, true), null)

  // IME 组合输入与 Shift 修饰键一律屏蔽
  assert.equal(resolveReviewShortcut({ key: 'j', isComposing: true }, false), null)
  assert.equal(resolveReviewShortcut({ key: 'a', keyCode: 229 }, false), null)
  assert.equal(
    resolveReviewShortcut({ key: 'Enter', ctrlKey: true, isComposing: true }, true),
    null,
  )
  assert.equal(resolveReviewShortcut({ key: 'J', shiftKey: true }, false), null)
  assert.equal(resolveReviewShortcut({ key: 'A', shiftKey: true }, false), null)
  assert.equal(resolveReviewShortcut({ key: 'Enter', ctrlKey: true, shiftKey: true }, true), null)

  // 打开 AI 助手 / 通知弹层 / 移动端菜单等浮层时全部屏蔽
  assert.equal(resolveReviewShortcut({ key: 'j' }, false, { overlayOpen: true }), null)
  assert.equal(resolveReviewShortcut({ key: 'a' }, false, { overlayOpen: true }), null)
  assert.equal(
    resolveReviewShortcut({ key: 'Enter', ctrlKey: true }, true, { overlayOpen: true }),
    null,
  )

  // Ctrl+Enter 仅在审阅容器内聚焦时触发，绝不劫持外部输入框（AI 助手 / 全局搜索）
  assert.equal(
    resolveReviewShortcut({ key: 'Enter', ctrlKey: true }, true, { inReviewContainer: false }),
    null,
  )
  assert.equal(
    resolveReviewShortcut({ key: 'Enter', metaKey: true }, true, { inReviewContainer: false }),
    null,
  )
  assert.equal(
    resolveReviewShortcut({ key: 'Enter', ctrlKey: true }, true, { inReviewContainer: true }),
    'submit',
  )
})

test('文件循环切换索引计算覆盖空列表、单文件与首尾回绕', () => {
  assert.equal(stepFileIndex(0, 0, 'next'), -1)
  assert.equal(stepFileIndex(0, 1, 'next'), 0)
  assert.equal(stepFileIndex(0, 3, 'next'), 1)
  assert.equal(stepFileIndex(2, 3, 'next'), 0)
  assert.equal(stepFileIndex(0, 3, 'prev'), 2)
  assert.equal(stepFileIndex(1, 3, 'prev'), 0)
  assert.equal(stepFileIndex(-1, 3, 'next'), 1)
})
