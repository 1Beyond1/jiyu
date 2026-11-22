import { test } from 'node:test'
import { strict as assert } from 'node:assert'
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
