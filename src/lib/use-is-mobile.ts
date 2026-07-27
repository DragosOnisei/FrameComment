'use client'

import { useEffect, useState } from 'react'

/**
 * 4.x: true below Tailwind's `md` (768px) — i.e. phones, where the sidebar is
 * hidden and the mobile top-bar layout applies. Used to force the admin grid
 * view on phones (the list/table view is desktop-only) and to hide controls
 * that don't belong on a phone.
 *
 * Lazy initializer resolves synchronously on the client's first render so
 * there's no grid↔table flash on load; a `change` listener keeps it live on
 * rotation / resize. SSR-safe (defaults to false on the server).
 */
export function useIsMobile(query = '(max-width: 767px)'): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const update = () => setIsMobile(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [query])
  return isMobile
}
