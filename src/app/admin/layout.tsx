'use client'

import { AuthProvider } from '@/components/AuthProvider'
import AdminHeader from '@/components/AdminHeader'
import SessionMonitor from '@/components/SessionMonitor'
import { DownloadManagerProvider } from '@/contexts/DownloadManager'
import { DownloadBanners } from '@/components/DownloadBanners'
import { ProcessingStatusProvider } from '@/contexts/ProcessingStatusContext'
import { ProcessingStatusBanners } from '@/components/ProcessingStatusBanners'
import { GlobalDropOverlay } from '@/components/GlobalDropOverlay'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const headerRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const hideHeader = pathname?.match(/^\/admin\/projects\/[^/]+\/share/)
  // 2.2.6+: same predicate as `hideHeader` — when the admin is in
  // the player view, the floating Processing (uploads + encoding)
  // banner overlaps the "Leave your comment" input and the rest of
  // the player chrome in the bottom strip. The user can still
  // check encoding progress from Settings; we just stop rendering
  // the banner here. DownloadBanners stays visible — an admin
  // mid-download of a 5 GB zip needs to keep an eye on it even
  // while reviewing a clip. Folder browser and project dashboard
  // keep everything as before.
  const hideFloatingBanners = !!hideHeader

  // Prevent caching of admin pages
  useEffect(() => {
    // Set cache control headers via meta tags as fallback
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

  // Allow components (e.g. share sidebar) to size to viewport minus header.
  useEffect(() => {
    if (hideHeader) {
      document.documentElement.style.setProperty('--admin-header-height', '0px')
      return
    }

    const headerEl = headerRef.current
    if (!headerEl) return

    const update = () => {
      document.documentElement.style.setProperty('--admin-header-height', `${headerEl.offsetHeight}px`)
    }

    update()

    const observer = new ResizeObserver(() => update())
    observer.observe(headerEl)

    return () => {
      observer.disconnect()
      document.documentElement.style.setProperty('--admin-header-height', '0px')
    }
  }, [hideHeader])

  return (
    <AuthProvider requireAuth={true}>
      <DownloadManagerProvider>
        <ProcessingStatusProvider>
          <div className="flex flex-1 min-h-0 bg-background flex-col overflow-x-hidden">
            {!hideHeader && (
              <div ref={headerRef}>
                <AdminHeader />
              </div>
            )}
            <div className="flex-1 min-h-0 flex flex-col">
              {children}
            </div>
            <SessionMonitor />
            <DownloadBanners />
            {!hideFloatingBanners && <ProcessingStatusBanners />}
            <GlobalDropOverlay />
          </div>
        </ProcessingStatusProvider>
      </DownloadManagerProvider>
    </AuthProvider>
  )
}
