'use client'

import { ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 2.5.0+ Topbar slot system.
 *
 * The shared `AdminTopBar` renders the search field in the centre
 * and reserves two transparent slots — one to its LEFT (for the
 * current page's title block) and one to its RIGHT (for the page's
 * primary actions). Pages opt in to filling those slots by simply
 * rendering `<TopbarLeftSlot>` / `<TopbarRightSlot>` somewhere in
 * their JSX; the children are portalled into the correct DOM node
 * inside the topbar.
 *
 * Why portals (rather than a `setTopbarConfig({left, right})`
 * context):
 *
 *   - Children stay live React subtrees inside the *page*, so
 *     state-bound handlers (e.g. `openNewProjectModal` which reads
 *     `useState` from the page component) work naturally without
 *     stale-closure traps in `useEffect` deps.
 *   - No need to manually clear slots on unmount — when a page
 *     navigates away its subtree is torn down and React removes
 *     the portalled nodes for us.
 *
 * If the topbar's slot DOM nodes don't exist yet (e.g. the share
 * player route hides the chrome entirely), the components render
 * nothing — a no-op fallback rather than an error.
 */

function useSlotTarget(slotId: string) {
  // 3.5.x: resolve the slot node SYNCHRONOUSLY on the first render via a
  // lazy initializer instead of waiting for a post-mount useEffect. The
  // layout's <AdminTopBar> is persistent and sits above every page, so
  // the slot div already exists in the DOM whenever a page (re)mounts —
  // including on client navigation into/out of a folder. The old
  // useEffect-only lookup left the portal target null for one render, so
  // the page's Back / view-toggle / upload / download buttons blinked
  // out and back in on every navigation (the search pill + bell didn't,
  // because they live in the persistent topbar, not these portals).
  // Resolving up-front means the portal content is present on the very
  // first paint of the new page — no empty frame, no flicker.
  const [target, setTarget] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' ? document.getElementById(slotId) : null,
  )
  useEffect(() => {
    // Safety net: re-resolve in case the node wasn't in the DOM yet at
    // the very first render (e.g. first paint before the layout mounted).
    const el = document.getElementById(slotId)
    setTarget((prev) => (prev === el ? prev : el))
  }, [slotId])
  return target
}

export function TopbarLeftSlot({ children }: { children: ReactNode }) {
  const target = useSlotTarget('topbar-left-slot')
  if (!target) return null
  return createPortal(children, target)
}

export function TopbarRightSlot({ children }: { children: ReactNode }) {
  const target = useSlotTarget('topbar-right-slot')
  if (!target) return null
  return createPortal(children, target)
}
