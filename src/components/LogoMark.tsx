'use client'

import { cn } from '@/lib/utils'

type LogoMarkProps = {
  size?: number
  accent?: string
  className?: string
  ariaHidden?: boolean
  /**
   * When true, drops the rounded-square background and renders the
   * icon glyphs against transparent — useful when placing the mark
   * inside a colored chip / pill in the AdminHeader or on top of a
   * branded splash screen where the background colour is already
   * controlled by the surrounding element. Defaults to false (the
   * full app-tile look).
   */
  noBackground?: boolean
}

/**
 * 2.5.0+ FrameComment logomark — Play+i.
 *
 * The mark is two glyphs in a 64×64 viewBox:
 *   1. A blue, right-pointing play triangle on the left half.
 *      Built as a path with rounded joins so the silhouette stays
 *      friendly at every render size from 16px favicon up to the
 *      512px PWA icon.
 *   2. A lowercase "i" on the right half: a blue circular dot
 *      stacked above a dark, vertical pill that reads as the stem.
 *
 * Theming. The background, accent and stem each have a CSS
 * custom property fallback so the SAME markup adapts to:
 *   - Light mode → white tile, dark stem, blue accent
 *   - Dark mode  → near-black tile, white stem, blue accent
 *   - Monochrome chips (with `noBackground`) → no tile at all
 *
 * The `accent` prop still wins over the CSS var so legacy callers
 * that want a custom-tinted mark (e.g. a non-blue accentColor
 * theme) keep working without changes.
 */
export function LogoMark({
  size = 64,
  accent = 'hsl(var(--primary, 211 100% 50%))',
  className,
  ariaHidden = false,
  noBackground = false,
}: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={ariaHidden ? 'presentation' : 'img'}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : 'FrameComment logo'}
      className={cn('shrink-0', className)}
    >
      {/* Rounded-square tile. Skipped when the caller wants the
          glyphs to float on whatever background it provides. */}
      {!noBackground && (
        <rect
          width="64"
          height="64"
          rx="14"
          fill="var(--logo-bg, #ffffff)"
        />
      )}

      {/* Play triangle (left glyph). The path traces a rounded
          right-pointing wedge using arc-style curves at each
          corner — keeps the silhouette tactile at small sizes
          where stroke-linejoin alone would flatten too much. */}
      <path
        d="
          M 14 16
          C 14 13 16 12 18 13
          L 41 30
          C 43 31 43 33 41 34
          L 18 51
          C 16 52 14 51 14 48
          Z
        "
        fill={accent}
      />

      {/* "i" dot — the blue circle. */}
      <circle cx="51" cy="20" r="4.5" fill={accent} />

      {/* "i" stem — the dark vertical pill. Uses its own CSS var
          so dark mode can flip it to white without touching the
          accent / background. */}
      <rect
        x="46.5"
        y="28"
        width="9"
        height="22"
        rx="4.5"
        fill="var(--logo-i-stem, #0f172a)"
      />
    </svg>
  )
}

export default LogoMark
