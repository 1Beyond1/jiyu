import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'jiyu:theme'
export const THEME_LABELS: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '暖白日间',
  dark: '暖炭深色',
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readThemePreference(storage?: Pick<Storage, 'getItem'> | null): ThemePreference {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    const saved = store?.getItem(THEME_STORAGE_KEY)
    return isThemePreference(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    store?.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    /* Private browsing or disabled storage still applies in-memory theme. */
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'dark') return 'dark'
  if (preference === 'light') return 'light'
  return prefersDark ? 'dark' : 'light'
}

function systemPrefersDark(): boolean {
  try {
    return Boolean(globalThis.window?.matchMedia?.('(prefers-color-scheme: dark)').matches)
  } catch {
    return false
  }
}

export function applyThemeToDocument(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark())
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved
    document.documentElement.dataset.themePref = preference
    document.documentElement.style.colorScheme = resolved
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (meta) meta.content = resolved === 'dark' ? '#191513' : '#fbf7f4'
  }
  return resolved
}

export function initTheme(): { preference: ThemePreference; resolved: ResolvedTheme } {
  const preference = readThemePreference()
  const resolved = applyThemeToDocument(preference)
  return { preference, resolved }
}

const THEME_CHANGE_EVENT = 'jiyu:theme-change'

export function setThemePreference(preference: ThemePreference): ResolvedTheme {
  saveThemePreference(preference)
  const resolved = applyThemeToDocument(preference)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ThemePreference>(THEME_CHANGE_EVENT, { detail: preference }),
    )
  }
  return resolved
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference())
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readThemePreference(), systemPrefersDark()),
  )

  useEffect(() => {
    setResolved(applyThemeToDocument(preference))
  }, [preference])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const syncSystem = () => {
      const current = readThemePreference()
      setPreferenceState(current)
      setResolved(applyThemeToDocument(current))
    }
    const onCustom = (event: Event) => {
      const next = (event as CustomEvent<ThemePreference>).detail
      if (isThemePreference(next)) {
        setPreferenceState(next)
        setResolved(applyThemeToDocument(next))
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) syncSystem()
    }
    media?.addEventListener?.('change', syncSystem)
    window.addEventListener(THEME_CHANGE_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      media?.removeEventListener?.('change', syncSystem)
      window.removeEventListener(THEME_CHANGE_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    setResolved(setThemePreference(next))
  }, [])

  return { preference, resolved, setPreference }
}
