'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

/**
 * 3.8.0+: admin billing wall.
 *
 * When billing is suspended (unresolved > 5 business days: over the free
 * tier with no card, or a failed payment), this full-screen overlay
 * blocks the admin UI everywhere EXCEPT the Settings page, so the admin
 * can still reach Billing and add a card. Client share links are on
 * separate public routes and are never affected.
 *
 * Polls status on mount + every minute, so the wall lifts on its own the
 * moment billing is resolved (card added → payment succeeds, or usage
 * drops back under the free tier).
 */
export default function BillingWall() {
  const pathname = usePathname()
  const [suspended, setSuspended] = useState(false)

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const res = await apiFetch('/api/billing/status')
        if (!res.ok) return
        const data = await res.json()
        if (alive) setSuspended(!!data.suspended)
      } catch {
        /* ignore — never lock someone out on a transient fetch error */
      }
    }
    check()
    const id = setInterval(check, 60_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [pathname])

  // Never block the Settings page — that's where billing gets fixed.
  const onSettings = pathname?.startsWith('/admin/settings') ?? false
  if (!suspended || onSettings) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm">
      <div
        className="max-w-md w-full rounded-2xl bg-white/[0.06] ring-1 ring-white/15 p-6 text-white text-center shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)]"
        style={{ backdropFilter: 'blur(24px) saturate(160%)' }}
      >
        <div className="mx-auto w-12 h-12 rounded-full bg-destructive/15 ring-1 ring-destructive/30 flex items-center justify-center text-destructive mb-4">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-semibold">Billing suspended</h2>
        <p className="text-sm text-white/70 mt-2 leading-relaxed">
          You&apos;re over the free tier and billing is unresolved. Add a
          payment method to restore access. Your clients&apos; share links are
          unaffected.
        </p>
        <Link
          href="/admin/settings"
          className="inline-block mt-5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.55)] hover:brightness-110 transition"
        >
          Go to Billing settings
        </Link>
      </div>
    </div>
  )
}
