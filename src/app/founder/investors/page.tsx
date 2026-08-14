'use client'

/**
 * 6.8.0 Founder → Investors (Faza 5).
 *
 * The things someone doing diligence will ask for, answered from measurement
 * rather than assertion: cohorts and retention, uptime with an honest scope,
 * an audit trail of what was done in this area, archived period reports, and
 * a posture checklist that marks what could NOT be verified from here.
 *
 * The unverified rows are the point. A checklist of nothing but green ticks
 * is the least believable document in a data room.
 */

import { useCallback, useEffect, useState } from 'react'
import { Archive, Check, Circle, Download, Minus, RefreshCw, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { FounderCard, FounderPage, MetricTile } from '@/components/founder/FounderPage'
import { logError } from '@/lib/logging'

interface Cohort {
  month: string
  companies: number
  retained: number
  active30d: number
  churned: number
  retentionPercent: number
}

interface Posture {
  label: string
  status: boolean | null
  detail: string
}

interface Data {
  range: { from: string; to: string; days: number }
  retention: {
    cohorts: Cohort[]
    activeRatePercent: number | null
    medianDaysToFirstUpload: number | null
    note: string
  }
  posture: Posture[]
  uptime: {
    services: Array<{
      service: string
      uptimePercent: number | null
      outages: number
      downtimeSeconds: number
      lastSeenAt: string | null
      bootedAt: string | null
      bootCount: number
      version: string | null
      online: boolean
      measuringSince: string | null
    }>
    recentOutages: Array<{
      service: string
      startedAt: string
      endedAt: string
      seconds: number
      note: string | null
    }>
    scopeNote: string
  }
  audit: Array<{
    id: string
    actorName: string | null
    action: string
    targetType: string | null
    targetId: string | null
    summary: string | null
    createdAt: string
  }>
  archives: Array<{
    id: string
    label: string
    periodFrom: string
    periodTo: string
    createdAt: string
    createdByName: string | null
    mrrCents: number
    companies: number
    users: number
  }>
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

export default function FounderInvestorsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError('')
      const res = await apiFetch('/api/founder/investors?days=90')
      if (!res.ok) throw new Error('Could not load the investor pack')
      setData(await res.json())
    } catch (err) {
      logError('[investors] load failed:', err)
      setError(err instanceof Error ? err.message : 'Could not load the investor pack')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const archiveLastMonth = async () => {
    try {
      setBusy(true)
      setNotice('')
      const res = await apiFetch('/api/founder/archives', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || 'Could not archive')
      setNotice(`Archived ${body.label}. Its figures are frozen — the PDF will always show them.`)
      await load()
    } catch (err) {
      logError('[investors] archive failed:', err)
      setError(err instanceof Error ? err.message : 'Could not archive')
    } finally {
      setBusy(false)
    }
  }

  const downloadArchive = async (id: string, label: string) => {
    try {
      const res = await apiFetch(`/api/founder/archives/${id}`)
      if (!res.ok) throw new Error('Could not build that report')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `framecomment-${label.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase()}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      logError('[investors] download failed:', err)
      setError(err instanceof Error ? err.message : 'Could not build that report')
    }
  }

  const removeArchive = async (id: string) => {
    if (!confirm('Delete this archived period? The frozen figures are lost.')) return
    await apiFetch(`/api/founder/archives/${id}`, { method: 'DELETE' })
    await load()
  }

  const web = data?.uptime.services.find((s) => s.service === 'web')

  return (
    <FounderPage
      title="Investors"
      subtitle="Retention, uptime, audit trail and archived reports — measured, with the gaps named."
    >
      <div className="flex flex-wrap items-center gap-2 mb-4">
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
          onClick={archiveLastMonth}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary/20 text-primary px-3 text-xs font-medium ring-1 ring-primary/30 hover:bg-primary/30 transition-colors disabled:opacity-40"
        >
          <Archive className="w-3.5 h-3.5" />
          {busy ? 'Archiving…' : 'Archive last month'}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-3 py-2 text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Companies still active"
          value={
            data && data.retention.cohorts.length > 0
              ? `${data.retention.cohorts.reduce((a, c) => a + c.retained, 0)}/${data.retention.cohorts.reduce((a, c) => a + c.companies, 0)}`
              : null
          }
          hint="Of every company that ever signed up"
        />
        <MetricTile
          label="Used in last 30 days"
          value={
            data?.retention.activeRatePercent != null
              ? `${Math.round(data.retention.activeRatePercent)}%`
              : null
          }
          hint="Uploaded or commented"
        />
        <MetricTile
          label="Days to first upload"
          value={
            data?.retention.medianDaysToFirstUpload != null
              ? String(data.retention.medianDaysToFirstUpload)
              : null
          }
          hint="Median, per company"
        />
        <MetricTile
          label="App uptime (90 d)"
          value={web?.uptimePercent != null ? `${web.uptimePercent.toFixed(2)}%` : null}
          hint={web ? `${web.outages} outage${web.outages === 1 ? '' : 's'} recorded` : 'Measuring starts at first boot'}
        />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <FounderCard title="Cohorts by signup month">
          {data && data.retention.cohorts.length > 0 ? (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground text-left">
                    <th className="font-medium py-2 pr-3">Month</th>
                    <th className="font-medium py-2 pr-3 text-right">Signed up</th>
                    <th className="font-medium py-2 pr-3 text-right">Still active</th>
                    <th className="font-medium py-2 text-right">Used in 30 d</th>
                  </tr>
                </thead>
                <tbody>
                  {data.retention.cohorts.map((c) => (
                    <tr key={c.month} className="border-t border-white/[0.06]">
                      <td className="py-2 pr-3">{c.month}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.companies}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {c.retained}
                        <span className="text-xs text-muted-foreground ml-1">
                          ({Math.round(c.retentionPercent)}%)
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{c.active30d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted-foreground">{data.retention.note}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading ? 'Loading…' : 'No companies yet.'}
            </p>
          )}
        </FounderCard>

        <FounderCard title="Uptime">
          {data && data.uptime.services.length > 0 ? (
            <>
              <div className="space-y-2">
                {data.uptime.services.map((s) => (
                  <div
                    key={s.service}
                    className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${s.online ? 'bg-emerald-400' : 'bg-red-400'}`}
                      />
                      <span className="text-sm font-medium capitalize">{s.service}</span>
                      <span className="text-sm tabular-nums ml-auto">
                        {s.uptimePercent != null ? `${s.uptimePercent.toFixed(2)}%` : '—'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {s.outages} outage{s.outages === 1 ? '' : 's'} ·{' '}
                      {duration(s.downtimeSeconds)} down · {s.bootCount} start
                      {s.bootCount === 1 ? '' : 's'}
                      {s.measuringSince
                        ? ` · measuring since ${new Date(s.measuringSince).toLocaleDateString()}`
                        : ''}
                    </p>
                  </div>
                ))}
              </div>

              {data.uptime.recentOutages.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground mb-1.5">Recent outages</p>
                  <div className="space-y-1">
                    {data.uptime.recentOutages.slice(0, 5).map((o, i) => (
                      <p key={i} className="text-xs text-muted-foreground">
                        {o.service} · {new Date(o.startedAt).toLocaleString()} ·{' '}
                        {duration(o.seconds)}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-3 text-xs text-muted-foreground">{data.uptime.scopeNote}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading
                ? 'Loading…'
                : 'No heartbeats recorded yet. Measurement begins the first time the app and worker start on this version.'}
            </p>
          )}
        </FounderCard>
      </div>

      <div className="mt-4">
        <FounderCard title="Archived periods">
          {data && data.archives.length > 0 ? (
            <div className="divide-y divide-white/[0.06]">
              {data.archives.map((a) => (
                <div key={a.id} className="flex items-center gap-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{a.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {money(a.mrrCents)}/mo · {a.companies} companies · {a.users} users · frozen{' '}
                      {new Date(a.createdAt).toLocaleDateString()}
                      {a.createdByName ? ` by ${a.createdByName}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadArchive(a.id, a.label)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 ring-white/10 hover:bg-white/[0.06]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => removeArchive(a.id)}
                    className="p-1.5 rounded text-muted-foreground hover:text-red-300 hover:bg-red-500/10"
                    aria-label="Delete archive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading
                ? 'Loading…'
                : 'Nothing archived yet. Archiving freezes a period’s figures, so an old report keeps saying what it said.'}
            </p>
          )}
        </FounderCard>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <FounderCard title="Security posture">
          <div className="space-y-2">
            {data?.posture.map((p) => (
              <div key={p.label} className="flex gap-2">
                <span className="mt-0.5 shrink-0">
                  {p.status === true ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : p.status === false ? (
                    <Circle className="w-4 h-4 text-red-400" />
                  ) : (
                    <Minus className="w-4 h-4 text-muted-foreground" />
                  )}
                </span>
                <div>
                  <p className="text-sm">{p.label}</p>
                  <p className="text-xs text-muted-foreground">{p.detail}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            A dash means the claim cannot be checked from inside the application — it is listed
            rather than left out, because a checklist of only ticks is worth nothing.
          </p>
        </FounderCard>

        <FounderCard title="Platform audit trail">
          {data && data.audit.length > 0 ? (
            <div className="max-h-96 overflow-y-auto divide-y divide-white/[0.06]">
              {data.audit.map((e) => (
                <div key={e.id} className="py-2">
                  <p className="text-sm">
                    <span className="font-medium">{e.action}</span>
                    {e.summary ? <span className="text-muted-foreground"> — {e.summary}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {e.actorName ?? 'system'} · {new Date(e.createdAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading ? 'Loading…' : 'Nothing recorded yet.'}
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Every action taken in the Founder area, with who did it. Separate from the per-company
            security log, which a customer can switch off in their own settings.
          </p>
        </FounderCard>
      </div>
    </FounderPage>
  )
}
