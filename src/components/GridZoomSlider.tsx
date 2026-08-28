'use client'

import { useEffect, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import {
  GRID_ZOOM_CHANGED_EVENT,
  GRID_ZOOM_MAX_LEVEL,
  getGridZoom,
  setGridZoom,
  type GridZoomLevel,
} from '@/lib/grid-zoom'

/**
 * 7.4.0 — the thumbnail size control, bottom left.
 *
 * Floating rather than in the toolbar, because it belongs to the grid you are
 * looking at rather than to the actions above it, and because you reach for it
 * while scrolling through a folder — a control that scrolls away is a control
 * you stop using.
 *
 * Hidden below `sm`. On a phone the screen decides how many cards fit and a
 * five-step zoom is a fiddly target next to content you are trying to scroll;
 * the grid keeps its two columns there.
 */
export function useGridZoomLevel(): GridZoomLevel {
  // Starts at the default and corrects itself after mount. Reading
  // localStorage during render would make the server and the client disagree
  // on the first paint, which React reports as a hydration error.
  const [level, setLevel] = useState<GridZoomLevel>(0)

  useEffect(() => {
    setLevel(getGridZoom())
    const onChange = (e: Event) => {
      const next = (e as CustomEvent).detail?.level
      if (typeof next === 'number') setLevel(next as GridZoomLevel)
    }
    // `storage` covers another tab; the custom event covers this one, which
    // never fires `storage` for its own writes.
    const onStorage = () => setLevel(getGridZoom())
    window.addEventListener(GRID_ZOOM_CHANGED_EVENT, onChange as EventListener)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(GRID_ZOOM_CHANGED_EVENT, onChange as EventListener)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return level
}

export default function GridZoomSlider() {
  const level = useGridZoomLevel()
  const max = GRID_ZOOM_MAX_LEVEL

  return (
    <div
      /**
       * Sat over the sidebar before: `left-4` is the left of the VIEWPORT, and
       * the sidebar owns the first 17rem of it. Offset past it from `md` up,
       * which is exactly where AdminSidebar stops being hidden — below that
       * the content starts at the edge and so does this.
       */
      style={{ left: 'var(--grid-zoom-left, 1rem)' }}
      className="
        grid-zoom-slider
        hidden sm:flex fixed bottom-4 z-40 items-center gap-2.5
        rounded-full px-3 py-2
        bg-white/[0.06] ring-1 ring-white/10 backdrop-blur-md
        shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]
      "
    >
      {/* Small icon at the small end, large at the large end — the direction of
          the gesture is then obvious without a label. */}
      <LayoutGrid className="h-3 w-3 shrink-0 text-white/45" aria-hidden />
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={level}
        onChange={(e) => setGridZoom(Number(e.target.value))}
        aria-label="Thumbnail size"
        title="Thumbnail size"
        className="grid-zoom-range h-1 w-24 cursor-ew-resize appearance-none rounded-full bg-white/15 outline-none"
      />
      <LayoutGrid className="h-4 w-4 shrink-0 text-white/45" aria-hidden />
    </div>
  )
}
