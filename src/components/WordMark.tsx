'use client'

import { cn } from '@/lib/utils'
import LogoMark from './LogoMark'

type WordMarkProps = {
  /**
   * Layout variant:
   *   - "horizontal" → icon + "Frame Comment" on a single line. Default,
   *     used everywhere a header row needs the full brand.
   *   - "stacked" → icon centered above "Frame Comment". Used on the
   *     login page where the splash dominates the viewport.
   *   - "text-only" → just the wordmark, no icon. Used in dense headers
   *     where the favicon already carries the icon role.
   */
  variant?: 'horizontal' | 'stacked' | 'text-only'
  /**
   * Vertical size of the icon glyph in pixels. The wordmark text auto-
   * scales next to it so the two read as one balanced unit at any
   * height. Default 28 (works for AdminHeader).
   */
  iconSize?: number
  className?: string
  ariaHidden?: boolean
  /**
   * 2.5.1+: drop the rounded-square background tile from the icon
   * half. Pass-through to `LogoMark`'s own `noBackground` prop —
   * useful when the wordmark sits on a dark / branded surface
   * (e.g. the AdminSidebar) where the tile reads as redundant
   * chrome rather than the brand container.
   */
  noBackground?: boolean
}

/**
 * 2.5.0+ FrameComment wordmark — icon + text lockup.
 *
 * Renders the brand as "Frame" (foreground) + "Comment" (accent blue).
 * The text uses `currentColor` for the "Frame" half so it picks up the
 * surrounding `color` token automatically:
 *   - On a dark header: text is light, "Comment" stays blue.
 *   - On a light header: text is dark, "Comment" stays blue.
 *
 * That means the SAME component works in light / dark mode without a
 * media query — the parent's text color is the source of truth.
 *
 * Typography is sized off `iconSize` so a 24px icon pairs with a smaller
 * label than a 64px splash icon. Tracking is slightly negative (`-0.01em`)
 * to match the tighter geometric feel of the icon glyphs.
 */
export function WordMark({
  variant = 'horizontal',
  iconSize = 28,
  className,
  ariaHidden = false,
  noBackground = false,
}: WordMarkProps) {
  // Text size derived from icon size so the two glyphs visually balance.
  // The 0.6 multiplier is hand-tuned — at iconSize 28 it lands on ~17px,
  // which reads as a strong header label without overpowering nav items.
  const textPx = Math.round(iconSize * 0.6)
  const gapPx = Math.round(iconSize * 0.32)

  const accent = 'hsl(var(--primary, 211 100% 50%))'

  const text = (
    <span
      className="font-bold tracking-tight leading-none whitespace-nowrap"
      style={{ fontSize: `${textPx}px`, letterSpacing: '-0.01em' }}
    >
      <span style={{ color: 'currentColor' }}>Frame</span>
      <span style={{ color: accent }}>Comment</span>
    </span>
  )

  if (variant === 'text-only') {
    return (
      <div
        className={cn('inline-flex items-center', className)}
        aria-hidden={ariaHidden}
        role={ariaHidden ? 'presentation' : 'img'}
        aria-label={ariaHidden ? undefined : 'FrameComment'}
      >
        {text}
      </div>
    )
  }

  if (variant === 'stacked') {
    // Stack: icon on top, text underneath. Used on login splash.
    return (
      <div
        className={cn('inline-flex flex-col items-center gap-3', className)}
        aria-hidden={ariaHidden}
        role={ariaHidden ? 'presentation' : 'img'}
        aria-label={ariaHidden ? undefined : 'FrameComment'}
      >
        <LogoMark size={iconSize} ariaHidden noBackground={noBackground} />
        {text}
      </div>
    )
  }

  // Horizontal (default): icon left, text right.
  return (
    <div
      className={cn('inline-flex items-center', className)}
      style={{ gap: `${gapPx}px` }}
      aria-hidden={ariaHidden}
      role={ariaHidden ? 'presentation' : 'img'}
      aria-label={ariaHidden ? undefined : 'FrameComment'}
    >
      <LogoMark size={iconSize} ariaHidden noBackground={noBackground} />
      {text}
    </div>
  )
}

export default WordMark
