'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LONG_PRESS_MS,
  edgeScrollSpeed,
  isTouchOnControl,
  resolveTouchStackTarget,
  shouldCancelPendingPress,
  type Point,
} from '@/lib/touch-stack-drag'

export interface TouchStackGhost {
  /** Finger position, viewport px. */
  x: number
  y: number
  /** The held card's thumbnail, if it has one. */
  src: string | null
}

export interface TouchStackDragState {
  /** The card being held, once the hold has completed. */
  sourceId: string | null
  /** The card under the finger that would receive the drop. */
  targetId: string | null
  ghost: TouchStackGhost | null
}

export interface TouchStackDragOptions {
  enabled: boolean
  /** Cards that move together with the held one (a multi-selection). */
  travelling?: ReadonlySet<string>
  onStart?: (sourceId: string) => void
  onEnd?: () => void
  onStack: (sourceId: string, targetId: string) => void
}

const IDLE: TouchStackDragState = { sourceId: null, targetId: null, ghost: null }

function scrollParentOf(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/**
 * 7.13.0: hold-to-lift stacking for touch screens. See touch-stack-drag.ts
 * for the why. The gesture:
 *
 *   1. finger down on a card → a 400 ms timer starts; any real movement
 *      before it fires cancels the hold and the page scrolls as usual;
 *   2. the timer fires → the card "lifts": `onStart` (the grid dims the
 *      source), a ghost of its thumbnail follows the finger, scrolling is
 *      suppressed for the rest of the touch, and near the top or bottom edge
 *      the grid scrolls itself so far lists are reachable;
 *   3. the card under the finger is reported as `targetId` (the grid lights
 *      it up); lifting the finger over one calls `onStack(source, target)`,
 *      lifting anywhere else just cancels.
 *
 * Mouse users never enter here — touch events do not fire for a mouse — so
 * the desktop drag and drop is untouched. Listeners are native rather than
 * React props because React registers touch handlers as passive, and a
 * passive `touchmove` cannot stop the page from scrolling under the held
 * card.
 */
export function useTouchStackDrag(
  opts: TouchStackDragOptions,
): TouchStackDragState & { ref: (el: HTMLElement | null) => void } {
  const [state, setState] = useState<TouchStackDragState>(IDLE)
  // The grid element arrives through a callback ref held in STATE, not a
  // RefObject: the grid is rendered conditionally (not while loading, not in
  // table view), so a RefObject is still null when the effect first runs and
  // nothing would ever rebind — which is exactly how the first cut of this
  // hook attached to nothing. A state change re-runs the effect when the
  // grid mounts, and clears the listeners when it unmounts.
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })

  useEffect(() => {
    if (!container || !opts.enabled) return

    type Pending = { id: string; touchId: number; start: Point; timer: ReturnType<typeof setTimeout>; card: HTMLElement }
    type Active = { id: string; touchId: number; last: Point; targetId: string | null; src: string | null; frame: number | null }
    let pending: Pending | null = null
    let active: Active | null = null

    const scrollParent = scrollParentOf(container)

    const publish = () => {
      if (!active) {
        setState(IDLE)
        return
      }
      setState({
        sourceId: active.id,
        targetId: active.targetId,
        ghost: { x: active.last.x, y: active.last.y, src: active.src },
      })
    }

    const findTouch = (list: TouchList, touchId: number): Touch | null => {
      for (let i = 0; i < list.length; i++) if (list[i].identifier === touchId) return list[i]
      return null
    }

    const hitTest = () => {
      if (!active) return
      const el = document.elementFromPoint(active.last.x, active.last.y)
      active.targetId = resolveTouchStackTarget(el, active.id, optsRef.current.travelling)
    }

    const stopEdgeScroll = () => {
      if (active?.frame != null) {
        cancelAnimationFrame(active.frame)
        active.frame = null
      }
    }

    const edgeScrollTick = () => {
      if (!active) return
      active.frame = null
      const speed = edgeScrollSpeed(active.last.y, window.innerHeight)
      if (speed === 0) return
      scrollParent.scrollBy(0, speed)
      hitTest()
      publish()
      active.frame = requestAnimationFrame(edgeScrollTick)
    }

    const clearPending = () => {
      if (pending) clearTimeout(pending.timer)
      pending = null
    }

    const finish = (dropped: boolean) => {
      if (!active) return
      stopEdgeScroll()
      const { id, targetId } = active
      active = null
      publish()
      optsRef.current.onEnd?.()
      if (dropped && targetId) optsRef.current.onStack(id, targetId)
    }

    const onTouchStart = (e: TouchEvent) => {
      if (active) {
        // A second finger while holding: nothing sensible to do with it.
        return
      }
      if (e.touches.length !== 1) {
        clearPending()
        return
      }
      const touch = e.touches[0]
      const target = e.target as Element | null
      if (isTouchOnControl(target)) return
      const card = target?.closest?.('[data-video-id]') as HTMLElement | null
      if (!card) return
      const id = card.getAttribute('data-video-id')
      if (!id) return
      clearPending()
      const start = { x: touch.clientX, y: touch.clientY }
      const timer = setTimeout(() => {
        if (!pending || pending.timer !== timer) return
        const img = pending.card.querySelector('img')
        active = {
          id: pending.id,
          touchId: pending.touchId,
          last: pending.start,
          targetId: null,
          src: img?.getAttribute('src') ?? null,
          frame: null,
        }
        pending = null
        try {
          navigator.vibrate?.(12)
        } catch {
          /* not every browser has it */
        }
        optsRef.current.onStart?.(active.id)
        hitTest()
        publish()
      }, LONG_PRESS_MS)
      pending = { id, touchId: touch.identifier, start, timer, card }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (pending) {
        const touch = findTouch(e.touches, pending.touchId)
        if (!touch || shouldCancelPendingPress(pending.start, { x: touch.clientX, y: touch.clientY })) {
          clearPending()
        }
        return
      }
      if (!active) return
      const touch = findTouch(e.touches, active.touchId)
      if (!touch) return
      // The held card must not scroll away under the finger.
      e.preventDefault()
      active.last = { x: touch.clientX, y: touch.clientY }
      hitTest()
      publish()
      if (edgeScrollSpeed(active.last.y, window.innerHeight) !== 0) {
        if (active.frame == null) active.frame = requestAnimationFrame(edgeScrollTick)
      } else {
        stopEdgeScroll()
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (pending) {
        clearPending()
        return
      }
      if (!active) return
      if (findTouch(e.touches, active.touchId)) return // another finger lifted
      // No click may follow a completed hold — a tap it was not.
      e.preventDefault()
      finish(e.type === 'touchend')
    }

    const onContextMenu = (e: Event) => {
      // Android raises the context menu on a long press; the hold owns it.
      if (pending || active) e.preventDefault()
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: false })
    container.addEventListener('touchcancel', onTouchEnd, { passive: false })
    container.addEventListener('contextmenu', onContextMenu)
    return () => {
      clearPending()
      if (active) {
        stopEdgeScroll()
        active = null
        optsRef.current.onEnd?.()
      }
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      container.removeEventListener('contextmenu', onContextMenu)
    }
    // The grid element and the enabled flag are the only inputs that should
    // rebind; everything else is read through optsRef at event time.
  }, [container, opts.enabled])

  return { ...state, ref: setContainer }
}
