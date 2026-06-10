'use client'

/**
 * 2.5.1+: GlassCalendar — Frame.io-style frosted-glass date picker
 * popover. Replaces the OS-rendered native picker (which can't be
 * themed) so date selection across the app matches the rest of the
 * v2.5 vocabulary. Portalled to document.body so backdrop-filter
 * samples the actual page behind it.
 *
 * Originally lived as a private function inside ShareModal; promoted
 * to a shared component when Project Settings → Folder share links
 * needed the same picker for the per-folder expiration date input.
 *
 * Layout:
 *   ┌────────────────────────┐
 *   │  ← June 2026     →    │   header w/ month nav
 *   │  M  T  W  T  F  S  S   │   weekday row
 *   │  1  2  3  4  5  6  7   │
 *   │  …                     │   6 rows of day cells
 *   │  ── divider ──         │
 *   │  Clear        Today    │
 *   └────────────────────────┘
 *
 * Days before `min` (when provided) are visually muted and unclickable.
 * Selected day = accent-tinted glass pill. Today = subtle accent ring
 * (no fill) so the user can spot it even when a different date is
 * selected.
 *
 * The trigger button that opens the calendar should carry the
 * `data-glass-calendar-trigger` attribute so the outside-click handler
 * doesn't dismiss the popover on the trigger's own click — the parent
 * is responsible for toggling state.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export interface GlassCalendarProps {
  open: boolean
  anchorRect: DOMRect | null
  value: Date | null
  min?: Date
  onChange: (next: Date | null) => void
  onClose: () => void
  /**
   * 2.5.1+: when GlassCalendar is rendered inside a Radix Dialog
   * (modal=true), the dialog sets `pointer-events: none` on the body
   * which kills clicks on the portalled popover. Setting this to
   * `true` forces `pointer-events: auto` on the wrapper so the
   * calendar remains interactive. Outside a Dialog, the default
   * (false) is fine.
   */
  inDialog?: boolean
}

export function GlassCalendar({
  open,
  anchorRect,
  value,
  min,
  onChange,
  onClose,
  inDialog = false,
}: GlassCalendarProps) {
  // Internal display month — what the grid currently shows. Resets to
  // the selected value's month every time the popover opens.
  const [displayMonth, setDisplayMonth] = useState<Date>(() => {
    return value || min || new Date()
  })
  useEffect(() => {
    if (!open) return
    setDisplayMonth(value || min || new Date())
  }, [open, value, min])

  const popoverRef = useRef<HTMLDivElement>(null)
  // 2.5.1+: outside-click + Escape close. Click handler on document
  // captures any click; we skip clicks inside the calendar itself
  // (via the `data-glass-calendar` marker) and clicks on the trigger
  // button (which toggles via its own handler).
  useEffect(() => {
    if (!open) return
    const onClickDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest?.('[data-glass-calendar]')) return
      if (target.closest?.('[data-glass-calendar-trigger]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('click', onClickDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClickDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  // Compute the day grid for the displayed month. We render 6 weeks
  // (42 cells) so the row count stays constant when navigating.
  const grid = useMemo(() => {
    const first = new Date(
      displayMonth.getFullYear(),
      displayMonth.getMonth(),
      1,
    )
    // ISO weeks start on Monday. JS getDay() returns Sun=0..Sat=6;
    // convert to Mon=0..Sun=6.
    const isoStart = (first.getDay() + 6) % 7
    const start = new Date(first)
    start.setDate(first.getDate() - isoStart)
    const cells: Date[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      cells.push(d)
    }
    return cells
  }, [displayMonth])

  if (!open || !anchorRect || typeof document === 'undefined') return null

  // Position: below the anchor by 6 px, right-aligned to the anchor's
  // right edge. Clamped inside the viewport with an 8 px gutter.
  const POPOVER_W = 280
  const POPOVER_H = 320 // approximate; exact height varies w/ rows
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const idealRight = Math.max(
    8,
    Math.min(vw - 8 - POPOVER_W, anchorRect.right - POPOVER_W),
  )
  // Prefer below; flip above when there isn't room.
  const fitsBelow = anchorRect.bottom + POPOVER_H + 8 <= vh
  const top = fitsBelow
    ? anchorRect.bottom + 6
    : Math.max(8, anchorRect.top - POPOVER_H - 6)
  const left = idealRight

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const minDay = min ? new Date(min.getFullYear(), min.getMonth(), min.getDate()) : null

  const weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  const goPrev = () => {
    setDisplayMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
  }
  const goNext = () => {
    setDisplayMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
  }
  const pickDay = (d: Date) => {
    if (minDay && d < minDay) return
    // Set to end-of-day so picking "today" doesn't expire instantly.
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
    onChange(next)
    onClose()
  }
  const pickToday = () => {
    const t = new Date()
    pickDay(t)
  }
  const clear = () => {
    onChange(null)
    onClose()
  }

  const monthLabel = displayMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  // 2.5.1+: portalled to document.body so the popover doesn't pick
  // up a containing block from any ancestor `transform` /
  // `backdrop-filter` (both create new containing blocks for fixed-
  // position descendants and would pin the calendar inside that
  // ancestor). Inside a Radix Dialog we also force pointer-events
  // back on (see `inDialog` prop docs).
  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Pick a date"
      data-glass-calendar
      className="fixed z-[200] rounded-xl ring-1 ring-white/15 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-3 text-white animate-in fade-in-0 slide-in-from-top-1 duration-150"
      style={{
        left,
        top,
        width: POPOVER_W,
        ...(inDialog ? { pointerEvents: 'auto' as const } : {}),
        backgroundColor: 'rgba(22, 37, 51, 0.55)',
        backgroundImage:
          'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        transform: 'translate3d(0, 0, 0)',
        willChange: 'backdrop-filter, transform',
        isolation: 'isolate',
      }}
    >
      {/* Header — month + nav */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-white capitalize">
          {monthLabel}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous month"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 transition-colors text-white/80 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goNext}
            aria-label="Next month"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 transition-colors text-white/80 hover:text-white"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {weekdays.map((w, i) => (
          <div
            key={`${w}-${i}`}
            className="h-7 flex items-center justify-center text-[10px] uppercase tracking-wide text-white/45"
          >
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {grid.map((d, i) => {
          const inMonth = d.getMonth() === displayMonth.getMonth()
          const isToday = sameDay(d, today)
          const isSelected = value ? sameDay(d, value) : false
          const isDisabled = minDay ? d < minDay : false
          return (
            <button
              key={i}
              type="button"
              onClick={() => !isDisabled && pickDay(d)}
              disabled={isDisabled}
              aria-label={d.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
              aria-pressed={isSelected}
              className="h-8 w-full flex items-center justify-center rounded-md text-xs font-medium transition-colors disabled:cursor-not-allowed"
              style={
                isSelected
                  ? {
                      backgroundColor: 'hsl(var(--spotlight-tint) / 0.30)',
                      boxShadow: 'inset 0 0 0 1px hsl(var(--spotlight-tint) / 0.55)',
                      color: '#fff',
                    }
                  : isToday
                    ? {
                        boxShadow: 'inset 0 0 0 1px hsl(var(--spotlight-tint) / 0.50)',
                        color: 'hsl(var(--spotlight-tint))',
                      }
                    : {
                        color: isDisabled
                          ? 'rgba(255,255,255,0.20)'
                          : inMonth
                            ? 'rgba(255,255,255,0.92)'
                            : 'rgba(255,255,255,0.35)',
                      }
              }
              onMouseEnter={(e) => {
                if (isSelected || isDisabled) return
                ;(e.currentTarget as HTMLButtonElement).style.backgroundColor =
                  'rgba(255,255,255,0.08)'
              }}
              onMouseLeave={(e) => {
                if (isSelected || isDisabled) return
                ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = ''
              }}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>

      {/* Footer — Clear / Today */}
      <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between">
        <button
          type="button"
          onClick={clear}
          className="px-2 py-1 rounded-md text-xs font-medium text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={pickToday}
          className="px-2 py-1 rounded-md text-xs font-medium transition-colors"
          style={{
            color: 'hsl(var(--spotlight-tint))',
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
              'hsl(var(--spotlight-tint) / 0.15)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.backgroundColor = '')
          }
        >
          Today
        </button>
      </div>
    </div>,
    document.body,
  )
}
