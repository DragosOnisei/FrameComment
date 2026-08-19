'use client'

/**
 * 6.2.0 Founder area shell — sidebar on the left, content on the right, same
 * two-axis layout and glass vocabulary as /admin, but the navigation is the
 * platform's (Dashboard / CRM / AI Agents) and nothing here touches customer
 * media, comments or share links.
 *
 * Gating is client-side, matching how /admin works (auth lives in bearer tokens
 * that server components can't read). The REAL protection is server-side: every
 * `/api/founder/*` route goes through `requirePlatformAdmin`.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { AuthProvider, useAuth } from '@/components/AuthProvider'
import FounderSidebar from '@/components/founder/FounderSidebar'

function FounderShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const allowed = !!user?.isPlatformAdmin

  useEffect(() => {
    if (loading) return
    // Signed in, but not the founder → back to the normal app. No error page,
    // nothing that hints this area exists.
    if (user && !allowed) router.replace('/admin/projects')
  }, [loading, user, allowed, router])

  if (loading || !user || !allowed) {
    return (
      <div
        className="spotlight-bg-tr flex items-center justify-center p-6"
        style={{ minHeight: '100dvh' }}
      >
        <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-white/70 animate-spin" />
      </div>
    )
  }

  /*
   * 6.20.2 — the CONTENT scrolls, not the window.
   *
   * The shell used to be `min-h-screen` with the sidebar `sticky top-0`, so a
   * long page scrolled the whole document. Sticky kept the sidebar in view,
   * but only its top edge: the panel is one viewport tall, so past that point
   * it ended and left a bare column under the account cluster for the rest of
   * the page.
   *
   * Pinning the shell to the viewport and letting only `<main>` overflow fixes
   * it properly — the sidebar is always exactly as tall as the window, there is
   * nothing below it to leave empty, and the navigation cannot scroll away.
   *
   * `100dvh` rather than `100vh`: on mobile browsers the toolbar collapses on
   * scroll and `vh` does not follow it, which is where the "content hidden
   * under the address bar" class of bug comes from.
   */
  return (
    <div className="spotlight-bg flex overflow-hidden" style={{ height: '100dvh' }}>
      <FounderSidebar />
      <main className="custom-scrollbar flex-1 min-w-0 flex flex-col overflow-y-auto overflow-x-hidden">
        {children}
      </main>
    </div>
  )
}

export default function FounderLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthProvider requireAuth>
      <FounderShell>{children}</FounderShell>
    </AuthProvider>
  )
}
