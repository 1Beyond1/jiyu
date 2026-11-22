import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from './theme.ts'

test('主题偏好支持跟随系统 / 暖白日间 / 暖炭深色三态解析与持久化回退', () => {
  const bag = new Map<string, string>()
  const fakeStorage = {
    getItem: (key: string) => bag.get(key) ?? null,
    setItem: (key: string, val: string) => {
      bag.set(key, val)
    },
  }

  assert.equal(readThemePreference(fakeStorage), 'system')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')

  saveThemePreference('dark', fakeStorage)
  assert.equal(bag.get(THEME_STORAGE_KEY), 'dark')
  assert.equal(readThemePreference(fakeStorage), 'dark')

  saveThemePreference('light', fakeStorage)
  assert.equal(readThemePreference(fakeStorage), 'light')

  // 非法存储值安全回退为 system
  bag.set(THEME_STORAGE_KEY, 'neon-invalid')
  assert.equal(readThemePreference(fakeStorage), 'system')
})

test('暖炭深色模式 CSS 完整覆盖 5 项语义变量、表格交互、复选框、AI 面板及首屏防闪', () => {
  const css = readFileSync(resolve('src/styles.css'), 'utf8')
  const darkIndex = css.indexOf(':root[data-theme="dark"]')
  assert.ok(darkIndex > 0, '应存在 :root[data-theme="dark"] 块')
  const darkBlock = css.slice(darkIndex)

  for (const token of [
    '--danger-soft:',
    '--warn:',
    '--warn-soft:',
    '--violet:',
    '--violet-soft:',
  ]) {
    assert.ok(darkBlock.includes(token), `深色主题缺少语义变量 ${token}`)
  }
  assert.ok(!darkBlock.includes('.assistant-drawer'), '不应存在写错的类名 .assistant-drawer')
  for (const selector of [
    ':root[data-theme="dark"] .assistant-panel',
    ':root[data-theme="dark"] th',
    ':root[data-theme="dark"] tr:hover td',
    ':root[data-theme="dark"] tr.selected td',
    ':root[data-theme="dark"] .material-matrix tbody tr:hover td',
    ':root[data-theme="dark"] input[type="checkbox"]:checked',
    ':root[data-theme="dark"] .sidebar nav > button.active',
    ':root[data-theme="dark"] .collection-label',
    ':root[data-theme="dark"] .ai-banner-symbol',
    ':root[data-theme="dark"] .ai-banner h3',
    ':root[data-theme="dark"] .drop-zone.dragging',
    ':root[data-theme="dark"] .material-ai-evidence',
    ':root[data-theme="dark"] .material-card.has-files',
    ':root[data-theme="dark"] .webhook-channel-card',
    ':root[data-theme="dark"] .webhook-log-row',
    ':root[data-theme="dark"] .review-shortcut-bar',
    ':root[data-theme="dark"] .receipt-overview-card',
    ':root[data-theme="dark"] .receipt-slot-item',
    ':root[data-theme="dark"] .offline-file-item',
    ':root[data-theme="dark"] .archive-scope-tabs',
    ':root[data-theme="dark"] .archive-scope-tabs button.active',
    ':root[data-theme="dark"] .webhook-channel-card .button:not(.primary)',
  ]) {
    assert.ok(darkBlock.includes(selector), `深色主题缺少选择器覆盖：${selector}`)
  }
  const slotRuleMatch = darkBlock.match(
    /:root\[data-theme="dark"\]\s*\.receipt-slot-item\s*\{[^}]*\}/,
  )
  assert.ok(slotRuleMatch, '应存在独立的 :root[data-theme="dark"] .receipt-slot-item 规则')
  assert.equal(
    /\bborder-color\s*:/.test(slotRuleMatch[0]),
    false,
    '暗色 .receipt-slot-item 不得使用全四边 border-color 覆写状态左边框',
  )
  assert.ok(
    css.includes('@media (prefers-color-scheme: dark)'),
    'CSS 应包含首屏 prefers-color-scheme: dark 兜底防闪',
  )
})
