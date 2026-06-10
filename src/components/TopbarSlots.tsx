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
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    // Look up the DOM node on mount. Because the layout's
    // <AdminTopBar> sits above this page in the React tree, the
    // div with the slot id is guaranteed to be present in the DOM
    // by the time this effect runs. If a future layout decides to
    // hide the topbar (share player view), the lookup returns
    // null and we render nothing.
    setTarget(document.getElementById(slotId))
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
