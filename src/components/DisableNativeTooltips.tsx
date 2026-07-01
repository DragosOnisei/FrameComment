'use client'

import { useEffect } from 'react'

/**
 * 3.6.x: app-wide kill-switch for the browser's native hover tooltips.
 *
 * Hundreds of elements across the app carry a `title` attribute (buttons,
 * cards, icons, truncated filenames, …). The browser shows that text as a
 * little OS tooltip after the cursor rests on the element for ~0.5s, which
 * the team found noisy — e.g. the long "…_916_v3.mp4" filename popping up
 * over a video card.
 *
 * There's no CSS to disable native tooltips. We strip the attribute at
 * runtime, but ONLY on hover: a capture-phase `mouseover` listener removes
 * the `title` from whatever the cursor just entered. Because the OS waits
 * ~0.5s before showing the tooltip, removing the attribute the instant the
 * pointer arrives reliably suppresses it — with none of the downsides of
 * the earlier approach:
 *
 *   - An initial DOM sweep / MutationObserver ran during React's
 *     (concurrent) hydration and stripped `title`s out of the server HTML
 *     before deeper components hydrated, tripping hydration mismatches
 *     (e.g. the login page's PasswordInput toggle). `mouseover` only fires
 *     on real user interaction, always well after hydration, so the DOM
 *     React hydrates against is never touched.
 *   - `aria-label` is left intact, so screen-reader accessibility is
 *     preserved — only the visible tooltip goes away.
 */
export default function DisableNativeTooltips() {
  useEffect(() => {
    const onPointerOver = (e: Event) => {
      const target = e.target as Element | null
      const el = target?.closest?.('[title]')
      if (el && el.hasAttribute('title')) el.removeAttribute('title')
    }
    // Capture phase so we strip the attribute before the element's own
    // handlers run and before the OS tooltip timer matters.
    document.addEventListener('mouseover', onPointerOver, true)
    return () => document.removeEventListener('mouseover', onPointerOver, true)
  }, [])

  return null
}
