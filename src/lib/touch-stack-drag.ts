/**
 * 7.13.0: the rules of the touch "layering" gesture, kept pure.
 *
 * On a desktop you stack one video onto another — make it the next version —
 * by dragging its card with the mouse: HTML5 drag and drop. Phones have no
 * such thing: a finger on a card either taps it or scrolls the grid, and the
 * `dragstart` event never fires. So the grid gets a second, touch-only way in
 * (src/lib/use-touch-stack-drag.ts): hold a card until it lifts, it sticks to
 * the finger, the card under the finger lights up, lift the finger and the
 * held video becomes a new version of it. These helpers decide the few
 * things the hook has to get exactly right, and a script exercises them.
 */

/** Hold this long without moving and the card lifts. */
export const LONG_PRESS_MS = 400
/** Moving further than this before the hold completes is a scroll, not a hold. */
export const MOVE_CANCEL_PX = 10
/** Within this many px of the top/bottom edge the grid scrolls itself. */
export const EDGE_SCROLL_PX = 72
/** Fastest self-scroll, px per frame, right at the edge. */
export const EDGE_SCROLL_MAX_PX = 18

export interface Point {
  x: number
  y: number
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** A pending hold is abandoned once the finger has wandered — that is a scroll. */
export function shouldCancelPendingPress(start: Point, now: Point): boolean {
  return distance(start, now) > MOVE_CANCEL_PX
}

/**
 * How fast the grid should scroll itself while the finger sits near an edge:
 * negative = up, positive = down, 0 = not near an edge. Proportional, so a
 * finger just inside the band nudges and a finger at the very edge flies.
 */
export function edgeScrollSpeed(y: number, viewportHeight: number): number {
  if (viewportHeight <= 0) return 0
  if (y < EDGE_SCROLL_PX) {
    const depth = (EDGE_SCROLL_PX - Math.max(0, y)) / EDGE_SCROLL_PX
    return -Math.ceil(depth * EDGE_SCROLL_MAX_PX)
  }
  const fromBottom = viewportHeight - y
  if (fromBottom < EDGE_SCROLL_PX) {
    const depth = (EDGE_SCROLL_PX - Math.max(0, fromBottom)) / EDGE_SCROLL_PX
    return Math.ceil(depth * EDGE_SCROLL_MAX_PX)
  }
  return 0
}

/**
 * The video card under the finger, as a stack target: the nearest ancestor
 * carrying `data-video-id`, unless it is the held card itself (or one of the
 * cards travelling with it in a multi-selection — the caller passes those).
 */
export function resolveTouchStackTarget(
  elementAtPoint: Element | null,
  sourceId: string,
  travelling: ReadonlySet<string> = new Set(),
): string | null {
  const card = elementAtPoint?.closest?.('[data-video-id]') as HTMLElement | null | undefined
  if (!card) return null
  const id = card.getAttribute('data-video-id')
  if (!id || id === sourceId || travelling.has(id)) return null
  return id
}

/** A touch that begins on a control inside the card is that control's, not a hold. */
export function isTouchOnControl(target: Element | null): boolean {
  return !!target?.closest?.('button, a, input, textarea, select, [role="menu"], [role="menuitem"]')
}
