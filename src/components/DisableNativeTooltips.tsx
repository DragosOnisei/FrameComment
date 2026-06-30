'use client'

import { useEffect } from 'react'

/**
 * 3.5.x: app-wide kill-switch for the browser's native hover tooltips.
 *
 * Hundreds of elements across the app carry a `title` attribute (buttons,
 * cards, icons, truncated filenames, …). The browser shows that text as a
 * little OS tooltip after the cursor rests on the element for ~0.5s, which
 * the team found noisy — e.g. the long "…_916_v3.mp4" filename popping up
 * over a video card.
 *
 * There's no CSS to disable native tooltips, and stripping `title` from 245
 * call sites by hand would be brittle. Instead we strip the attribute at
 * runtime: once on mount, then via a MutationObserver as React (re)renders
 * add or update nodes. `aria-label` is left untouched, so screen-reader
 * accessibility is preserved — only the visible tooltip goes away.
 *
 * Removing a `title` is itself an attribute mutation, but the observer
 * no-ops the second time (the attribute is already gone), so there's no
 * loop. We watch only the `title` attribute, so the 60fps style updates in
 * the video player never wake this up.
 */
export default function DisableNativeTooltips() {
  useEffect(() => {
    const stripFrom = (node: Node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const el = node as Element
      if (el.hasAttribute('title')) el.removeAttribute('title')
      el.querySelectorAll?.('[title]').forEach((child) =>
        child.removeAttribute('title'),
      )
    }

    // Initial sweep of everything already in the DOM.
    stripFrom(document.body)

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          const el = m.target as Element
          if (el.hasAttribute('title')) el.removeAttribute('title')
        } else if (m.type === 'childList') {
          m.addedNodes.forEach(stripFrom)
        }
      }
    })

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    })

    return () => observer.disconnect()
  }, [])

  return null
}
