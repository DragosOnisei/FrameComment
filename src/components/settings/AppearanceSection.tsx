import { useEffect, useRef } from 'react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { Moon, Sun, Check, Globe } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { applyAccentColor } from '@/components/AccentColorProvider'

const SUPPORTED_LANGUAGES = [
  { code: 'en' },
] as const

// Accent color presets with HSL values for light and dark modes
export const ACCENT_COLORS = {
  blue: { name: 'Blue', light: '211 100% 50%', dark: '209 100% 60%', hex: '#007AFF' },
  purple: { name: 'Purple', light: '262 83% 58%', dark: '262 83% 68%', hex: '#8B5CF6' },
  green: { name: 'Green', light: '145 63% 42%', dark: '145 63% 49%', hex: '#22C55E' },
  orange: { name: 'Orange', light: '25 95% 53%', dark: '25 95% 60%', hex: '#F97316' },
  red: { name: 'Red', light: '0 84% 60%', dark: '0 84% 65%', hex: '#EF4444' },
  pink: { name: 'Pink', light: '330 81% 60%', dark: '330 81% 65%', hex: '#EC4899' },
  teal: { name: 'Teal', light: '173 80% 40%', dark: '173 80% 50%', hex: '#14B8A6' },
  amber: { name: 'Amber', light: '38 92% 50%', dark: '38 92% 55%', hex: '#F59E0B' },
  stone: { name: 'Stone', light: '30 12% 50%', dark: '30 12% 62%', hex: '#9d9487' },
  gold: { name: 'Gold', light: '37 56% 65%', dark: '37 56% 72%', hex: '#DEC091' },
} as const

export type AccentColorKey = keyof typeof ACCENT_COLORS

interface AppearanceSectionProps {
  language: string
  setLanguage: (value: string) => void
  defaultTheme: string
  setDefaultTheme: (value: string) => void
  accentColor: string
  setAccentColor: (value: string) => void
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean
}

export function AppearanceSection({
  language,
  setLanguage,
  defaultTheme,
  setDefaultTheme,
  accentColor,
  setAccentColor,
  show,
  setShow,
  collapsible,
}: AppearanceSectionProps) {
  const t = useTranslations('settings')

  // 2.5.0+: Live preview of accent color.
  //
  // The first render captures the accent color that was loaded from the
  // server — that's our "baseline" to revert to if the user clicks
  // around the swatches but then navigates away without saving. Each
  // subsequent change to `accentColor` (the parent React state, mutated
  // by clicking a swatch) writes the CSS variables on <html> via
  // `applyAccentColor` so the whole app — sidebar highlight, brand-blue
  // logo, glass-tinted active states, the top-left light spot
  // (--spotlight-tint) — updates instantly.
  //
  // The save path is unchanged: the parent's Save Changes button POSTs
  // the new color to /api/settings, which then survives a reload.
  // Until the user saves, the page background only tracks the chosen
  // hue in-memory; refreshing pulls back the persisted value.
  const baselineAccentRef = useRef<string>(accentColor)
  const userInteractedRef = useRef(false)

  useEffect(() => {
    // On every change to the selected swatch, push it to the DOM so the
    // sidebar nav, brand-blue logo, glass active states + the top-left
    // spotlight gradient all flip instantly. We skip only the no-op
    // case where the value still matches the original baseline and the
    // user hasn't touched the picker (avoids a redundant write right
    // after the AccentColorProvider already applied the server value).
    if (accentColor === baselineAccentRef.current && !userInteractedRef.current) {
      return
    }
    applyAccentColor(accentColor as any)
  }, [accentColor])

  // Listen for the "save succeeded" event from the parent. That marks
  // the current value as the new baseline so the unmount-revert
  // doesn't undo a freshly persisted color.
  useEffect(() => {
    const onSaved = (e: Event) => {
      const detail = (e as CustomEvent<{ accentColor: string }>).detail
      if (detail?.accentColor) {
        baselineAccentRef.current = detail.accentColor
        userInteractedRef.current = false
      }
    }
    window.addEventListener('accentcolor:saved', onSaved as EventListener)
    return () => window.removeEventListener('accentcolor:saved', onSaved as EventListener)
  }, [])

  useEffect(() => {
    // Revert on unmount if the user picked a swatch but never saved.
    // Source of truth for "saved color" is localStorage, kept in sync
    // by both AccentColorProvider (initial paint) and the save handler.
    return () => {
      if (!userInteractedRef.current) return
      let savedColor = baselineAccentRef.current
      try {
        const cached = localStorage.getItem('adminAccentColor')
        if (cached) savedColor = cached
      } catch {
        /* ignore */
      }
      if (savedColor && savedColor !== accentColor) {
        applyAccentColor(savedColor as any)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <CollapsibleSection
      // 2.5.0+: frosted-glass section panel — same recipe used
      // across the rest of the new chrome (sidebar nav, user
      // cards, table view): 4% white tint, hairline white-10
      // ring, soft outward shadow, and explicit inline
      // backdrop-filter so the blur lands even if a Tailwind
      // utility gets purged.
      className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
      title={t('appearance.title')}
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t border-white/10 pt-4"
      collapsible={collapsible}
    >
      {/* 1.5.8: Application Language card hidden — only English is
          shipped right now, so the dropdown was just visual noise.
          `language` state + the GET/PATCH plumbing stay intact so a
          future locale add can drop the wrapper to re-expose this
          card without rewiring. */}
      {false && (
      <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
        <Label className="flex items-center gap-2">
          <Globe className="w-4 h-4" />
          {t('language.label')}
        </Label>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LANGUAGES.map((lang) => (
              <SelectItem key={lang.code} value={lang.code}>
                {t(`language.${lang.code}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t('language.hint')}
        </p>
      </div>
      )}

      {/* 3.6.x: Light / Dark theme toggle. Default is DARK — anywhere
          the resolved value is 'auto' (or unset) we treat it as dark
          (see the layout bootstrap), so a device set to light mode
          never forces the app to light. Toggling here applies the theme
          live and caches it (`adminDefaultTheme`) so it sticks on
          reload; Save Changes persists it to the server for good. */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <Label className="text-white">{t('appearance.defaultTheme')}</Label>
        {/* Segmented control: a padded glass "track" with two equal-width
            segments; the active one lifts on a filled primary pill. Same
            vocabulary as the rest of the v2.5 chrome. */}
        <div className="flex w-full max-w-[240px] gap-1 p-1 rounded-xl bg-black/20 ring-1 ring-white/10">
          {([
            { value: 'light', label: t('appearance.light'), Icon: Sun },
            { value: 'dark', label: t('appearance.dark'), Icon: Moon },
          ] as const).map(({ value, label, Icon }) => {
            // Dark is the active state for both 'dark' and 'auto'/unset.
            const active =
              value === 'light' ? defaultTheme === 'light' : defaultTheme !== 'light'
            return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setDefaultTheme(value)
                  document.documentElement.classList.toggle(
                    'dark',
                    value !== 'light',
                  )
                  try {
                    localStorage.setItem('adminDefaultTheme', value)
                  } catch {
                    /* ignore */
                  }
                }}
                aria-pressed={active}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                  active
                    ? 'bg-primary text-white shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.55)]'
                    : 'text-white/55 hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-white/55">{t('appearance.themeToggleHint')}</p>
      </div>

      {/* Accent Color Selection — nested floating glass card.
          Active swatch is marked by the checkmark alone — no extra
          outline ring. */}
      <div className="space-y-3 p-4 rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        <Label className="text-white">{t('appearance.accentColor')}</Label>
        <div className="flex flex-wrap gap-3">
          {Object.entries(ACCENT_COLORS).map(([key, color]) => {
            const isSelected = accentColor === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  // Mark that the user has manually changed colors so
                  // the unmount-revert logic knows to roll back if
                  // they leave without saving.
                  userInteractedRef.current = true
                  setAccentColor(key)
                }}
                className="group relative flex flex-col items-center gap-1.5 p-1"
                title={color.name}
                aria-label={color.name}
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center transition-transform group-hover:scale-110"
                  style={{ backgroundColor: color.hex }}
                >
                  {isSelected && <Check className="w-5 h-5 text-white" strokeWidth={3} />}
                </div>
                <span className="text-xs text-white/55">{t(`appearance.${key}` as any)}</span>
              </button>
            )
          })}

          {/*
            2.5.0+: Custom swatch. Click pops the native color picker
            (we trigger the hidden <input type="color"> ref). The
            picker fires `input` events live as the user drags through
            the spectrum, so the whole admin chrome flashes the new
            color in real time — same code path as a preset swatch
            because applyAccentColor now also accepts a #RRGGBB hex.
          */}
          {(() => {
            const isHexSelected =
              typeof accentColor === 'string' && accentColor.startsWith('#')
            const swatchBg = isHexSelected
              ? accentColor
              : 'conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #14b8a6, #007AFF, #8b5cf6, #ec4899, #ef4444)'
            return (
              <label
                className="group relative flex flex-col items-center gap-1.5 p-1 cursor-pointer"
                title="Custom"
                aria-label="Custom color"
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 ring-1 ring-white/10"
                  style={{ background: swatchBg }}
                >
                  {isHexSelected && (
                    <Check className="w-5 h-5 text-white drop-shadow" strokeWidth={3} />
                  )}
                </div>
                <span className="text-xs text-white/55">Custom</span>
                <input
                  type="color"
                  // Show whatever's currently selected, defaulting to
                  // the blue preset's hex so the picker opens at a
                  // sane starting point on first use.
                  value={isHexSelected ? accentColor : ACCENT_COLORS.blue.hex}
                  onInput={(e) => {
                    // `onInput` runs continuously while the user drags
                    // through the picker — drives the live preview.
                    const next = (e.target as HTMLInputElement).value
                    userInteractedRef.current = true
                    setAccentColor(next)
                  }}
                  onChange={(e) => {
                    // `onChange` fires when the picker closes / the
                    // user commits. Same handler — covers browsers
                    // (looking at you, Safari) that don't fire input
                    // events live.
                    const next = e.target.value
                    userInteractedRef.current = true
                    setAccentColor(next)
                  }}
                  className="sr-only"
                  aria-label="Choose custom accent color"
                />
              </label>
            )
          })()}
        </div>
      </div>
    </CollapsibleSection>
  )
}
