'use client'

import { useAuth } from '@/components/AuthProvider'
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import GlobalSearchOverlay from '@/components/GlobalSearchOverlay'

// 2.5.1+: routes where the global search pill is intentionally
// hidden. These are pure account / configuration screens — the
// search would surface project / video results that aren't relevant
// to anything visible on those pages, so removing the affordance
// keeps the topbar focused on the page's own controls.
const HIDE_SEARCH_ROUTES = ['/admin/settings', '/admin/profile']

/**
 * 2.5.0+ AdminTopBar — slim utility strip across the top of every
 * admin page.
 *
 * Three-zone layout, all vertically centered inside the bar:
 *
 *   ┌────────────────┬───────────────────────┬────────────────┐
 *   │  left slot     │   search (centered)   │   right slot   │
 *   │  (page title)  │   ⌘K / Ctrl+K         │   (page acts)  │
 *   └────────────────┴───────────────────────┴────────────────┘
 *
 * The left and right slots are empty DOM divs that pages fill in
 * via the `<TopbarLeftSlot>` / `<TopbarRightSlot>` portal
 * components (see `TopbarSlots.tsx`). The topbar itself only owns
 * the search field — page-specific titles and actions live with
 * the page so their handlers can read the page's React state
 * naturally.
 *
 * Visually the bar is a frosted-glass strip but WITHOUT the
 * hairline border the rest of the `.glass-pill` surfaces carry —
 * the 2.5.0 design call was to drop the delimiter between the
 * topbar and the page body so the spotlight wash bleeds through
 * uninterrupted. The view-mode / sort-mode toggles that used to
 * sit on the right have been pushed down into the page bodies
 * (Projects list / FolderBrowser) where they're scoped to the
 * content they actually control.
 */
export default function AdminTopBar() {
  const { user } = useAuth()
  const pathname = usePathname()
  const [searchOpen, setSearchOpen] = useState(false)

  // Hide on the literal route OR any nested child (e.g. a future
  // `/admin/settings/billing` would still suppress search).
  const hideSearch = HIDE_SEARCH_ROUTES.some(
    (r) => pathname === r || pathname?.startsWith(`${r}/`)
  )

  // 1.7.0+ kbd shortcut. Migrated from AdminHeader unchanged so the
  // muscle-memory of every existing user still works.
  useEffect(() => {
    if (!user) return
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [user])

  if (!user) return null

  return (
    <>
      <header
        className="sticky top-0 z-30 grid items-center gap-3 px-4 md:px-6 bg-transparent"
        style={{
          height: 'var(--topbar-height)',
          // 1fr | auto | 1fr — the two side columns each take half
          // of remaining space, which means the auto-sized centre
          // column is mathematically dead-centre regardless of how
          // wide the left and right slot CONTENT happens to be.
          gridTemplateColumns: '1fr auto 1fr',
        }}
      >
        {/* LEFT slot — page title / Back button. `min-w-0` lets the
            column shrink under a narrow viewport instead of pushing
            the centre off-axis. */}
        <div
          id="topbar-left-slot"
          className="flex items-center gap-3 min-w-0"
        />

        {/* 2.5.0+ responsive search. The breakpoint where text/kbd
            re-appear (`md` = 768px) matches the breakpoint at which
            the side-slot buttons (Back, Upload, Download All) expand
            from icon-only to text+icon, so the three groups expand
            and collapse in lockstep instead of stepping over each
            other in awkward in-between widths.
              < md   →  36×36 icon-only pill on every group
              ≥ md   →  full text everywhere, search caps at max-w-sm
            Sitting in the grid's `auto` centre column means the
            search is always truly centred to the page — never
            overlapping the side slots regardless of their widths. */}
        {hideSearch ? (
          // Placeholder span so the grid still has a centre column —
          // keeps the right slot pinned to its actual position
          // instead of collapsing to the middle when search is gone.
          <span aria-hidden />
        ) : (
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            // 2.5.1+: glass surface that matches `GlobalSearchOverlay`
            // — `bg-white/[0.06]` + `ring-1 ring-white/10` + the same
            // soft outward shadow. Now the idle pill reads as the same
            // family as the focused overlay it opens (no more "one
            // style idle, another on click").
            className="flex items-center justify-center gap-2 h-9 w-9 md:w-[260px] lg:w-[320px] md:max-w-sm md:justify-start md:px-3 rounded-lg bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] transition-colors text-sm text-white/55"
            aria-label="Search videos (⌘K)"
            title="Search videos (⌘K)"
          >
            <Search className="w-4 h-4 shrink-0" />
            <span className="hidden md:inline truncate flex-1 text-left">
              Search videos, folders…
            </span>
            <kbd className="hidden md:inline-flex items-center gap-0.5 px-1.5 h-5 rounded bg-white/[0.08] ring-1 ring-white/10 text-[10px] font-mono text-white/70">
              <span>⌘</span>
              <span>K</span>
            </kbd>
          </button>
        )}

        {/* RIGHT slot — page actions (Upload, Download, kebab, etc.).
            Justified to the end of the right grid column. `min-w-0`
            lets long combinations of buttons shrink/wrap instead of
            forcing the grid to overflow. */}
        <div
          id="topbar-right-slot"
          className="flex items-center justify-end gap-2 min-w-0"
        />
      </header>

      <GlobalSearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </>
  )
}
