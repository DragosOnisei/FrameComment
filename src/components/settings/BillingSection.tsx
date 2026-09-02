'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  CreditCard,
  Users,
  HardDrive,
  Calendar,
  Loader2,
  AlertTriangle,
  Gift,
  RefreshCw,
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
  storageBytes: number // 4.2.0+: BILLABLE storage (FrameComment Server only)
  totalStorageBytes?: number // all backends — display context
  activeBackend?: string
  activeBackendLabel?: string
  /** 7.4.3: the priced breakdown, computed SERVER-side by the same
   *  computeCurrentBillable the monthly invoice charges. This pane renders
   *  these numbers verbatim — it does no money math of its own, so what the
   *  page shows and what the card is charged cannot be two formulas. */
  breakdown: {
    freeUsers: number
    freeGiB: number
    billableUsers: number
    billableGiB: number
    userCents: number
    storageCents: number
    totalCents: number
  }
  pricing: {
    currency: string
    perUserPerMonth: number
    perGigabytePerMonth: number
  }
}

interface BillingStatus {
  configured: boolean
  testMode: boolean
  status: string
  billingEmail: string | null
  card: { brand: string | null; last4: string } | null
  hasCard: boolean
  nextBillingAt: string | null
  lastInvoice: { id: string; amount: number | null; status: string | null; at: string | null } | null
  freeTier: { users: number; gib: number }
  overFreeTier: boolean
  suspended: boolean
  issueSince: string | null
  graceDaysLeft: number | null
  /** Exact ISO lockout moment — drives the HH:MM:SS countdown on the last day. */
  graceEndsAt: string | null
}

/** Format a millisecond remainder as HH:MM:SS (hours can exceed 24). */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/**
 * 3.8.0+: Billing pane.
 *
 * Usage-based with a free tier (1 user + 10 GB); you pay only for usage
 * ABOVE the tier. 7.4.3: the invoice charges the CURRENT usage — exactly
 * the total this pane shows at the moment of billing (it used to charge
 * the period's daily average, which drifted $181.60 under the page for a
 * customer whose storage tripled mid-month). A card is required only once
 * you exceed the tier; if it's unpaid/missing for 5 business days the
 * admin is suspended (billing wall).
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
  // Live clock for the final-day HH:MM:SS grace countdown.
  const [nowTs, setNowTs] = useState<number>(() => Date.now())

  // On the last grace day, show a precise countdown to the exact lockout
  // moment instead of "1 business day left".
  const graceEndsAtMs = billing?.graceEndsAt
    ? new Date(billing.graceEndsAt).getTime()
    : null
  const showGraceCountdown =
    graceEndsAtMs != null &&
    (billing?.graceDaysLeft ?? 99) <= 1 &&
    graceEndsAtMs > nowTs
  useEffect(() => {
    if (!showGraceCountdown) return
    const id = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [showGraceCountdown])

  // Suffix appended to the grace warnings: a live HH:MM:SS countdown on the
  // final day, otherwise the "N business days left" text.
  const graceSuffix: ReactNode =
    billing?.graceDaysLeft == null
      ? '.'
      : showGraceCountdown && graceEndsAtMs != null
        ? (
            <>
              {' — '}
              <span className="font-mono tabular-nums font-semibold">
                {formatCountdown(graceEndsAtMs - nowTs)}
              </span>
              {' left.'}
            </>
          )
        : ` — ${billing.graceDaysLeft} business day${billing.graceDaysLeft === 1 ? '' : 's'} left.`

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/billing/status')
      if (res.ok) setBilling((await res.json()) as BillingStatus)
    } catch {
      /* non-fatal */
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

  // Re-poll after returning from Stripe Checkout (webhook lands a beat
  // after the redirect), then tidy the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const flag = new URLSearchParams(window.location.search).get('billing')
    if (flag !== 'success') return
    const timers = [800, 2500, 5000].map((ms) => setTimeout(loadStatus, ms))
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

  // 5.7.1: retry a failed payment. Pays the EXISTING open invoice; when the
  // bank demands authentication (3DS), Stripe's hosted invoice page opens in
  // a new tab so the admin can complete the challenge — the webhook then
  // flips us back to active.
  const [retryMsg, setRetryMsg] = useState<string | null>(null)
  const handleRetry = useCallback(async () => {
    setBusy(true)
    setError(null)
    setRetryMsg(null)
    try {
      const res = await apiFetch('/api/billing/retry', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setRetryMsg(data.message || 'Payment succeeded.')
        loadStatus()
        return
      }
      if (data.requiresAction && data.hostedInvoiceUrl) {
        window.open(data.hostedInvoiceUrl as string, '_blank', 'noopener')
        setRetryMsg(
          'Your bank requires confirmation — finish the payment in the Stripe tab, then this page will update.',
        )
        // Poll a few times: the invoice.paid webhook lands shortly after
        // the hosted payment completes.
        ;[5000, 15000, 30000].forEach((ms) => setTimeout(loadStatus, ms))
        return
      }
      setError(data.error || 'Payment retry failed.')
    } catch {
      setError('Payment retry failed.')
    } finally {
      setBusy(false)
    }
  }, [loadStatus])

  // 7.4.3/7.4.4: "Retry payment" mints a fresh invoice for the CURRENT
  // usage (exactly the total this pane shows) via /api/billing/charge-now.
  // Built for the September 2026 re-collection (refund the wrong payment in
  // the Stripe dashboard, press this, the correct amount is collected) and
  // KEPT for the next time a payment needs re-collecting. 7.4.4: the button
  // is hidden by default — pressed by accident it double-charges, so it only
  // renders when the page is opened with ?retry-payment=1. Read AFTER mount:
  // the server render has no URL to look at, and deciding the initial state
  // from `window` would make the first client render disagree with it
  // (hydration mismatch); starting hidden and flipping in an effect keeps
  // both renders identical.
  const [showChargeNow, setShowChargeNow] = useState(false)
  useEffect(() => {
    try {
      setShowChargeNow(
        new URLSearchParams(window.location.search).get('retry-payment') === '1',
      )
    } catch {
      /* stay hidden */
    }
  }, [])
  const [chargeNowArmed, setChargeNowArmed] = useState(false)
  const [chargeNowMsg, setChargeNowMsg] = useState<string | null>(null)
  const [chargeNowDone, setChargeNowDone] = useState(false)
  const handleChargeNow = useCallback(async () => {
    if (!chargeNowArmed) {
      setChargeNowArmed(true)
      return
    }
    setBusy(true)
    setError(null)
    setChargeNowMsg(null)
    try {
      const res = await apiFetch('/api/billing/charge-now', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setChargeNowMsg(data.message || 'Payment succeeded.')
        setChargeNowDone(true)
        loadStatus()
        return
      }
      if (data.requiresAction && data.hostedInvoiceUrl) {
        window.open(data.hostedInvoiceUrl as string, '_blank', 'noopener')
        setChargeNowMsg(
          'Your bank requires confirmation — finish the payment in the Stripe tab, then this page will update.',
        )
        ;[5000, 15000, 30000].forEach((ms) => setTimeout(loadStatus, ms))
        return
      }
      setError(data.error || 'Charge failed.')
    } catch {
      setError('Charge failed.')
    } finally {
      setBusy(false)
      setChargeNowArmed(false)
    }
  }, [chargeNowArmed, loadStatus])

  // 7.4.3: every priced number below comes from the server's breakdown —
  // the output of the very function the monthly invoice charges. This
  // component used to redo the arithmetic from raw usage, which meant the
  // page and the invoice could (and did) disagree.
  // The `?.` on breakdown is not paranoia about our own types: for the
  // minute a deploy takes, a fresh client can read a cached response from
  // the previous server that has no breakdown yet — the pane must degrade
  // to zeros, not crash.
  const freeUsers = usage?.breakdown?.freeUsers ?? billing?.freeTier.users ?? 1
  const freeGiB = usage?.breakdown?.freeGiB ?? billing?.freeTier.gib ?? 10
  const billableUsers = usage?.breakdown?.billableUsers ?? 0
  const billableGiB = usage?.breakdown?.billableGiB ?? 0
  const userCost = (usage?.breakdown?.userCents ?? 0) / 100
  const storageCost = (usage?.breakdown?.storageCents ?? 0) / 100
  const totalCost = (usage?.breakdown?.totalCents ?? 0) / 100

  const overTier = billing?.overFreeTier ?? totalCost > 0
  const withinFreeTier = !overTier
  const card = billing?.card ?? null
  const pastDue = billing?.status === 'past_due'
  const suspended = !!billing?.suspended
  const needsCard = overTier && !card

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
      {error && <p className="text-xs text-destructive">{error}</p>}

      {usage && (
        <>
          {billing?.testMode && (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 ring-1 ring-amber-400/30 px-2 py-1 text-[11px] font-medium text-amber-300">
              Stripe test mode — no real charges
            </div>
          )}

          {/* Free-tier banner */}
          {withinFreeTier && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/25 px-3 py-2 text-xs text-emerald-300">
              <Gift className="w-4 h-4 shrink-0" />
              You&apos;re on the free tier — up to {freeUsers} user
              {freeUsers === 1 ? '' : 's'} + {freeGiB} GB are free. No card
              needed.
            </div>
          )}

          {/* Suspended banner */}
          {suspended && (
            <div className="flex items-center gap-2 rounded-xl bg-destructive/10 ring-1 ring-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Access is suspended for the admin until billing is resolved.
              Add a payment method below to restore it.
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

          {/* Line-item breakdown (free allowance shown) */}
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-xl ring-1 ring-white/10 bg-white/[0.04] p-3">
              <div className="w-9 h-9 rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">Users</p>
                <p className="text-xs text-white/55">
                  {usage.userCount.toLocaleString()} total · {freeUsers} free ·{' '}
                  {billableUsers.toLocaleString()} ×{' '}
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
                  {/* 4.2.0+: per-GB is billed only for FrameComment Server storage. */}
                  {formatBytes(usage.storageBytes)} on FrameComment Server · {freeGiB} GB free ·{' '}
                  {billableGiB.toLocaleString()} GB ×{' '}
                  {formatCurrency(usage.pricing.perGigabytePerMonth)}/GB
                </p>
                {usage.activeBackend && usage.activeBackend !== 'fc' && (
                  <p className="text-[11px] text-white/40 mt-0.5">
                    You&apos;re on {usage.activeBackendLabel || 'your own storage'} — no per-GB storage charge
                    {typeof usage.totalStorageBytes === 'number' && usage.totalStorageBytes > usage.storageBytes
                      ? ` (${formatBytes(usage.totalStorageBytes)} stored there).`
                      : '.'}
                  </p>
                )}
              </div>
              <p className="text-sm font-semibold text-white tabular-nums">
                {formatCurrency(storageCost)}
              </p>
            </div>
          </div>

          {/* Next billing */}
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

          {/* Past-due / grace warning */}
          {pastDue && !suspended && (
            <div className="flex items-center gap-2 rounded-xl bg-destructive/10 ring-1 ring-destructive/30 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span className="flex-1 min-w-0">
                Last payment failed. Update your card to avoid interruption
                {graceSuffix}
              </span>
              <button
                onClick={handleRetry}
                disabled={busy}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive/20 hover:bg-destructive/30 ring-1 ring-destructive/40 text-destructive transition-colors disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Retry payment'}
              </button>
            </div>
          )}
          {retryMsg && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/25 px-3 py-2 text-xs text-emerald-300">
              {retryMsg}
            </div>
          )}
          {needsCard && !suspended && (
            <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 ring-1 ring-amber-400/25 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              You&apos;re over the free tier. Add a card to keep access
              {graceSuffix}
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
                    : needsCard
                      ? 'Required — you are over the free tier'
                      : 'Optional while on the free tier'}
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

          {/* Hidden unless the page is opened with ?retry-payment=1 (see
              handleChargeNow): manual re-collection of a refunded invoice
              at the CURRENT page total. */}
          {showChargeNow && card && (usage.breakdown?.totalCents ?? 0) > 0 && (
            <div className="flex items-center gap-3 rounded-xl ring-1 ring-amber-400/25 bg-amber-500/[0.06] p-3">
              <RefreshCw className="w-4 h-4 text-amber-300 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">Retry payment</p>
                <p className="text-xs text-white/55">
                  Charges the card on file {formatCurrency(totalCost)} — the
                  current total shown above.
                </p>
              </div>
              <button
                type="button"
                onClick={handleChargeNow}
                disabled={busy || chargeNowDone}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 ring-1 ring-amber-400/40 text-amber-300 transition-colors disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : chargeNowDone ? (
                  'Charged'
                ) : chargeNowArmed ? (
                  `Charge ${formatCurrency(totalCost)} now?`
                ) : (
                  'Retry payment'
                )}
              </button>
            </div>
          )}
          {chargeNowMsg && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/25 px-3 py-2 text-xs text-emerald-300">
              {chargeNowMsg}
            </div>
          )}

          {/* Pricing footnote */}
          <p className="text-[11px] text-white/55">
            Free tier: {freeUsers} user{freeUsers === 1 ? '' : 's'} +{' '}
            {freeGiB} GB. Beyond that:{' '}
            {formatCurrency(usage.pricing.perUserPerMonth)} per extra user
            per month + {formatCurrency(usage.pricing.perGigabytePerMonth)} per
            extra GB per month, measured at the billing date — the invoice
            always equals the total this page shows at that moment. Per-GB storage is
            billed only for files stored on the FrameComment Server backend —
            Local, Cloudflare R2 and AWS are your own storage and are billed per
            user only. Storage counts every file on FrameComment Server,
            including soft-deleted projects in Trash.
          </p>
        </>
      )}
    </CollapsibleSection>
  )
}
