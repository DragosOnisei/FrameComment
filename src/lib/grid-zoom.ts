/**
 * 7.4.0 — how big the cards are in every grid, as one shared setting.
 *
 * The grids were fixed column counts per breakpoint — six across on a wide
 * screen — which is the right density for scanning a big folder and too small
 * for looking at what is actually in the frames. This is the zoom control that
 * every asset manager has, and it belongs to the person, not the page: the size
 * you like for thumbnails is the size you like everywhere, so the projects
 * dashboard and the folder browser read the same value.
 *
 * Module scope plus a window event rather than React state, for the same reason
 * `comment-range-edit.ts` is: two components on different pages need the same
 * answer, and neither owns the other. Persisted per browser, because it is a
 * preference about a screen rather than about the work.
 *
 * The steps are MINIMUM card widths handed to `repeat(auto-fill, minmax(…))`.
 * A minimum rather than a count keeps the layout responsive for free — the
 * browser fits as many as it can at that size, so the same setting behaves
 * sensibly on a laptop and on a 32-inch display, which a hardcoded column count
 * never does.
 */
/**
 * Three levels: as-is, one step bigger, two steps bigger.
 *
 * The first draft handed CSS a minimum card WIDTH and let auto-fill decide the
 * count. That reads well in the abstract and fails in the hand: at any given
 * window two adjacent widths can round to the same number of columns, so a
 * step of the slider changed nothing. Dragos hit it immediately — at his window
 * the top two steps were both two columns, and the last move did nothing at
 * all.
 *
 * So a level is now a number of columns SUBTRACTED from whatever the layout
 * would otherwise use at that breakpoint. Every step is guaranteed to change
 * the grid, at every window size, which is the only property that matters for
 * a control you drag and watch. Level 0 subtracts nothing and is therefore
 * exactly what the app has always rendered.
 *
 * The counts live in globals.css, because they have to vary per breakpoint and
 * a media query is the only thing that can do that.
 */
export const GRID_ZOOM_MAX_LEVEL = 2

/** 0 = as the app has always looked. 1 and 2 each remove one column. */
export type GridZoomLevel = 0 | 1 | 2

const STORAGE_KEY = 'framecomment:gridZoom'
export const GRID_ZOOM_CHANGED_EVENT = 'gridZoom:changed'

const DEFAULT_LEVEL: GridZoomLevel = 0

function clamp(n: number): GridZoomLevel {
  if (!Number.isFinite(n)) return DEFAULT_LEVEL
  const i = Math.round(n)
  if (i < 0) return 0
  if (i > GRID_ZOOM_MAX_LEVEL) return GRID_ZOOM_MAX_LEVEL as GridZoomLevel
  return i as GridZoomLevel
}

export function getGridZoom(): GridZoomLevel {
  if (typeof window === 'undefined') return DEFAULT_LEVEL
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === null ? DEFAULT_LEVEL : clamp(Number(raw))
  } catch {
    // Private mode, or storage disabled. The default is a perfectly good answer.
    return DEFAULT_LEVEL
  }
}

export function setGridZoom(level: number): void {
  if (typeof window === 'undefined') return
  const next = clamp(level)
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    /* Not being able to remember it must not stop it applying now. */
  }
  window.dispatchEvent(
    new CustomEvent(GRID_ZOOM_CHANGED_EVENT, { detail: { level: next } }),
  )
}

/**
 * The value for the grid's `data-zoom` attribute. `null` at level 0 so the
 * attribute is absent entirely and the element keeps its own Tailwind columns —
 * nothing to override, nothing that can drift from the default.
 */
export function gridZoomAttr(level: GridZoomLevel): string | undefined {
  return level > 0 ? String(level) : undefined
}
