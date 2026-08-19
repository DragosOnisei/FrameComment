'use client'

/**
 * 6.5.0 Founder → Dashboard, on real data.
 *
 * Every tile is computed from records this instance already keeps. Where a
 * figure is partial (invoice history lives in Stripe) the UI says so rather
 * than rounding the truth up.
 */

import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw, DoorOpen, Mail } from 'lucide-react'
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
  activity: { uploads: number; comments: number; projectsCreated: number }
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
    /** 6.25.0 — the departure, when there is one. */
    deletionScheduledAt: string | null
    deletionReason: string | null
    ownerEmail: string | null
    ownerName: string | null
    deletionRequestedByEmail: string | null
  }>
}

const RANGES = [
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '12m', label: '12 months', days: 365 },
] as const

/**
 * 6.25.0 — how long a leaving company has left.
 *
 * `deletionScheduledAt` already holds the moment of the wipe, grace included,
 * so this is a plain subtraction. Deliberately the same shape as
 * `OrgDeletionBanner`: the tenant sees a countdown and the founder sees a
 * countdown, and the two must never disagree about how long is left.
 */
function daysLeft(scheduledAtIso: string): { days: number; label: string } {
  const msLeft = Math.max(0, new Date(scheduledAtIso).getTime() - Date.now())
  const days = Math.floor(msLeft / 86_400_000)
  if (days >= 1) return { days, label: `${days} day${days === 1 ? '' : 's'} left` }
  const hours = Math.floor(msLeft / 3_600_000)
  return { days: 0, label: hours >= 1 ? `${hours}h left` : 'today' }
}

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

  /*
   * 6.25.0 — companies with a deletion scheduled, soonest first.
   *
   * Soonest first because this list is a to-do: the company with four days left
   * is the one worth a call this morning, and burying it under one with
   * twenty-eight would defeat the point of showing it at all.
   */
  const leaving = (data?.companiesTable ?? [])
    .filter((c) => c.deletionScheduledAt)
    .sort((a, b) => new Date(a.deletionScheduledAt!).getTime() - new Date(b.deletionScheduledAt!).getTime())

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
              ? `${money(data.revenue.mrrUserCents)} from users + ${money(data.revenue.mrrStorageCents)} from storage`
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
                <p className="text-xs text-muted-foreground">Charged for users</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {money(data.revenue.mrrUserCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {data.revenue.billableUsers} paid users ×{' '}
                  {unitPrice(data.revenue.pricing.perUserPerMonthCents)} each · every company gets{' '}
                  {data.revenue.pricing.freeUsers} free
                </p>
              </div>
              <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Charged for storage</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {money(data.revenue.mrrStorageCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {data.revenue.billableGiB.toLocaleString('en-US')} paid GB ×{' '}
                  {unitPrice(data.revenue.pricing.perGibPerMonthCents)} each · every company gets{' '}
                  {data.revenue.pricing.freeGib} GB free
                </p>
              </div>
              <div className="rounded-lg bg-primary/10 ring-1 ring-primary/25 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Total per month</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {money(data.revenue.mrrCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {money(data.revenue.invoicedInRangeCents)} recorded as invoiced in this period
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Measured live, the same way each company&apos;s own Billing page measures it: current
              users and current bytes on the FrameComment backend. Files a company keeps on its own
              Local / R2 / AWS storage are charged per user only, never per GB.
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
              {/* Snapshots are written when a company's billing is read that
                  day, so the line is uneven where nobody looked. Better to say
                  so than to let a dip read as lost revenue. */}
              <p className="mt-2 text-xs text-muted-foreground">
                From the daily billing snapshots. A company is only recorded on days its billing
                was read, so gaps show as dips — they are missing readings, not lost revenue.
              </p>
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

      {/*
        6.25.0 — companies on their way out.

        Above the Companies table, not inside it, and rendered only when there
        is somebody to call. A permanent empty card would train the eye to skip
        the space, which is the opposite of what a thing you have thirty days to
        act on needs. Everything here exists to make the call possible: who is
        leaving, who pressed the button, the address to write to, what they said
        if they said anything, and how long is left.
      */}
      {leaving.length > 0 && (
        <div className="mt-4">
          <FounderCard title="Leaving">
            <p className="-mt-1 mb-3 text-xs text-muted-foreground">
              Deletion is scheduled. Their data is wiped when the countdown ends, and the Owner
              can still cancel until then.
            </p>
            <div className="space-y-3">
              {leaving.map((c) => {
                const left = daysLeft(c.deletionScheduledAt!)
                return (
                  <div
                    key={c.id}
                    className="rounded-lg ring-1 ring-red-500/25 bg-red-500/[0.06] p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <DoorOpen className="w-4 h-4 text-red-300/80 shrink-0" />
                          <span className="font-medium truncate">{c.name}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Customer since {new Date(c.createdAt).toLocaleDateString()}
                          {c.estimatedMonthlyCents > 0 && <> · {money(c.estimatedMonthlyCents)}/mo</>}
                          {' · '}{c.users} user{c.users === 1 ? '' : 's'}
                        </div>
                      </div>
                      {/* Under a week turns solid: the number matters more the
                          closer it gets, and a uniform badge would read the
                          same on day 29 as on the last morning. */}
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs whitespace-nowrap ring-1 ${
                          left.days <= 7
                            ? 'bg-red-500/20 text-red-200 ring-red-500/40'
                            : 'bg-white/[0.06] text-white/70 ring-white/15'
                        }`}
                      >
                        {left.label}
                      </span>
                    </div>

                    {c.deletionReason ? (
                      <p className="mt-2 text-sm text-white/80 whitespace-pre-wrap break-words">
                        “{c.deletionReason}”
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground italic">
                        No reason given.
                      </p>
                    )}

                    {/* mailto rather than a copyable string: the whole point of
                        this panel is the next action, and one click should
                        start it. */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      {c.ownerEmail ? (
                        <a
                          href={`mailto:${c.ownerEmail}?subject=${encodeURIComponent(`About your FrameComment account`)}`}
                          className="inline-flex items-center gap-1.5 text-white/75 hover:text-white underline underline-offset-2"
                        >
                          <Mail className="w-3.5 h-3.5" />
                          {c.ownerName ? `${c.ownerName} · ` : ''}{c.ownerEmail}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">No owner on record</span>
                      )}
                      {/* Only worth saying when it was somebody else — otherwise
                          it is the same address twice. */}
                      {c.deletionRequestedByEmail && c.deletionRequestedByEmail !== c.ownerEmail && (
                        <span className="text-muted-foreground">
                          Requested by {c.deletionRequestedByEmail}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </FounderCard>
        </div>
      )}

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
                        <div className="flex items-center gap-1.5">
                          <span className="truncate max-w-[220px]">{c.name}</span>
                          {/* 6.25.0: a company on its way out used to sit here
                              indistinguishable from a healthy one — same
                              revenue, same tier pill. Anyone reading the table
                              for how the business is doing was counting money
                              that is already walking. */}
                          {c.deletionScheduledAt && (
                            <span
                              className="shrink-0 rounded-full bg-red-500/15 text-red-300 ring-1 ring-red-500/30 px-1.5 py-0.5 text-[10px] whitespace-nowrap"
                              title="Deletion scheduled"
                            >
                              leaving
                            </span>
                          )}
                        </div>
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
