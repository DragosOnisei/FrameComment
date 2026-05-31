'use client'

import { useEffect, useState } from 'react'
import {
  CreditCard,
  Users,
  HardDrive,
  Calendar,
  Loader2,
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

/**
 * 1.9.2+: Billing pane. UI-only for now — no Stripe connection,
 * no scheduled charges. Shows what the current month-to-date bill
 * WOULD be at the flat tariff ($25/user/month + $0.10/GB/month).
 * Useful for owners to see what a future automated billing would
 * cost and for capacity planning today.
 *
 * The "Next billing on …" + "Payment method" rows are placeholders
 * with a "Connect Stripe" CTA disabled until the real integration
 * lands.
 */
export function BillingSection({
  show,
  setShow,
  collapsible,
}: BillingSectionProps) {
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiFetch('/api/settings/billing/usage')
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const data = (await res.json()) as UsageResponse
        if (!cancelled) setUsage(data)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load usage')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Compute derived values once we have usage data.
  const bytesPerGiB = 1024 ** 3
  const usedGiB = usage ? usage.storageBytes / bytesPerGiB : 0
  const userCost = usage ? usage.userCount * usage.pricing.perUserPerMonth : 0
  const storageCost = usage ? usedGiB * usage.pricing.perGigabytePerMonth : 0
  const totalCost = userCost + storageCost

  // Next billing date = last day of the current month.
  const today = new Date()
  const nextBilling = new Date(
    today.getFullYear(),
    today.getMonth() + 1,
    0, // day 0 of next month = last day of this month
  )
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
      className="border-border"
      title="Billing"
      description="Usage-based billing summary. Charges happen at end of each month."
      open={show}
      onOpenChange={setShow}
      contentClassName="space-y-4 border-t pt-4"
      collapsible={collapsible}
    >
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading usage…
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive">Couldn&apos;t load usage: {error}</p>
      )}

      {usage && (
        <>
          {/* Current month total */}
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              Current month (estimate)
            </p>
            <p className="text-3xl font-semibold text-foreground mt-1 tabular-nums">
              {formatCurrency(totalCost)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Billed on {nextBilling.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>
          </div>

          {/* Line-item breakdown */}
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-md border border-border bg-card/50 p-3">
              <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Users</p>
                <p className="text-xs text-muted-foreground">
                  {usage.userCount.toLocaleString()} ×{' '}
                  {formatCurrency(usage.pricing.perUserPerMonth)}
                </p>
              </div>
              <p className="text-sm font-semibold text-foreground tabular-nums">
                {formatCurrency(userCost)}
              </p>
            </div>

            <div className="flex items-center gap-3 rounded-md border border-border bg-card/50 p-3">
              <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <HardDrive className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Storage</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(usage.storageBytes)} ({usedGiB.toFixed(2)} GB) ×{' '}
                  {formatCurrency(usage.pricing.perGigabytePerMonth)}/GB
                </p>
              </div>
              <p className="text-sm font-semibold text-foreground tabular-nums">
                {formatCurrency(storageCost)}
              </p>
            </div>
          </div>

          {/* Next billing date */}
          <div className="flex items-center gap-3 rounded-md border border-border p-3">
            <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Next billing</p>
              <p className="text-xs text-muted-foreground">
                {nextBilling.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </p>
            </div>
          </div>

          {/* Payment method placeholder */}
          <div className="flex items-center gap-3 rounded-md border border-dashed border-border p-3">
            <CreditCard className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                Payment method
              </p>
              <p className="text-xs text-muted-foreground">
                No payment method connected
              </p>
            </div>
            <button
              type="button"
              disabled
              title="Stripe integration not yet implemented"
              className="px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-card text-muted-foreground opacity-60 cursor-not-allowed"
            >
              Connect Stripe
            </button>
          </div>

          {/* Pricing footnote */}
          <p className="text-[11px] text-muted-foreground">
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
