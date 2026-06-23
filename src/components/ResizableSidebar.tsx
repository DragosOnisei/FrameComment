'use client'

import {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * Wraps the comments sidebar with a Frame.io-style left-edge drag
 * handle so the user can widen or narrow it on demand.
 *
 *  ┌────┬─────────────────────────────────┐
 *  │ ║  │ <CommentSection> ...            │
 *  │ ║  │                                 │
 *  └────┴─────────────────────────────────┘
 *    ↑
 *    drag left/right to resize
 *
 * Width is persisted in localStorage per `storageKey` so it survives
 * page reloads. The handle is only active from the `lg` breakpoint up
 * (where the layout is side-by-side). Below that the sidebar
 * stretches full-width and stacks under the player as before — the
 * inline pixel width is suppressed via `matchMedia('(min-width: 1024px)')`.
 *
 * Implementation notes:
 *  - Document-level mousemove/up listeners keep the drag alive even
 *    when the cursor leaves the thin handle.
 *  - During drag we lock `body.cursor = 'ew-resize'` and disable text
 *    selection so the visual feedback is consistent.
 *  - Min width 280px keeps the comment text readable. Max is 60vw so
 *    the player keeps room.
 *  - Double-click on the handle resets to `defaultWidth`.
 */
export interface ResizableSidebarProps {
  /** localStorage key for the persisted width */
  storageKey: string
  /** initial width in pixels when nothing is persisted yet */
  defaultWidth?: number
  /** minimum width in pixels (text stays readable) */
  minWidth?: number
  /** maximum width as a fraction of viewport width [0..1] */
  maxFraction?: number
  /** className applied to the outer wrapper */
  className?: string
  children: ReactNode
}

export default function ResizableSidebar({
  storageKey,
  defaultWidth = 360,
  minWidth = 280,
  maxFraction = 0.6,
  className = '',
  children,
}: ResizableSidebarProps) {
  // SSR-safe initial value: hydrate later from localStorage. We start
  // at the default so the first paint matches across server/client.
  const [width, setWidth] = useState<number>(defaultWidth)
  // Track whether we've passed `lg` (1024px) so we know whether to
  // apply the inline pixel width or let the column-stacked mobile
  // layout pick its own size.
  const [isDesktop, setIsDesktop] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  // We need to read the latest width inside a stable mousemove
  // handler without re-creating the effect each pixel — the ref
  // makes that straightforward.
  const widthRef = useRef(width)
  useEffect(() => {
    widthRef.current = width
  }, [width])

  // Hydrate width from localStorage and watch the lg breakpoint.
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw ? parseInt(raw, 10) : NaN
      if (Number.isFinite(parsed) && parsed > 0) setWidth(parsed)
    } catch {
      // storage disabled — fall back to default
    }

    const mql = window.matchMedia('(min-width: 1024px)')
    const onChange = (e: MediaQueryListEvent | MediaQueryList) =>
      setIsDesktop('matches' in e ? e.matches : (e as MediaQueryList).matches)
    onChange(mql)
    mql.addEventListener('change', onChange as (e: MediaQueryListEvent) => void)
    return () => {
      mql.removeEventListener(
        'change',
        onChange as (e: MediaQueryListEvent) => void
      )
    }
  }, [storageKey])

  // Helper to clamp width to current viewport-aware bounds.
  const clampWidth = useCallback(
    (raw: number) => {
      const max =
        typeof window === 'undefined'
          ? Number.POSITIVE_INFINITY
          : Math.max(minWidth, Math.floor(window.innerWidth * maxFraction))
      return Math.max(minWidth, Math.min(max, Math.round(raw)))
    },
    [minWidth, maxFraction]
  )

  // Re-clamp on viewport resize so a sidebar saved at e.g. 600px on a
  // wide monitor doesn't stay 600px after the viewport shrinks. We
  // don't persist the clamped value; the user's preference comes back
  // when the viewport widens again.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setWidth((w) => clampWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampWidth])

  // Drag lifecycle. Document-level listeners keep the drag going if
  // the cursor leaves the handle; attached only while `isDragging` is
  // true to avoid global listener churn.
  useEffect(() => {
    if (!isDragging) return
    const startWidth = widthRef.current
    let startX: number | null = null

    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX =
        (e as TouchEvent).touches?.[0]?.clientX ?? (e as MouseEvent).clientX
      if (typeof clientX !== 'number') return
      if (startX === null) {
        startX = clientX
        return
      }
      // Sidebar is on the right; dragging the LEFT edge to the LEFT
      // (negative deltaX) makes the sidebar wider; to the RIGHT
      // (positive deltaX) makes it narrower.
      const deltaX = clientX - startX
      setWidth(clampWidth(startWidth - deltaX))
    }
    const onUp = () => {
      setIsDragging(false)
      try {
        window.localStorage.setItem(storageKey, String(widthRef.current))
      } catch {
        // ignore
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
    document.addEventListener('touchcancel', onUp)

    // Cursor + text-selection lock for the duration of the drag.
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
      document.removeEventListener('touchcancel', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
    }
  }, [isDragging, clampWidth, storageKey])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }
  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation()
    setIsDragging(true)
  }
  const handleDoubleClick = () => {
    const reset = clampWidth(defaultWidth)
    setWidth(reset)
    try {
      window.localStorage.setItem(storageKey, String(reset))
    } catch {
      // ignore
    }
  }

  // Inline style only applies on desktop. Below lg the sidebar uses
  // its natural full-width column layout (className on the outer).
  const desktopStyle = isDesktop
    ? { width: `${width}px`, flex: `0 0 ${width}px` as const }
    : undefined

  return (
    <div className={`relative ${className}`} style={desktopStyle}>
      {children}
      {/* Resize handle — only visible / usable from lg+.
          3.2.x: a clear, grabbable GRIP centered on the sidebar's left
          edge instead of a full-height hairline. This makes the resize
          affordance obvious AND scopes the drag to just the grip — the
          rest of the left edge (e.g. where the version reel overlaps
          the video/comments divider) is no longer a resize target, so
          dragging through the version thumbnails there never grabs the
          resizer. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize comments sidebar"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onDoubleClick={handleDoubleClick}
        className="hidden lg:flex absolute top-1/2 -translate-y-1/2 -left-2.5 w-5 h-20 z-30 cursor-ew-resize group items-center justify-center touch-none"
        title="Drag to resize • double-click to reset"
      >
        {/* Visible pill grip — thick enough to read as a drag handle.
            Brightens to the accent colour on hover and while dragging. */}
        <div
          className={`
            rounded-full ring-1 transition-all
            ${isDragging
              ? 'w-2 h-16 bg-primary ring-primary/50 shadow-[0_0_0_3px_hsl(var(--primary)/0.18)]'
              : 'w-1.5 h-12 bg-white/30 ring-white/10 group-hover:w-2 group-hover:h-16 group-hover:bg-primary/70 group-hover:ring-primary/40'}
          `}
        />
      </div>
    </div>
  )
}
