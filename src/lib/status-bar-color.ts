/**
 * 4.x — phone status-bar colour helper (`<meta name="theme-color">`).
 *
 * The mobile OS status bar (clock / battery) is tinted by the page's
 * `theme-color`. iOS Safari reads it ONCE at page load and ignores later JS
 * changes, so the value has to be correct in the server-rendered HTML — which
 * is why this is a plain module usable from the (server) root layout AND from
 * the client AccentColorProvider (for live accent changes without a reload).
 *
 * The status bar overlaps the TOP-LEFT corner of the `.spotlight-bg` wash:
 * `--background` (the dark base) with the accent tint composited on top at its
 * peak alpha (`--spotlight-alpha-1`). We reproduce that exact composite here so
 * the bar reads as a seamless continuation of the app for ANY accent.
 *
 * NOTE: keep the preset map below in sync with ACCENT_COLORS in
 * src/components/settings/AppearanceSection.tsx (duplicated here on purpose so
 * a server module never has to import a `'use client'` file).
 */

const ACCENT_DARK_HSL: Record<string, string> = {
  blue: '209 100% 60%',
  purple: '262 83% 68%',
  green: '145 63% 49%',
  orange: '25 95% 60%',
  red: '0 84% 65%',
  pink: '330 81% 65%',
  teal: '173 80% 50%',
  amber: '38 92% 55%',
  stone: '30 12% 62%',
  gold: '37 56% 72%',
}

/** "#RRGGBB" → "H S% L%" triplet, or null for anything not a 6-digit hex. */
export function hexToHslTriplet(hex: string): string | null {
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

/** "H S% L%" triplet → [r, g, b] (0-255). */
function hslTripletToRgb(triplet: string): [number, number, number] | null {
  const p = triplet.trim().split(/\s+/)
  if (p.length < 3) return null
  const h = parseFloat(p[0])
  const s = parseFloat(p[1]) / 100
  const l = parseFloat(p[2]) / 100
  if ([h, s, l].some((n) => Number.isNaN(n))) return null
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g] = [c, x]
  else if (h < 120) [r, g] = [x, c]
  else if (h < 180) [g, b] = [c, x]
  else if (h < 240) [g, b] = [x, c]
  else if (h < 300) [r, b] = [x, c]
  else [r, b] = [c, x]
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ]
}

/** Composite an accent tint triplet over the app's dark base → "#RRGGBB". */
export function spotlightTopColorFromTriplet(
  triplet: string,
  isDark = true,
): string | null {
  const rgb = hslTripletToRgb(triplet)
  if (!rgb) return null
  const base = isDark ? 18 : 235 // ≈ --background (0 0% 7% dark / 220 14% 92% light)
  const alpha = isDark ? 0.18 : 0.08 // --spotlight-alpha-1 (top-left corner peak)
  const mix = (channel: number) =>
    Math.round(base * (1 - alpha) + channel * alpha)
  return (
    '#' +
    [mix(rgb[0]), mix(rgb[1]), mix(rgb[2])]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

/**
 * Resolve an accent (preset key like "orange", or a custom "#RRGGBB") to the
 * status-bar colour. Falls back to blue, then to the neutral dark base.
 */
export function statusBarColorForAccent(accent: string, isDark = true): string {
  let triplet: string | null = ACCENT_DARK_HSL[accent] ?? null
  if (!triplet && typeof accent === 'string' && accent.startsWith('#')) {
    triplet = hexToHslTriplet(accent)
  }
  if (!triplet) triplet = ACCENT_DARK_HSL.blue
  return spotlightTopColorFromTriplet(triplet, isDark) ?? '#121212'
}
