'use client'

import { useAuth } from '@/components/AuthProvider'
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import GlobalSearchOverlay from '@/components/GlobalSearchOverlay'
import NotificationBell from '@/components/NotificationBell'
import TopbarAccountMenu from '@/components/TopbarAccountMenu'

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
        className="sticky top-0 z-30 grid grid-cols-[1fr_auto_1fr] items-center gap-2 md:gap-3 px-4 md:px-6 bg-transparent"
        style={{
          // Always a 1fr | auto | 1fr grid so the CENTRE column is dead-centre.
          // Below `md` (sidebar hidden) the bar is a clean, CONSISTENT row on
          // every page: search (left) · FrameComment logo (centre, a home
          // button) · bell + avatar (right). The page-specific actions and the
          // page title drop to the band below. At `md`+ the sidebar owns nav,
          // so the centre column holds the search pill and the left column the
          // page title. Exactly three children are visible per breakpoint (the
          // logo is `md:hidden`, the desktop title slot is `hidden md:flex`), so
          // the grid never wraps.
          height: 'var(--topbar-height)',
        }}
      >
        {/* LEFT column — page Back / title, in the bar on EVERY breakpoint so
            the Back icon is reachable on phones too (col 1). */}
        <div
          id="topbar-left-slot"
          className="flex items-center gap-3 min-w-0"
        />

        {/* CENTRE column, DESKTOP only: the search pill. On phones search moves
            to the right group and the logo takes the centre. `hideSearch` pages
            render an empty desktop placeholder so the columns stay aligned. */}
        {hideSearch ? (
          <span aria-hidden className="hidden md:block" />
        ) : (
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden md:flex items-center justify-start gap-2 h-9 w-[260px] lg:w-[320px] max-w-sm px-3 rounded-lg bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] transition-colors text-sm text-white/55"
            aria-label="Search videos (⌘K)"
            title="Search videos (⌘K)"
          >
            <Search className="w-4 h-4 shrink-0" />
            <span className="truncate flex-1 text-left">
              Search videos, folders…
            </span>
            <kbd className="inline-flex items-center gap-0.5 px-1.5 h-5 rounded bg-white/[0.08] ring-1 ring-white/10 text-[10px] font-mono text-white/70">
              <span>⌘</span>
              <span>K</span>
            </kbd>
          </button>
        )}

        {/* 4.x: centred FrameComment mark — CENTRE column, phones only (< md).
            A real grid item (not absolute) so it's genuinely centred and never
            overlaps the buttons. Doubles as a HOME button — the reliable way
            back to the dashboard when the sidebar is hidden (e.g. stuck on the
            Profile page). Not shown in the video player (chrome hidden there). */}
        <Link
          href="/admin/projects"
          aria-label="Home"
          title="Home"
          className="md:hidden justify-self-center flex items-center justify-center h-9 w-9"
        >
          {/* Inlined FrameComment mark (play glyph + "i") so we can force the
              i-stem WHITE — the shared /icon.svg flips it to a dark colour on a
              light OS theme, which vanished on the dark bar. A soft drop-shadow
              lifts it off the transparent top bar so it stands out. */}
          <svg
            viewBox="0 0 64 64"
            aria-hidden="true"
            className="h-7 w-7 drop-shadow-[0_2px_7px_rgba(0,0,0,0.7)]"
          >
            <path
              d="M 14 16 C 14 13 16 12 18 13 L 41 30 C 43 31 43 33 41 34 L 18 51 C 16 52 14 51 14 48 Z"
              fill="hsl(211 100% 50%)"
            />
            <circle cx="51" cy="20" r="4.5" fill="hsl(211 100% 50%)" />
            <rect x="46.5" y="28" width="9" height="22" rx="4.5" fill="#ffffff" />
          </svg>
        </Link>

        {/* RIGHT column (col 3). Phones: search icon + bell + avatar (search
            sits just before the bell, per the mobile layout). Desktop: the page
            actions portal + bell. */}
        <div className="flex items-center justify-end gap-2 min-w-0">
          {/* Page-specific actions — DESKTOP topbar only; on phones they render
              in the band below via the mobile portal target. */}
          <div
            id="topbar-right-slot"
            className="hidden md:flex items-center justify-end gap-2 min-w-0"
          />
          {/* Phone search — a plain icon just before the bell. */}
          {!hideSearch && (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="md:hidden flex items-center justify-center h-9 w-9 rounded-lg bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] transition-colors text-white/60 hover:text-white"
              aria-label="Search videos"
              title="Search videos"
            >
              <Search className="w-4 h-4" />
            </button>
          )}
          {/* 3.5.0+: live bell — top-right. */}
          <NotificationBell />
          {/* 4.x: account avatar → Profile / Settings / Users / Trash / Sign
              out. Phones only (< md) — on desktop the sidebar owns this menu. */}
          <TopbarAccountMenu />
        </div>
      </header>

      {/* 4.x PHONE-ONLY band below the bar for the page's remaining actions
          (view / upload / download are hidden on phones; sort / add-user / Save
          still surface here). The title + Back live in the bar itself now.
          Portalled from each page's <TopbarRightSlot> (desktop → the bar,
          phone → here). */}
      <div className="md:hidden px-4">
        <div
          id="topbar-right-slot-mobile"
          className="empty:hidden flex items-center justify-end gap-2 pt-1 pb-2"
        />
      </div>

      <GlobalSearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </>
  )
}
