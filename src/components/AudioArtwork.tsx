'use client'

import { Music, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 7.18.2: the one picture an audio file has, drawn the same everywhere.
 *
 * The player's artwork (a note in a frosted circle, a soft radial glow in the
 * app's accent, the resting ring of the spectrum around it) is what Dragos
 * asked to see on the folder card and in Quick Look too — the card showed a
 * bare glyph on the card's own dark grey. One component now, so the three
 * surfaces cannot drift apart, and every colour comes from `--spotlight-tint`
 * (the accent the theme sets), never from a literal.
 *
 * `children` render BEHIND the circle, centred: the player passes its live
 * AudioReactiveRing there and turns the static ring off; the card and Quick
 * Look keep the static ring — a repeating conic gradient masked to a thin
 * band, i.e. the bars of the live ring at rest, with no canvas and no
 * JavaScript.
 *
 * 7.18.4: the same picture carries a FOLDER too (`glyph`): an empty folder's
 * card, a folder inside a folder's mosaic and the folder's Quick Look showed
 * a flat folder outline on the glass — Dragos asked for this design there
 * as well. Any kind can pass its own lucide glyph; audio is the default.
 */
export interface AudioArtworkProps {
  /** The glyph inside the circle; the audio note by default. */
  glyph?: LucideIcon
  /** Diameter of the frosted circle, CSS px. */
  circle: number
  /** Size of the note glyph, CSS px. */
  icon: number
  /** Draw the resting dashed ring around the circle (off when a live ring is passed). */
  staticRing?: boolean
  /** Wrapper classes — position it (`absolute inset-0`) and layer it. */
  className?: string
  /** Rendered centred behind the circle (the live ring). */
  children?: ReactNode
  /** Paint the dark tinted base too (the card); the player's stage is already dark. */
  withBase?: boolean
}

export default function AudioArtwork({
  glyph: Glyph = Music,
  circle,
  icon,
  staticRing = true,
  className,
  children,
  withBase = false,
}: AudioArtworkProps) {
  // The static ring sits just outside the circle, as the live bars do at rest.
  const ringOuter = circle + 24
  const inner = ((circle + 12) / ringOuter) * 100
  const outer = ((circle + 20) / ringOuter) * 100
  const glow =
    'radial-gradient(ellipse 70% 60% at 50% 45%, hsl(var(--spotlight-tint) / 0.28) 0%, hsl(var(--spotlight-tint) / 0.08) 55%, transparent 100%)'
  const base =
    'linear-gradient(180deg, hsl(var(--spotlight-tint) / 0.14) 0%, hsl(var(--spotlight-tint) / 0.05) 100%), #070a10'
  return (
    <div
      className={`flex items-center justify-center select-none ${className ?? ''}`}
      style={{ background: withBase ? `${glow}, ${base}` : glow }}
      aria-hidden
    >
      <div className="relative flex items-center justify-center" style={{ width: circle, height: circle }}>
        {children}
        {staticRing && (
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: ringOuter,
              height: ringOuter,
              background:
                'repeating-conic-gradient(from 0deg, hsl(var(--spotlight-tint) / 0.55) 0deg 2deg, transparent 2deg 5deg)',
              WebkitMaskImage: `radial-gradient(circle, transparent ${inner - 1}%, #000 ${inner}%, #000 ${outer}%, transparent ${outer + 1}%)`,
              maskImage: `radial-gradient(circle, transparent ${inner - 1}%, #000 ${inner}%, #000 ${outer}%, transparent ${outer + 1}%)`,
            }}
          />
        )}
        <div
          className="relative flex items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/15 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-[2px]"
          style={{ width: circle, height: circle }}
        >
          <Glyph className="text-white/80" style={{ width: icon, height: icon }} />
        </div>
      </div>
    </div>
  )
}
