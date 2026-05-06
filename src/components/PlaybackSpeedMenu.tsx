'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Frame.io-style playback speed selector.
 *
 * Trigger: a small button labelled with the current speed (e.g. "1.0x").
 * Click opens a popup floating above the trigger with a discrete list of
 * supported speeds. The active speed is highlighted. Clicking outside or
 * pressing Escape closes the popup.
 *
 * The HTMLVideoElement.playbackRate ceiling depends on the codec/decoder
 * — Chrome and Safari typically clamp at ~16x — but 8x is a sensible
 * upper bound that matches what Frame.io exposes for review playback.
 */
const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 4.0, 8.0] as const

interface PlaybackSpeedMenuProps {
  value: number
  onChange: (speed: number) => void
  className?: string
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
}: PlaybackSpeedMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
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
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Playback speed"
        className={`
          inline-flex items-center justify-center
          h-7 px-2 rounded-md
          text-xs font-mono tabular-nums font-medium
          transition-colors
          ${open
            ? 'bg-white/15 text-white'
            : 'bg-white/5 text-white/90 hover:bg-white/10 hover:text-white'}
        `}
      >
        {formatSpeed(value)}
      </button>

      {open && (
        <div
          role="menu"
          className="
            absolute bottom-full mb-2 left-1/2 -translate-x-1/2
            z-50 min-w-[180px]
            bg-black/95 backdrop-blur-md
            ring-1 ring-white/15 shadow-2xl
            rounded-lg p-1
            animate-in fade-in-0 slide-in-from-bottom-1 duration-150
          "
        >
          <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-white/50">
            Playback speed
          </div>
          <div className="grid grid-cols-1 gap-0.5">
            {SPEED_OPTIONS.map((s) => {
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
                  className={`
                    flex items-center justify-between
                    px-3 py-1.5 rounded-md text-sm font-mono tabular-nums
                    transition-colors
                    ${isActive
                      ? 'bg-primary/30 text-white'
                      : 'text-white/85 hover:bg-white/10 hover:text-white'}
                  `}
                >
                  <span>{formatSpeed(s)}</span>
                  {isActive && (
                    <span aria-hidden className="text-primary text-[10px]">●</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
