import { Monitor, Moon, Sun } from 'lucide-react'
import { THEME_LABELS, useTheme, type ThemePreference } from '../lib/theme'

const OPTIONS: { id: ThemePreference; label: string; icon: typeof Monitor }[] = [
  { id: 'system', label: THEME_LABELS.system, icon: Monitor },
  { id: 'light', label: THEME_LABELS.light, icon: Sun },
  { id: 'dark', label: THEME_LABELS.dark, icon: Moon },
]

export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme()
  return (
    <fieldset className={`theme-switch ${compact ? 'compact' : ''}`} aria-label="界面外观主题">
      <legend className="sr-only">界面外观主题</legend>
      {OPTIONS.map((opt) => {
        const Icon = opt.icon
        const active = preference === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            className={active ? 'active' : ''}
            aria-pressed={active}
            title={opt.label}
            onClick={() => setPreference(opt.id)}
          >
            <Icon size={compact ? 14 : 15} />
            <span>{opt.label}</span>
          </button>
        )
      })}
    </fieldset>
  )
}
