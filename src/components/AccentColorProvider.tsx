'use client'

import { useEffect, useCallback } from 'react'
import { ACCENT_COLORS, AccentColorKey } from '@/components/settings/AppearanceSection'
import { setPublicShareOrigin } from '@/lib/public-share-origin'

/**
 * 2.5.0+: Convert a #RRGGBB hex string to an HSL triplet formatted the
 * way the CSS variables consume — e.g. "211 100% 50%" with no commas.
 * Returns null for anything that's not a 6-digit hex (#abc shorthand
 * not supported on purpose — the picker emits the full form).
 */
function hexToHslTriplet(hex: string): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h *= 60
  }
  const round = (n: number) => Math.round(n * 10) / 10
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`
}

/**
 * 2.5.0+: Apply an accent color to the live DOM by writing the relevant
 * CSS custom properties on <html>. Exported so the Appearance settings
 * pane can re-use it for instant live-preview when a swatch is clicked
 * (the value is not yet persisted at that point — the user still has to
 * hit Save Changes for it to stick).
 *
 * Accepts either a preset key (e.g. "blue", "green") OR a custom
 * 6-digit hex string like "#FF5733" — the latter comes from the
 * Custom swatch's color picker in the Appearance section. For presets
 * we still respect the light / dark HSL variant so contrast stays
 * sensible; for custom hex we use the same HSL in both modes since
 * the user picked an exact color and we don't want to second-guess it.
 *
 * Variables written:
 *  - --primary           accent hue used for buttons, badges, active states
 *  - --ring              focus ring + selection ring color
 *  - --accent-foreground accent-on-glass text color
 *  - --primary-visible   tinted bg for "info" notice cards
 *  - --spotlight-tint    the giant top-left light spot in the layout
 *                         gradient. Without this, switching from blue
 *                         to e.g. green only changed the foreground
 *                         accents while the page background kept the
 *                         original blue glow — visually inconsistent.
 */
export function applyAccentColor(colorKeyOrHex: AccentColorKey | string) {
  const root = document.documentElement
  const isDark = root.classList.contains('dark')

  let hslValue: string | null = null

  // Preset key path.
  const preset = ACCENT_COLORS[colorKeyOrHex as AccentColorKey]
  if (preset) {
    hslValue = isDark ? preset.dark : preset.light
  } else if (typeof colorKeyOrHex === 'string' && colorKeyOrHex.startsWith('#')) {
    // Custom hex path.
    hslValue = hexToHslTriplet(colorKeyOrHex)
  }

  if (!hslValue) return

  root.style.setProperty('--primary', hslValue)
  root.style.setProperty('--ring', hslValue)
  root.style.setProperty('--accent-foreground', hslValue)
  root.style.setProperty('--spotlight-tint', hslValue)

  // primary-visible: a tinted-background variant used for the "info"
  // notice cards (HSTS enabled, etc.). Light/dark gets a different
  // lightness so the contrast against the surrounding glass stays
  // readable in either theme.
  const parts = hslValue.split(' ')
  const h = parts[0]
  const s = parts[1] || '100%'
  root.style.setProperty(
    '--primary-visible',
    isDark ? `${h} ${s} 20%` : `${h} ${s} 95%`,
  )
}

/**
 * Applies the accent color CSS variables and caches admin theme defaults
 * Fetches from API and caches in localStorage for faster subsequent loads
 */
export function AccentColorProvider() {
  const applyAppearanceSettings = useCallback(async () => {
    try {
      // Fetch current setting from API
      const response = await fetch('/api/settings/theme')
      if (response.ok) {
        const data = await response.json()
        const colorKey = (data.accentColor || 'blue') as AccentColorKey
        const defaultTheme = data.defaultTheme || 'auto'

        // Cache both values for faster loads on subsequent visits
        localStorage.setItem('adminAccentColor', colorKey)
        localStorage.setItem('adminDefaultTheme', defaultTheme)

        // 1.6.1: piggy-back on the same fetch to refresh the cached
        // public share origin. The theme endpoint is already hit on
        // every admin page load, so this avoids a second roundtrip.
        if (typeof data?.appDomain === 'string' && data.appDomain.trim()) {
          setPublicShareOrigin(data.appDomain)
        } else {
          setPublicShareOrigin(null)
        }

        // Apply the accent color
        applyColorVariables(colorKey)

        // 4.0.3: dark-only — always enforce dark regardless of any
        // stored preference.
        applyDefaultTheme(defaultTheme)
      } else {
        // API failed, use cached values
        const cachedColor = localStorage.getItem('adminAccentColor') as AccentColorKey | null
        if (cachedColor) {
          applyColorVariables(cachedColor)
        }
      }
    } catch {
      // On error, try cached value
      const cachedColor = localStorage.getItem('adminAccentColor') as AccentColorKey | null
      if (cachedColor) {
        applyColorVariables(cachedColor)
      }
    }
  }, [])

  useEffect(() => {
    applyAppearanceSettings()
  }, [applyAppearanceSettings])

  const applyDefaultTheme = (_defaultTheme: string) => {
    // 4.0.3: Light mode removed. FrameComment is dark-only, so we always
    // keep the `dark` class on <html> no matter what value is stored.
    document.documentElement.classList.add('dark')
  }

  const applyColorVariables = (colorKey: AccentColorKey) => {
    // Initial apply.
    applyAccentColor(colorKey)

    // Re-apply on light/dark toggle so the light/dark HSL variant
    // tracks the active theme without a full page reload.
    const root = document.documentElement
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          applyAccentColor(colorKey)
        }
      })
    })

    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
  }

  return null
}
