'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  CreditCard,
  Users,
  HardDrive,
  Calendar,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import { apiFetch } from '@/lib/api-client'

interface BillingSectionProps {
  show: boolean
  setShow: (value: boolean) => void
  collapsible?: boolean
}

interface UsageResponse {
  userCount: number
  storageBytes: number
  pricing: {
    currency: string
    perUserPerMonth: number
    perGigabytePerMonth: number
  }
}

interface BillingStatus {
  configured: boolean
  testMode: boolean
  status: 'none' | 'active' | 'past_due' | string
  billingEmail: string | null
  card: { brand: string | null; last4: string } | null
  nextBillingAt: string | null
  lastInvoice: {
    id: string
    amount: number | null
    status: string | null
    at: string | null
  } | null
}

/**
 * 3.7.0+: Billing pane, now Stripe-connected.
 *
 * Shows the current month-to-date estimate at the flat tariff
 * ($25/user/month + $0.10/GB/month), plus the real payment state from
 * Stripe: connect a card via Checkout, then the monthly invoice is
 * charged automatically off-session. "Manage" opens the Stripe Billing
 * Portal (update card / view invoices).
 */
export function BillingSection({
  show,
  setShow,
  collapsible,
}: BillingSectionProps) {
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/billing/status')
      if (res.ok) setBilling((await res.json()) as BillingStatus)
    } catch {
      /* non-fatal — the estimate still renders */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      apiFetch('/api/settings/billing/usage').then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as UsageResponse
      }),
      apiFetch('/api/billing/status')
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ])
      .then(([u, b]) => {
        if (cancelled) return
        setUsage(u)
        if (b) setBilling(b as BillingStatus)
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load usage')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Returning from Stripe Checkout (?billing=success): the card is
  // saved by the webhook, which can land a beat after the redirect.
  // Re-poll the status a couple of times so the connected card shows
  // without a manual refresh, then tidy the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const flag = new URLSearchParams(window.location.search).get('billing')
    if (flag !== 'success') return
    const timers = [800, 2500, 5000].map((ms) => setTimeout(loadStatus, ms))
    // Strip the query param so a refresh doesn't re-trigger.
    const url = new URL(window.location.href)
    url.searchParams.delete('billing')
    window.history.replaceState({}, '', url.toString())
    return () => timers.forEach(clearTimeout)
  }, [loadStatus])

  const handleConnect = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/billing/checkout', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.url) {
        window.location.href = data.url as string
        return
      }
      setError(data.error || 'Failed to start Stripe Checkout.')
    } catch {
      setError('Failed to start Stripe Checkout.')
    } finally {
      setBusy(false)
    }
  }, [])

  const handleManage = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/billing/portal', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.url) {
        window.location.href = data.url as string
        return
      }
      setError(data.error || 'Failed to open the billing portal.')
    } catch {
      setError('Failed to open the billing portal.')
    } finally {
      setBusy(false)
    }
  }, [])

  const bytesPerGiB = 1024 ** 3
  const usedGiB = usage ? usage.storageBytes / bytesPerGiB : 0
  const userCost = usage ? usage.userCount * usage.pricing.perUserPerMonth : 0
  const storageCost = usage ? usedGiB * usage.pricing.perGigabytePerMonth : 0
  const totalCost = userCost + storageCost

  // Prefer the real scheduled charge date from Stripe status; fall back
  // to the last day of the current month for the pre-connect estimate.
  const today = new Date()
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  const nextBilling = billing?.nextBillingAt
    ? new Date(billing.nextBillingAt)
    : endOfMonth

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: usage?.pricing.currency || 'USD',
      maximumFractionDigits: 2,
    }).format(n)
  const formatBytes = (b: number): string => {
    if (b < 1024) return `${b} B`
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
    if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`
    return `${(b / 1024 ** 4).toFixed(2)} TB`
  }

  const card = billing?.card ?? null
  const pastDue = billing?.status === 'past_due'

  return (
    <CollapsibleSection
      className="border-0 bg-white/[0.04] ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
      }}
      title="Billing"
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t border-white/10 pt-4"
      collapsible={collapsible}
    >
      {loading && (
        <div className="flex items-center gap-2 text-sm text-white/55">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading usage…
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {usage && (
        <>
          {/* Test-mode badge so a sandbox charge is never mistaken for
              a real one. */}
          {billing?.testMode && (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 ring-1 ring-amber-400/30 px-2 py-1 text-[11px] font-medium text-amber-300">
              Stripe test mode — no real charges
            </div>
          )}

          {/* Current month total */}
          <div className="rounded-xl ring-1 ring-white/10 bg-white/[0.04] p-4">
            <p className="text-xs text-white/55 uppercase tracking-wide">
              Current month (estimate)
            </p>
            <p className="text-3xl font-semibold text-white mt-1 tabular-nums">
              {formatCurrency(totalCost)}
            </p>
            <p className="text-xs text-white/55 mt-1">
              {card ? 'Charged' : 'Billed'} on{' '}
              {nextBilling.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>
          </div>

          {/* Line-item breakdown */}
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-xl ring-1 ring-white/10 bg-white/[0.04] p-3">
              <div className="w-9 h-9 rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">Users</p>
                <p className="text-xs text-white/55">
                  {usage.userCount.toLocaleString()} ×{' '}
                  {formatCurrency(usage.pricing.perUserPerMonth)}
                </p>
              </div>
              <p className="text-sm font-semibold text-white tabular-nums">
                {formatCurrency(userCost)}
              </p>
            </div>

            <div className="flex items-center gap-3 rounded-xl ring-1 ring-white/10 bg-white/[0.04] p-3">
              <div className="w-9 h-9 rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30 flex items-center justify-center shrink-0">
                <HardDrive className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">Storage</p>
                <p className="text-xs text-white/55">
                  {formatBytes(usage.storageBytes)} ({usedGiB.toFixed(2)} GB) ×{' '}
                  {formatCurrency(usage.pricing.perGigabytePerMonth)}/GB
                </p>
              </div>
              <p className="text-sm font-semibold text-white tabular-nums">
                {formatCurrency(storageCost)}
              </p>
            </div>
          </div>

          {/* Next billing date */}
          <div className="flex items-center gap-3 rounded-xl ring-1 ring-white/10 bg-white/[0.04] p-3">
            <Calendar className="w-4 h-4 text-white/55 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">Next billing</p>
              <p className="text-xs text-white/55">
                {nextBilling.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </p>
            </div>
          </div>

          {/* Past-due warning */}
          {pastDue && (
            <div className="flex items-center gap-2 rounded-xl bg-destructive/10 ring-1 ring-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Last payment failed. Update your card to avoid interruption.
            </div>
          )}

          {/* Payment method */}
          {card ? (
            <div className="flex items-center gap-3 rounded-xl ring-1 ring-white/10 bg-white/[0.04] p-3">
              <CreditCard className="w-4 h-4 text-white/55 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">Payment method</p>
                <p className="text-xs text-white/55 capitalize">
                  {card.brand || 'Card'} •••• {card.last4}
                </p>
              </div>
              <button
                type="button"
                onClick={handleManage}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/15 hover:ring-white/25 text-white transition-colors disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Manage'}
              </button>
            </div>
          ) : (
            <div
              className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-3"
              style={{ border: '1px dashed rgba(255,255,255,0.15)' }}
            >
              <CreditCard className="w-4 h-4 text-white/55 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">Payment method</p>
                <p className="text-xs text-white/55">
                  {billing && !billing.configured
                    ? 'Stripe is not configured on this server yet'
                    : 'No payment method connected'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleConnect}
                disabled={busy || (billing ? !billing.configured : false)}
                title={
                  billing && !billing.configured
                    ? 'Add Stripe keys on the server to enable billing'
                    : undefined
                }
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-white shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.55)] hover:brightness-110 transition disabled:opacity-60 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-white/55 disabled:shadow-none"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  'Connect Stripe'
                )}
              </button>
            </div>
          )}

          {/* Pricing footnote */}
          <p className="text-[11px] text-white/55">
            Tariff: {formatCurrency(usage.pricing.perUserPerMonth)} per user
            per month + {formatCurrency(usage.pricing.perGigabytePerMonth)} per
            GB per month. Storage counts every file the app holds, including
            soft-deleted projects in Trash.
          </p>
        </>
      )}
    </CollapsibleSection>
  )
}
