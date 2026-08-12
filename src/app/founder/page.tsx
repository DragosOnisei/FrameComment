'use client'

/**
 * 6.5.0 Founder → Dashboard, on real data.
 *
 * Every tile is computed from records this instance already keeps. Where a
 * figure is partial (invoice history lives in Stripe) the UI says so rather
 * than rounding the truth up.
 */

import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { FounderCard, FounderPage, MetricTile } from '@/components/founder/FounderPage'
import { logError } from '@/lib/logging'

interface Metrics {
  range: { from: string; to: string }
  companies: {
    total: number
    active: number
    suspended: number
    newInRange: number
    paying: number
    onPaidTier: number
    onFreeTier: number
  }
  users: { total: number; newInRange: number }
  revenue: {
    mrrCents: number
    mrrUserCents: number
    mrrStorageCents: number
    billableUsers: number
    billableGiB: number
    invoicedInRangeCents: number
    revenueNote: string
    currency: string
    pricing: {
      perUserPerMonthCents: number
      perGibPerMonthCents: number
      freeUsers: number
      freeGib: number
    }
  }
  storage: { totalBytes: number; billableBytes: number }
  activity: { uploads: number; comments: number; approvals: number; projectsCreated: number }
  series: Array<{ day: string; users: number; storageBytes: number; mrrCents: number }>
  companiesTable: Array<{
    id: string
    name: string
    createdAt: string
    status: string
    users: number
    storageBytes: number
    billingStatus: string
    hasCard: boolean
    lastInvoiceCents: number | null
    lastChargedAt: string | null
    estimatedMonthlyCents: number
    estimatedUserCents: number
    estimatedStorageCents: number
    billableUsers: number
    billableGiB: number
    tier: 'free' | 'paid'
  }>
}

const RANGES = [
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '12m', label: '12 months', days: 365 },
] as const

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

/** Unit price, which can be cents ($0.10/GiB) — don't round it away. */
function unitPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Minimal sparkline. No chart library for four numbers a month. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min || 1
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100
      const y = 100 - ((p - min) / span) * 100
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-24" aria-hidden>
      <path d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export default function FounderDashboardPage() {
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]['key']>('30d')
  const [data, setData] = useState<Metrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const days = RANGES.find((r) => r.key === rangeKey)?.days ?? 30
    const to = new Date()
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
    try {
      setLoading(true)
      setError('')
      const res = await apiFetch(
        `/api/founder/metrics?from=${from.toISOString()}&to=${to.toISOString()}`,
      )
      if (!res.ok) throw new Error('Could not load metrics')
      setData(await res.json())
    } catch (err) {
      logError('[founder] metrics failed:', err)
      setError(err instanceof Error ? err.message : 'Could not load metrics')
    } finally {
      setLoading(false)
    }
  }, [rangeKey])

  useEffect(() => {
    load()
  }, [load])

  const [exporting, setExporting] = useState(false)

  const downloadReport = async () => {
    const days = RANGES.find((r) => r.key === rangeKey)?.days ?? 30
    const to = new Date()
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
    try {
      setExporting(true)
      // The route is bearer-gated like every founder endpoint (apiFetch attaches
      // the token), so fetch it and hand the browser a blob rather than opening
      // an unauthenticated tab that would just 404.
      const res = await apiFetch(
        `/api/founder/report?from=${from.toISOString()}&to=${to.toISOString()}`,
      )
      if (!res.ok) throw new Error('Report failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `framecomment-platform-${new Date().toISOString().slice(0, 10)}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      logError('[founder] report failed:', err)
      setError('Could not build the PDF report.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <FounderPage title="Dashboard" subtitle="Revenue, customers and platform health in one place.">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="inline-flex rounded-lg bg-white/[0.04] ring-1 ring-white/10 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRangeKey(r.key)}
              className={`h-8 px-3 rounded-md text-xs font-medium transition-colors ${
                rangeKey === r.key
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground ring-1 ring-white/10 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={downloadReport}
          disabled={!data || exporting}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white/[0.06] px-3 text-xs font-medium ring-1 ring-white/10 hover:bg-white/[0.12] transition-colors disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" />
          {exporting ? 'Building…' : 'PDF report'}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Recurring revenue"
          value={data ? `${money(data.revenue.mrrCents)}/mo` : null}
          hint={
            data
              ? `${money(data.revenue.mrrUserCents)} users · ${money(data.revenue.mrrStorageCents)} storage`
              : "What today's usage would invoice"
          }
        />
        <MetricTile
          label="Paid tier"
          value={data ? String(data.companies.onPaidTier) : null}
          hint={
            data
              ? `${data.companies.onFreeTier} on free · ${data.companies.paying} with card`
              : 'Companies above the free allowance'
          }
        />
        <MetricTile
          label="Users"
          value={data ? String(data.users.total) : null}
          hint={data ? `${data.revenue.billableUsers} billable · ${data.users.newInRange} new` : 'Across every company'}
        />
        <MetricTile
          label="Storage"
          value={data ? bytes(data.storage.totalBytes) : null}
          hint={data ? `${bytes(data.storage.billableBytes)} billable` : 'All backends'}
        />
      </div>

      {/* Where the recurring number comes from. One opaque total invites the
          question "from what?", so answer it on the page: quantity × price. */}
      {data && (
        <div className="mt-3">
          <FounderCard title="How the recurring revenue is made up">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Seats</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {money(data.revenue.mrrUserCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {data.revenue.billableUsers} billable ×{' '}
                  {unitPrice(data.revenue.pricing.perUserPerMonthCents)} · first{' '}
                  {data.revenue.pricing.freeUsers} free per company
                </p>
              </div>
              <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Storage</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {money(data.revenue.mrrStorageCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {data.revenue.billableGiB.toLocaleString('en-US')} GiB ×{' '}
                  {unitPrice(data.revenue.pricing.perGibPerMonthCents)} · first{' '}
                  {data.revenue.pricing.freeGib} GiB free per company
                </p>
              </div>
              <div className="rounded-lg bg-primary/10 ring-1 ring-primary/25 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {money(data.revenue.mrrCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {money(data.revenue.invoicedInRangeCents)} invoiced in period (floor)
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Only storage on the FrameComment backend is charged per GiB; files a company keeps on
              its own Local / R2 / AWS storage cost seats only.
            </p>
          </FounderCard>
        </div>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <FounderCard title="Recurring revenue over time">
          {data && data.series.length > 1 ? (
            <>
              <Sparkline points={data.series.map((s) => s.mrrCents)} />
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{data.series[0].day}</span>
                <span>{data.series[data.series.length - 1].day}</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Not enough history yet. One point is written per company per day.
            </p>
          )}
        </FounderCard>

        <FounderCard title="Activity in period">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ['Uploads', data?.activity.uploads],
              ['Comments', data?.activity.comments],
              ['Approvals', data?.activity.approvals],
              ['Projects created', data?.activity.projectsCreated],
              ['New companies', data?.companies.newInRange],
              ['Suspended', data?.companies.suspended],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2.5">
                <dt className="text-xs text-muted-foreground">{label as string}</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                  {typeof value === 'number' ? value : <span className="text-foreground/30">—</span>}
                </dd>
              </div>
            ))}
          </dl>
        </FounderCard>
      </div>

      <div className="mt-4">
        <FounderCard title="Companies">
          {data && data.companiesTable.length > 0 ? (
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground text-left">
                    <th className="font-medium py-2 pr-3">Company</th>
                    <th className="font-medium py-2 pr-3 text-right">Users</th>
                    <th className="font-medium py-2 pr-3 text-right">Storage</th>
                    <th className="font-medium py-2 pr-3">Tier</th>
                    <th className="font-medium py-2 text-right">Est. / mo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.companiesTable.map((c) => (
                    <tr key={c.id} className="border-t border-white/[0.06]">
                      <td className="py-2 pr-3">
                        <div className="truncate max-w-[220px]">{c.name}</div>
                        <div className="text-xs text-muted-foreground">
                          since {new Date(c.createdAt).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <div>{c.users}</div>
                        {c.billableUsers > 0 && (
                          <div className="text-xs text-muted-foreground">{c.billableUsers} billable</div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <div>{bytes(c.storageBytes)}</div>
                        {c.billableGiB > 0 && (
                          <div className="text-xs text-muted-foreground">{c.billableGiB} GiB billable</div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ring-1 ${
                            c.tier === 'paid'
                              ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30'
                              : 'bg-white/[0.05] text-muted-foreground ring-white/10'
                          }`}
                        >
                          {c.tier === 'paid' ? 'Paid' : 'Free'}
                        </span>
                        {/* A company that owes money without a way to charge it
                            is the one billing fact worth surfacing here. */}
                        {c.tier === 'paid' && !c.hasCard && (
                          <div className="mt-0.5 text-xs text-red-300">no card on file</div>
                        )}
                        {c.tier === 'paid' && c.hasCard && c.billingStatus === 'past_due' && (
                          <div className="mt-0.5 text-xs text-red-300">past due</div>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        <div>{money(c.estimatedMonthlyCents)}</div>
                        {c.estimatedMonthlyCents > 0 && (
                          <div className="text-xs text-muted-foreground">
                            {money(c.estimatedUserCents)} + {money(c.estimatedStorageCents)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading ? 'Loading…' : 'No companies yet.'}
            </p>
          )}
        </FounderCard>
      </div>

      {data && (
        <p className="mt-3 text-xs text-muted-foreground">{data.revenue.revenueNote}</p>
      )}
    </FounderPage>
  )
}
