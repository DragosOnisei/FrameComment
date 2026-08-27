'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Download, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

/**
 * 7.3.4 — a "Download ▸" menu row that opens the list of encoded versions.
 *
 * The player's kebab has offered this since 6.9.1 and the folder's right-click
 * menu offered a single bare "Download", which meant the same video gave you a
 * choice of renditions in one place and only the original in another. Dragos
 * asked for the two to match, and matching them by copying a hundred lines into
 * the card would have guaranteed they drift apart again.
 *
 * NOTE ON THE DUPLICATE THAT STILL EXISTS: PlayerTopMenu carries its own inline
 * version of this, and it is deliberately left alone for now. Its download
 * action is wired into that component's own `busy` state and toast, and its
 * submenu opens LEFT because the kebab lives in the top-right corner — folding
 * it in means changing behaviour Dragos uses constantly, as a side effect of a
 * request about a different menu. This component is written so it CAN adopt it:
 * `prefer` covers the side, `onError` covers the toast.
 *
 * The submenu is `brand-menu-surface` because it is a MENU, which CLAUDE.md is
 * explicit about — opaque, accent-blended, never the glass panel recipe. It
 * hangs off a parent that already uses it, so anything else would read as two
 * different menus stapled together.
 */
type Quality = {
  quality: string
  label: string
  height?: number | null
  bytes?: number | null
}

function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

const PANEL_WIDTH = 230
const MARGIN = 8

export default function DownloadQualitiesRow({
  videoId,
  label = 'Download',
  prefer = 'right',
  disabled = false,
  onStart,
  onError,
  rowClassName,
}: {
  videoId: string
  label?: string
  /**
   * Classes for the trigger row, so it matches whichever menu it is sitting in.
   * The two menus that use this are 2px apart on their gap and there is no
   * version of "close enough" that survives being looked at side by side.
   */
  rowClassName?: string
  /** Which side to try first. The list flips to the other one if it will not fit. */
  prefer?: 'left' | 'right'
  disabled?: boolean
  /** Called the moment a rendition is picked — used to close the parent menu. */
  onStart?: () => void
  onError?: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const [qualities, setQualities] = useState<Quality[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Which video the list in state belongs to, so hovering does not re-measure. */
  const loadedForRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!videoId || loadedForRef.current === videoId) return
    try {
      setLoading(true)
      const res = await apiFetch(`/api/videos/${videoId}/qualities`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setQualities(Array.isArray(data?.qualities) ? data.qualities : [])
      loadedForRef.current = videoId
    } catch {
      setQualities([])
    } finally {
      setLoading(false)
    }
  }, [videoId])

  /**
   * Opens instantly, closes on a delay — the reasoning PlayerTopMenu wrote down
   * in 6.9.1 and which applies to any submenu the pointer has to cross a gap to
   * reach: with an immediate close, that journey has to be pixel perfect or the
   * list vanishes mid-reach.
   */
  const openMenu = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    const row = rowRef.current
    if (row) {
      const r = row.getBoundingClientRect()
      const roomRight = window.innerWidth - r.right - MARGIN >= PANEL_WIDTH + MARGIN
      const roomLeft = r.left - MARGIN >= PANEL_WIDTH + MARGIN
      // Try the preferred side, take the other if only it fits, and fall back to
      // the preferred one when neither does — a clamped panel beats none.
      const useRight = prefer === 'right' ? roomRight || !roomLeft : !roomLeft && roomRight
      const left = useRight ? r.right + MARGIN : r.left - PANEL_WIDTH - MARGIN
      setAnchor({
        top: Math.max(MARGIN, Math.min(r.top - 4, window.innerHeight - 120)),
        left: Math.max(MARGIN, Math.min(left, window.innerWidth - PANEL_WIDTH - MARGIN)),
      })
    }
    setOpen(true)
    void load()
  }, [load, prefer])

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 1000)
  }, [])

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    [],
  )

  const download = useCallback(
    async (quality?: string) => {
      if (busy) return
      onStart?.()
      setBusy(true)
      try {
        // One-shot signed token, then open it. Same shape the player and the
        // search overlay both use — the bytes never travel through this app's
        // own request.
        const res = await apiFetch(`/api/videos/${videoId}/download-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(quality ? { quality } : {}),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { url?: string }
        if (!data.url) throw new Error('No download URL returned')
        window.open(data.url, '_blank', 'noopener,noreferrer')
      } catch (err) {
        onError?.(err instanceof Error ? err.message : 'Failed to download')
      } finally {
        setBusy(false)
      }
    },
    [busy, videoId, onStart, onError],
  )

  return (
    <div
      ref={rowRef}
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        role="menuitem"
        type="button"
        onClick={openMenu}
        disabled={disabled || busy}
        className={
          rowClassName ??
          'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] transition-colors text-left whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed'
        }
      >
        {busy ? (
          <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
        ) : (
          <Download className="w-4 h-4 shrink-0" />
        )}
        <span className="flex-1 whitespace-nowrap">{label}</span>
        <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-60" />
      </button>

      {open && anchor && typeof document !== 'undefined' &&
        createPortal(
          <div
            role="menu"
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
            /* Portalled to <body> rather than nested: the parent menu is a
               backdrop-root, and a panel rendered inside one samples a backdrop
               that has already been blurred and tinted — the same recipe comes
               out washed out. As a sibling at body level both sample the real
               page and look identical, which is the point. */
            className="brand-menu-surface fixed z-[2147483600] min-w-[230px] rounded-lg p-1 text-white ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)]"
            style={{ top: anchor.top, left: anchor.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {loading && (
              <div className="px-2 py-1.5 text-xs text-white/60 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Measuring files…
              </div>
            )}
            {!loading && qualities.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-white/60">
                No encoded versions yet.
              </div>
            )}
            {!loading &&
              qualities.map((q) => (
                <button
                  key={q.quality}
                  role="menuitem"
                  type="button"
                  onClick={() => void download(q.quality === 'original' ? undefined : q.quality)}
                  className="w-full flex items-center gap-3 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] transition-colors text-left"
                >
                  <span className="flex-1 whitespace-nowrap">
                    {q.label}
                    {q.height ? (
                      <span className="text-white/45 text-xs"> · {q.height}p</span>
                    ) : null}
                  </span>
                  <span className="text-xs tabular-nums text-white/60">
                    {formatBytes(q.bytes)}
                  </span>
                </button>
              ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
