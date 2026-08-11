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

  return (
    <div className="spotlight-bg flex min-h-screen">
      <FounderSidebar />
      <main className="flex-1 min-w-0 flex flex-col overflow-x-hidden">{children}</main>
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
