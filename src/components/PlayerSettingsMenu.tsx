'use client'

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Settings,
  Check,
  Camera,
  Ruler,
  Grid3X3,
  Gauge,
  ChevronRight,
} from 'lucide-react'
import type { SafeZonePreset } from './SafeZoneOverlay'

/**
 * 1.3.2+: Player settings popup. Replaces the read-only SD/HD/4K
 * badge with a gear icon that opens a Frame.io-style menu with:
 *  - Quality (1080p / 720p / 540p / 360p / Auto — based on what the
 *    server actually has for this clip)
 *  - Guides (Off / 9:16 / 4:5 / 16:9 social safe-zones)
 *  - Rulers (toggle for the Photoshop-style draggable guides)
 *  - Download Still (snapshots the current frame at source resolution)
 *
 * Rows that own sub-options open a SIDE submenu on hover (master/detail)
 * so the user doesn't have to click through. The side panel stays open
 * while the mouse is over it; both panels close together after a short
 * grace period when the cursor leaves both.
 */

export type QualityChoice = 'auto' | '2160p' | '1080p' | '720p'

interface Props {
  /** Available qualities for THIS clip, derived from which stream URLs
   *  the server returned. Order is high→low; if 2160p / 1080p are
   *  missing they don't show. */
  availableQualities: ('2160p' | '1080p' | '720p')[]
  /** The user's chosen quality preference. 'auto' lets the player pick
   *  the default (currently 720p for speed). */
  quality: QualityChoice
  onQualityChange: (q: QualityChoice) => void
  /** Resolved quality currently playing — shown next to the Quality row
   *  ("1080p HD" / "720p HD" / "Auto"). */
  resolvedQuality: '720p' | '1080p' | '2160p' | null
  /** Safe-zone preset (radio: only one active at a time). */
  guides: SafeZonePreset
  onGuidesChange: (g: SafeZonePreset) => void
  /** Rulers on/off. */
  rulers: boolean
  onRulersChange: (on: boolean) => void
  /** Capture the current frame at source resolution and download a PNG.
   *  Caller handles the actual canvas/blob work; this menu just calls
   *  back when the user clicks. */
  onDownloadStill: () => void
}

const QUALITY_LABEL: Record<'2160p' | '1080p' | '720p', string> = {
  '2160p': '4K',
  '1080p': 'HD',
  '720p': 'HD',
}

const GUIDES_LABEL: Record<SafeZonePreset, string> = {
  off: 'Off',
  '9:16': '9:16 Shorts',
  '4:5': '4:5 IG Feed',
  '16:9': '16:9 YouTube',
}

type Submenu = 'quality' | 'guides' | null

export default function PlayerSettingsMenu({
  availableQualities,
  quality,
  onQualityChange,
  resolvedQuality,
  guides,
  onGuidesChange,
  rulers,
  onRulersChange,
  onDownloadStill,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const mainMenuRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<Submenu>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  )
  const [mainSize, setMainSize] = useState<{
    width: number
    height: number
    bottom: number
    right: number
  } | null>(null)
  // Grace timer for hover-out so the cursor can travel across the gap
  // between the main menu and the side submenu without it closing.
  const submenuCloseTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Position the portal relative to the wrapper's viewport rect.
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const el = wrapperRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setAnchor({
        top: r.top - 8,
        right: Math.max(8, window.innerWidth - r.right),
      })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open])

  // Measure the main menu so the side submenu can hug its left edge.
  useLayoutEffect(() => {
    if (!open) return
    const el = mainMenuRef.current
    if (!el) {
      setMainSize(null)
      return
    }
    const measure = () => {
      const r = el.getBoundingClientRect()
      setMainSize({
        width: r.width,
        height: r.height,
        bottom: window.innerHeight - r.bottom,
        right: window.innerWidth - r.right,
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, anchor])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-player-settings-menu]')) return
      if (wrapperRef.current?.contains(target)) return
      setOpen(false)
      setSubmenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (submenu) {
          setSubmenu(null)
        } else {
          setOpen(false)
        }
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, submenu])

  // Helpers for the hover-open / hover-close grace behaviour.
  const scheduleSubmenuClose = useCallback(() => {
    if (submenuCloseTimerRef.current) {
      clearTimeout(submenuCloseTimerRef.current)
    }
    submenuCloseTimerRef.current = setTimeout(() => {
      setSubmenu(null)
      submenuCloseTimerRef.current = null
    }, 180)
  }, [])
  const cancelSubmenuClose = useCallback(() => {
    if (submenuCloseTimerRef.current) {
      clearTimeout(submenuCloseTimerRef.current)
      submenuCloseTimerRef.current = null
    }
  }, [])
  const openSubmenu = useCallback(
    (s: Submenu) => {
      cancelSubmenuClose()
      setSubmenu(s)
    },
    [cancelSubmenuClose],
  )

  const popoverStyle: React.CSSProperties = {
    backgroundColor: 'hsl(var(--card) / 0.65)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
  }

  const resolvedLabel = resolvedQuality
    ? quality === 'auto'
      ? `Auto · ${resolvedQuality}`
      : `${resolvedQuality} ${QUALITY_LABEL[resolvedQuality]}`
    : 'Auto'

  return (
    <div ref={wrapperRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          setSubmenu(null)
        }}
        className="p-2 hover:bg-white/10 active:bg-white/20 rounded-md transition-colors touch-manipulation"
        aria-label="Player settings"
        title="Player settings"
      >
        <Settings className="w-4 h-4 text-white" />
      </button>

      {open && anchor &&
        createPortal(
          <>
            {/* MAIN MENU */}
            <div
              ref={mainMenuRef}
              data-player-settings-menu
              className="fixed z-[2147483600] min-w-[240px] rounded-xl text-card-foreground ring-1 ring-border shadow-[0_12px_40px_rgba(0,0,0,0.6)] overflow-hidden"
              style={{
                right: anchor.right,
                bottom: `calc(100vh - ${anchor.top}px)`,
                ...popoverStyle,
              }}
              onMouseLeave={scheduleSubmenuClose}
              onMouseEnter={cancelSubmenuClose}
            >
              <div className="py-1">
                {/* Quality row */}
                <RowWithSubmenu
                  icon={<Gauge className="w-4 h-4 shrink-0 opacity-80" />}
                  label="Quality"
                  value={resolvedLabel}
                  active={submenu === 'quality'}
                  onOpen={() => openSubmenu('quality')}
                />
                {/* Guides row */}
                <RowWithSubmenu
                  icon={<Grid3X3 className="w-4 h-4 shrink-0 opacity-80" />}
                  label="Guides"
                  value={GUIDES_LABEL[guides]}
                  active={submenu === 'guides'}
                  onOpen={() => openSubmenu('guides')}
                />
                {/* Rulers toggle (no submenu — direct toggle) */}
                <button
                  type="button"
                  onMouseEnter={() => openSubmenu(null)}
                  onClick={() => onRulersChange(!rulers)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                >
                  <Ruler className="w-4 h-4 shrink-0 opacity-80" />
                  <span className="flex-1 whitespace-nowrap">Rulers</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {rulers ? 'On' : 'Off'}
                  </span>
                </button>
                <div className="my-1 border-t border-white/10" />
                {/* Download Still */}
                <button
                  type="button"
                  onMouseEnter={() => openSubmenu(null)}
                  onClick={() => {
                    onDownloadStill()
                    setOpen(false)
                    setSubmenu(null)
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                >
                  <Camera className="w-4 h-4 shrink-0 opacity-80" />
                  <span className="flex-1 whitespace-nowrap">Download Still</span>
                </button>
              </div>
            </div>

            {/* SIDE SUBMENU — opens to the LEFT of the main menu so the
                gear stays anchored at the bottom-right of the player.
                The `key={submenu}` forces a remount when the user
                hovers from Quality to Guides (or back), so the fade-in
                animation replays for the new content. */}
            {submenu && mainSize && (
              <div
                key={submenu}
                data-player-settings-menu
                className="fixed z-[2147483600] min-w-[220px] rounded-xl text-card-foreground ring-1 ring-border shadow-[0_12px_40px_rgba(0,0,0,0.6)] overflow-hidden animate-in fade-in-0 slide-in-from-right-2 duration-200 ease-out"
                style={{
                  // Hug the main menu's left edge with a 6 px gap so the
                  // two panels read as one continuous menu.
                  right: `calc(${mainSize.right}px + ${mainSize.width}px + 6px)`,
                  bottom: `${mainSize.bottom}px`,
                  ...popoverStyle,
                }}
                onMouseEnter={cancelSubmenuClose}
                onMouseLeave={scheduleSubmenuClose}
              >
                {submenu === 'quality' && (
                  <div className="py-1">
                    <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Quality
                    </div>
                    <SubmenuRow
                      active={quality === 'auto'}
                      onClick={() => {
                        onQualityChange('auto')
                      }}
                      label="Auto"
                      sub="Recommended"
                    />
                    {availableQualities.map((q) => (
                      <SubmenuRow
                        key={q}
                        active={quality === q}
                        onClick={() => onQualityChange(q)}
                        label={q}
                        sub={QUALITY_LABEL[q]}
                      />
                    ))}
                  </div>
                )}

                {submenu === 'guides' && (
                  <div className="py-1">
                    <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Safe-zones
                    </div>
                    {(['off', '9:16', '4:5', '16:9'] as SafeZonePreset[]).map(
                      (g) => (
                        <SubmenuRow
                          key={g}
                          active={guides === g}
                          onClick={() => onGuidesChange(g)}
                          label={GUIDES_LABEL[g]}
                        />
                      ),
                    )}
                  </div>
                )}
              </div>
            )}
          </>,
          document.body,
        )}
    </div>
  )
}

function RowWithSubmenu({
  icon,
  label,
  value,
  active,
  onOpen,
}: {
  icon: React.ReactNode
  label: string
  value: string
  active: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      // Open on hover (mouse) or click (touch). Touch devices that fire
      // a synthetic mouseenter after tap will already have the panel
      // open, so the click is a no-op.
      onMouseEnter={onOpen}
      onClick={onOpen}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors text-left ${
        active ? 'bg-white/10' : 'hover:bg-white/5'
      }`}
    >
      {icon}
      <span className="flex-1 whitespace-nowrap">{label}</span>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {value}
      </span>
      <ChevronRight className="w-4 h-4 opacity-60" />
    </button>
  )
}

function SubmenuRow({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean
  onClick: () => void
  label: string
  sub?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-white/5 transition-colors text-left"
    >
      <Check
        className={`w-4 h-4 shrink-0 ${active ? 'opacity-100 text-primary' : 'opacity-0'}`}
      />
      <span className="flex-1 whitespace-nowrap">{label}</span>
      {sub && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">{sub}</span>
      )}
    </button>
  )
}
