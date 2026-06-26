'use client'

import { AuthProvider } from '@/components/AuthProvider'
import AdminSidebar from '@/components/AdminSidebar'
import AdminTopBar from '@/components/AdminTopBar'
import SessionMonitor from '@/components/SessionMonitor'
import { DownloadManagerProvider } from '@/contexts/DownloadManager'
import { NotificationsProvider } from '@/contexts/NotificationsContext'
import { DownloadBanners } from '@/components/DownloadBanners'
import { ProcessingStatusProvider } from '@/contexts/ProcessingStatusContext'
import { ProcessingStatusBanners } from '@/components/ProcessingStatusBanners'
import { GlobalDropOverlay } from '@/components/GlobalDropOverlay'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'

/**
 * 2.5.0+ Admin layout — sidebar + topbar shell.
 *
 * Replaces the legacy single-row AdminHeader with a two-axis shell:
 *
 *   ┌─────────┬────────────────────────────────────────┐
 *   │         │ AdminTopBar (search + view toggles)    │
 *   │  Side   ├────────────────────────────────────────┤
 *   │  bar    │                                        │
 *   │  (nav   │  page content (children)               │
 *   │  + user)│                                        │
 *   └─────────┴────────────────────────────────────────┘
 *
 * The whole shell sits inside `.spotlight-bg` so the soft blue wash
 * in the top-left corner bleeds across every page consistently.
 *
 * The share-player route (`/admin/projects/<id>/share/...`) still
 * hides BOTH the sidebar and the topbar — that view is meant to
 * look identical to the public share page so admins can preview
 * the client experience without UI noise.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const hidesChrome = !!pathname?.match(/^\/admin\/projects\/[^/]+\/share/)
  // 2.2.6+: same predicate as `hidesChrome` — when the admin is in
  // the player view, the floating Processing (uploads + encoding)
  // banner overlaps the "Leave your comment" input and the rest of
  // the player chrome in the bottom strip. The user can still
  // check encoding progress from Settings; we just stop rendering
  // the banner here. DownloadBanners stays visible — an admin
  // mid-download of a 5 GB zip needs to keep an eye on it even
  // while reviewing a clip.
  const hideFloatingBanners = hidesChrome

  // 2.5.0+ legacy CSS variable bookkeeping. Components that
  // sized themselves against `--admin-header-height` still work —
  // we set it to the topbar height when the chrome is visible,
  // 0 when it's hidden. New code should use `--topbar-height`
  // directly.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--admin-header-height',
      hidesChrome ? '0px' : 'var(--topbar-height)',
    )
  }, [hidesChrome])

  // Prevent caching of admin pages.
  useEffect(() => {
    const metaCache = document.querySelector('meta[http-equiv="Cache-Control"]')
    if (!metaCache) {
      const meta = document.createElement('meta')
      meta.httpEquiv = 'Cache-Control'
      meta.content = 'no-store, no-cache, must-revalidate, private'
      document.head.appendChild(meta)

      const metaPragma = document.createElement('meta')
      metaPragma.httpEquiv = 'Pragma'
      metaPragma.content = 'no-cache'
      document.head.appendChild(metaPragma)

      const metaExpires = document.createElement('meta')
      metaExpires.httpEquiv = 'Expires'
      metaExpires.content = '0'
      document.head.appendChild(metaExpires)
    }
  }, [])

  // 3.2.0+: Hoist AuthProvider + DownloadManager + ProcessingStatus
  // OUT of the `if (hidesChrome) {...}` / `return (...)` split so they
  // stay mounted across navigations between chromed pages (Projects,
  // Settings, etc.) and the chrome-less share-player view.
  //
  // The old structure returned different React element trees from
  // each branch — both started with `<AuthProvider>`, but because the
  // children differed structurally, React's reconciler treated them
  // as separate component instances and remounted AuthProvider on
  // every chrome ↔ no-chrome transition. The fresh AuthProvider would
  // start at `loading=true`, paint its placeholder, then resolve a
  // moment later. The user saw that placeholder as a "Loading…" flash
  // every time they double-clicked a video in the grid to navigate
  // into the player.
  //
  // Now there's exactly one Provider stack, mounted once on first
  // admin route. Only the inner chrome (sidebar + topbar + main vs.
  // bare children) flips based on `hidesChrome`.
  return (
    <AuthProvider requireAuth={true}>
      <NotificationsProvider>
      <DownloadManagerProvider>
        <ProcessingStatusProvider>
          {hidesChrome ? (
            // Share-player preview: no sidebar, no topbar — render
            // children straight onto the background. Preserves the
            // existing behaviour exactly.
            <div className="flex flex-1 min-h-0 bg-background flex-col overflow-x-hidden">
              <div className="flex-1 min-h-0 flex flex-col">
                {children}
              </div>
              <SessionMonitor />
              <DownloadBanners />
              <GlobalDropOverlay />
            </div>
          ) : (
            // Chromed pages: sidebar + topbar + main.
            // 2.5.0 (revised): `.spotlight-bg` already carries the
            // base background-color (so removing the duplicate
            // `bg-background` lets the gradient paint uninterrupted).
            // Inner pages drop their own `bg-background` wrappers too
            // so the wash bleeds across the dashboard area to bottom-
            // right.
            <div className="spotlight-bg flex flex-1 min-h-0 overflow-x-hidden select-none">
              <AdminSidebar />
              <div className="flex-1 min-w-0 flex flex-col">
                <AdminTopBar />
                <main className="flex-1 min-h-0 flex flex-col">
                  {children}
                </main>
              </div>
              <SessionMonitor />
              <DownloadBanners />
              {!hideFloatingBanners && <ProcessingStatusBanners />}
              <GlobalDropOverlay />
            </div>
          )}
        </ProcessingStatusProvider>
      </DownloadManagerProvider>
      </NotificationsProvider>
    </AuthProvider>
  )
}
