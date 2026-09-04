'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Rewind } from 'lucide-react'
import { PLAYBACK_SPEED_LADDER } from '@/lib/video-speed'

/**
 * Frame.io-style playback speed selector.
 *
 * Trigger: a small button labelled with the current speed (e.g. "1.0x").
 * Click opens a popup floating above the trigger with a discrete list of
 * supported speeds. The active speed is highlighted. Clicking outside or
 * pressing Escape closes the popup.
 *
 * The HTMLVideoElement.playbackRate ceiling depends on the codec/decoder
 * — Chrome and Safari typically clamp at ~16x — 4x is the top of the
 * ladder since 7.5.0.
 */
/** The one ladder — 7.5.0: Dragos's spec, 1x plus the seven factors that can
 *  also be SAVED into the file (no slowdowns any more). Lives in
 *  lib/video-speed so the API validates against the very list the menu
 *  renders. The J/L keyboard shortcuts walk this same list, so the menu and
 *  the keyboard can never disagree about which speeds exist. */
export const PLAYBACK_SPEEDS = PLAYBACK_SPEED_LADDER

/** Index of the ladder entry closest to `speed` — so a rate set from anywhere
 *  else (an old session, the comparison view) still steps sensibly. */
export function nearestSpeedIndex(speed: number): number {
  let best = 0
  for (let i = 1; i < PLAYBACK_SPEEDS.length; i++) {
    if (Math.abs(PLAYBACK_SPEEDS[i] - speed) < Math.abs(PLAYBACK_SPEEDS[best] - speed)) best = i
  }
  return best
}

const DEFAULT_SPEED_OPTIONS = PLAYBACK_SPEEDS

interface PlaybackSpeedMenuProps {
  value: number
  onChange: (speed: number) => void
  className?: string
  /** Override the list of speeds. Defaults to the full ladder.
   *  The comparison view passes a tighter 0.75×–2× set. */
  options?: readonly number[]
  /** 7.6.0: the player is shuttling BACKWARDS at `value`. The pill shows the
   *  rewind glyph in front of the speed ("⏪ 1x") so the direction is legible
   *  at a glance, not only from the lit reverse button. */
  reverse?: boolean
}

function formatSpeed(s: number): string {
  // 1.0 → "1x", 1.25 → "1.25x", 1.5 → "1.5x"
  if (Number.isInteger(s)) return `${s}x`
  return `${s}x`.replace(/\.?0+x$/, 'x')
}

export default function PlaybackSpeedMenu({
  value,
  onChange,
  className = '',
  options = DEFAULT_SPEED_OPTIONS,
  reverse = false,
}: PlaybackSpeedMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)

  /**
   * 6.9.0: the menu is rendered in a portal on document.body and positioned
   * from the trigger's own rectangle.
   *
   * It used to be `absolute bottom-full` inside the control bar. That bar sits
   * at the bottom of the player, has a backdrop-filter (its own stacking
   * context) and lives inside scrollable containers — so with eight speeds the
   * ~290px panel opened straight off the top of the visible area. Measuring
   * and clamping to the viewport is the only thing that survives every place
   * this player is embedded: page, fullscreen, share view.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger) return
    const t = trigger.getBoundingClientRect()
    const menuW = menu?.offsetWidth ?? 180
    const menuH = menu?.offsetHeight ?? 300
    const margin = 8

    // Prefer opening upwards, the way it always has. Flip below only when
    // there genuinely isn't room, and clamp either way so it never leaves
    // the viewport.
    const spaceAbove = t.top
    const openUp = spaceAbove >= menuH + margin || spaceAbove >= window.innerHeight - t.bottom
    const rawTop = openUp ? t.top - menuH - margin : t.bottom + margin
    const top = Math.max(margin, Math.min(rawTop, window.innerHeight - menuH - margin))

    const rawLeft = t.left + t.width / 2 - menuW / 2
    const left = Math.max(margin, Math.min(rawLeft, window.innerWidth - menuW - margin))

    setCoords({ left, top })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    place()
    // Two frames: the first paints the menu so offsetHeight is real, the
    // second re-places it with the measured size.
    const raf = requestAnimationFrame(place)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (wrapperRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      {/* 2.5.1+: glass v2.5 trigger pill + dropdown. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={reverse ? 'Playback speed — reverse' : 'Playback speed'}
        className={`
          inline-flex items-center justify-center gap-1
          h-7 px-2.5 rounded-md
          text-xs font-mono tabular-nums font-medium
          ring-1 transition-colors
          ${open
            ? 'bg-white/[0.14] ring-white/25 text-white'
            : 'bg-white/[0.06] ring-white/10 text-white/85 hover:bg-white/[0.12] hover:ring-white/20 hover:text-white'}
        `}
      >
        {reverse && <Rewind className="w-3.5 h-3.5 -ml-0.5 fill-current" aria-hidden />}
        {formatSpeed(value)}
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[70] min-w-[180px] max-h-[calc(100vh-16px)] overflow-y-auto ring-1 ring-white/15 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] rounded-lg p-1 text-white animate-in fade-in-0 duration-150"
          style={{
            left: coords?.left ?? -9999,
            top: coords?.top ?? -9999,
            // Hidden until measured, so it never flashes in the wrong place.
            visibility: coords ? 'visible' : 'hidden',
            backgroundColor: 'rgba(28, 44, 64, 0.95)',
            backgroundImage:
              'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.18) 0%, hsl(var(--spotlight-tint) / 0.05) 45%, transparent 75%)',
            backdropFilter: 'blur(20px) saturate(150%)',
            WebkitBackdropFilter: 'blur(20px) saturate(150%)',
          }}
        >
          <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-white/55">
            Playback speed
          </div>
          <div className="grid grid-cols-1 gap-0.5">
            {options.map((s) => {
              const isActive = Math.abs(s - value) < 0.001
              return (
                <button
                  key={s}
                  role="menuitemradio"
                  aria-checked={isActive}
                  type="button"
                  onClick={() => {
                    onChange(s)
                    setOpen(false)
                  }}
                  className="flex items-center justify-between px-3 py-1.5 rounded-md text-sm font-mono tabular-nums transition-colors"
                  style={
                    isActive
                      ? {
                          backgroundColor: 'hsl(var(--spotlight-tint) / 0.30)',
                          color: '#fff',
                          boxShadow:
                            'inset 0 0 0 1px hsl(var(--spotlight-tint) / 0.45)',
                        }
                      : undefined
                  }
                  onMouseEnter={(e) => {
                    if (!isActive)
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                        'rgba(255,255,255,0.08)'
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive)
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                        ''
                  }}
                >
                  <span className={isActive ? 'text-white' : 'text-white/85'}>
                    {formatSpeed(s)}
                  </span>
                  {isActive && (
                    <span
                      aria-hidden
                      className="text-[10px]"
                      style={{ color: 'hsl(var(--spotlight-tint))' }}
                    >
                      ●
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
