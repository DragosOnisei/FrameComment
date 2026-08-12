'use client'

/**
 * 6.6.0 Founder → CRM (Faza 3).
 *
 * The pipeline of people who want to become customers: where each one stands,
 * what was said, and what you owe them next. Access requests from the website
 * land here automatically; registering a company moves a lead to CUSTOMER by
 * itself, and the timeline records that it was the system that did it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  Check,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { FounderCard, FounderPage, MetricTile } from '@/components/founder/FounderPage'
import { logError } from '@/lib/logging'

type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'TRIAL' | 'CUSTOMER' | 'LOST'

const STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'TRIAL', 'CUSTOMER', 'LOST']

const STATUS_STYLE: Record<LeadStatus, string> = {
  NEW: 'bg-sky-500/10 text-sky-300 ring-sky-500/30',
  CONTACTED: 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/30',
  QUALIFIED: 'bg-violet-500/10 text-violet-300 ring-violet-500/30',
  TRIAL: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  CUSTOMER: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  LOST: 'bg-white/[0.05] text-muted-foreground ring-white/10',
}

interface Lead {
  id: string
  name: string
  email: string
  company: string | null
  profession: string | null
  source: string
  status: LeadStatus
  estimatedValueCents: number | null
  notes: string | null
  convertedOrgId: string | null
  convertedAt: string | null
  lastContactedAt: string | null
  createdAt: string
  activityCount: number
  nextFollowUpAt: string | null
  followUpOverdue: boolean
}

interface Summary {
  total: number
  open: number
  byStatus: Record<LeadStatus, number>
  followUpsDue: number
  wonThisMonth: number
  conversionRate: number | null
  pipelineValueCents: number
}

interface Activity {
  id: string
  type: string
  body: string | null
  authorName: string | null
  createdAt: string
}

interface FollowUp {
  id: string
  dueAt: string
  doneAt: string | null
  note: string | null
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

export default function FounderCrmPage() {
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | LeadStatus>('OPEN')
  const [query, setQuery] = useState('')
  const [leads, setLeads] = useState<Lead[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError('')
      const params = new URLSearchParams({ status: filter })
      if (query.trim()) params.set('q', query.trim())
      const res = await apiFetch(`/api/founder/crm/leads?${params.toString()}`)
      if (!res.ok) throw new Error('Could not load the pipeline')
      const data = await res.json()
      setLeads(data.leads ?? [])
      setSummary(data.summary ?? null)
    } catch (err) {
      logError('[crm] load failed:', err)
      setError(err instanceof Error ? err.message : 'Could not load the pipeline')
    } finally {
      setLoading(false)
    }
  }, [filter, query])

  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, query])

  const runImport = async () => {
    try {
      setImporting(true)
      setNotice('')
      const res = await apiFetch('/api/founder/crm/import', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Import failed')
      setNotice(
        `Scanned ${data.scanned} access request${data.scanned === 1 ? '' : 's'}: ${data.imported} imported, ${data.skipped} already known or unparseable.`,
      )
      await load()
    } catch (err) {
      logError('[crm] import failed:', err)
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const counts = summary?.byStatus
  const chips: Array<{ key: 'ALL' | 'OPEN' | LeadStatus; label: string; count?: number }> = useMemo(
    () => [
      { key: 'OPEN', label: 'Open', count: summary?.open },
      { key: 'ALL', label: 'All', count: summary?.total },
      ...STATUSES.map((s) => ({ key: s, label: s[0] + s.slice(1).toLowerCase(), count: counts?.[s] })),
    ],
    [summary, counts],
  )

  return (
    <FounderPage title="CRM" subtitle="Everyone who wants in, and what you owe them next.">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Open leads"
          value={summary ? String(summary.open) : null}
          hint={summary ? `${summary.total} in total` : 'Not yet won or lost'}
        />
        <MetricTile
          label="Follow-ups due"
          value={summary ? String(summary.followUpsDue) : null}
          hint="Scheduled for today or earlier"
        />
        <MetricTile
          label="Won this month"
          value={summary ? String(summary.wonThisMonth) : null}
          hint={summary ? `${summary.byStatus.CUSTOMER} customers all time` : 'Became customers'}
        />
        <MetricTile
          label="Conversion"
          value={summary?.conversionRate != null ? `${Math.round(summary.conversionRate * 100)}%` : null}
          hint="Of leads that reached a decision"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-lg bg-white/[0.04] ring-1 ring-white/10 p-0.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={`h-8 px-3 rounded-md text-xs font-medium transition-colors ${
                filter === c.key
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {c.label}
              {typeof c.count === 'number' && (
                <span className="ml-1.5 opacity-60 tabular-nums">{c.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, email, company"
            className="h-8 w-56 rounded-md bg-white/[0.04] ring-1 ring-white/10 pl-8 pr-2 text-xs outline-none focus:ring-primary/40"
          />
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
          onClick={runImport}
          disabled={importing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 ring-white/10 hover:bg-white/[0.06] transition-colors disabled:opacity-40"
        >
          {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          Import access requests
        </button>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary/20 text-primary px-3 text-xs font-medium ring-1 ring-primary/30 hover:bg-primary/30 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New lead
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-3 py-2 text-sm text-muted-foreground">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="mt-3">
        <FounderCard
          title="Pipeline"
          action={
            summary && summary.pipelineValueCents > 0 ? (
              <span className="text-xs text-muted-foreground">
                {money(summary.pipelineValueCents)} estimated in open leads
              </span>
            ) : undefined
          }
        >
          {leads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {loading
                ? 'Loading…'
                : query
                  ? 'Nobody matches that search.'
                  : filter === 'OPEN'
                    ? 'No open leads. Import past access requests or add one by hand.'
                    : 'Nothing here yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground text-left">
                    <th className="font-medium py-2 pr-3">Person</th>
                    <th className="font-medium py-2 pr-3">Status</th>
                    <th className="font-medium py-2 pr-3">Source</th>
                    <th className="font-medium py-2 pr-3">Next follow-up</th>
                    <th className="font-medium py-2 text-right">Est. value</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr
                      key={l.id}
                      onClick={() => setSelectedId(l.id)}
                      className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.03]"
                    >
                      <td className="py-2 pr-3">
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.email}
                          {l.company ? ` · ${l.company}` : ''}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ring-1 ${STATUS_STYLE[l.status]}`}
                        >
                          {l.status[0] + l.status.slice(1).toLowerCase()}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {l.source}
                        <div>{shortDate(l.createdAt)}</div>
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {l.nextFollowUpAt ? (
                          <span className={l.followUpOverdue ? 'text-red-300' : 'text-muted-foreground'}>
                            {shortDate(l.nextFollowUpAt)}
                            {l.followUpOverdue ? ' · overdue' : ''}
                          </span>
                        ) : (
                          <span className="text-foreground/30">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {l.estimatedValueCents ? (
                          money(l.estimatedValueCents)
                        ) : (
                          <span className="text-foreground/30">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </FounderCard>
      </div>

      {selectedId && (
        <LeadDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
      {creating && (
        <NewLeadDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            load()
          }}
        />
      )}
    </FounderPage>
  )
}

/** Detail panel: history, status, notes, follow-ups. */
function LeadDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string
  onClose: () => void
  onChanged: () => void
}) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [noteType, setNoteType] = useState<'NOTE' | 'CALL' | 'EMAIL' | 'DEMO'>('NOTE')
  const [noteText, setNoteText] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')
  const [followUpNote, setFollowUpNote] = useState('')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const res = await apiFetch(`/api/founder/crm/leads/${id}`)
      if (!res.ok) throw new Error('Could not load the lead')
      const data = await res.json()
      setLead(data.lead)
      setActivities(data.activities ?? [])
      setFollowUps(data.followUps ?? [])
    } catch (err) {
      logError('[crm] lead detail failed:', err)
      setError(err instanceof Error ? err.message : 'Could not load the lead')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const patch = async (body: Record<string, unknown>) => {
    try {
      setSaving(true)
      const res = await apiFetch(`/api/founder/crm/leads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Could not save')
      await load()
      onChanged()
    } catch (err) {
      logError('[crm] patch failed:', err)
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const addActivity = async () => {
    if (!noteText.trim()) return
    try {
      setSaving(true)
      const res = await apiFetch(`/api/founder/crm/leads/${id}/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: noteType, body: noteText }),
      })
      if (!res.ok) throw new Error('Could not log that')
      setNoteText('')
      await load()
      onChanged()
    } catch (err) {
      logError('[crm] activity failed:', err)
      setError(err instanceof Error ? err.message : 'Could not log that')
    } finally {
      setSaving(false)
    }
  }

  const scheduleFollowUp = async () => {
    if (!followUpDate) return
    try {
      setSaving(true)
      const res = await apiFetch('/api/founder/crm/follow-ups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: id,
          dueAt: new Date(`${followUpDate}T09:00:00`).toISOString(),
          note: followUpNote,
        }),
      })
      if (!res.ok) throw new Error('Could not schedule that')
      setFollowUpDate('')
      setFollowUpNote('')
      await load()
      onChanged()
    } catch (err) {
      logError('[crm] follow-up failed:', err)
      setError(err instanceof Error ? err.message : 'Could not schedule that')
    } finally {
      setSaving(false)
    }
  }

  const completeFollowUp = async (followUpId: string, done: boolean) => {
    await apiFetch('/api/founder/crm/follow-ups', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: followUpId, done }),
    })
    await load()
    onChanged()
  }

  const removeLead = async () => {
    if (!confirm('Delete this lead and its whole history? This cannot be undone.')) return
    await apiFetch(`/api/founder/crm/leads/${id}`, { method: 'DELETE' })
    onChanged()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0" onClick={onClose} />
      {/* Same frosted-glass shell as every other modal in the app
          (NewFolderDialog / TemplateModal): 6% white tint, hairline ring,
          explicit inline backdrop-filter so the blur survives purging. */}
      <div
        className="relative h-full w-full max-w-lg overflow-y-auto bg-white/[0.06] ring-1 ring-white/10 text-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
        style={{
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-white/[0.08] px-4 py-3 border-b border-white/[0.08]">
          <h2 className="flex-1 text-sm font-semibold truncate">
            {lead?.name ?? (loading ? 'Loading…' : 'Lead')}
          </h2>
          {saving && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-white/[0.08]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="m-4 rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {lead && (
          <div className="p-4 space-y-4">
            <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 p-3 text-sm">
              <div className="text-muted-foreground text-xs">{lead.email}</div>
              {lead.company && <div className="mt-0.5">{lead.company}</div>}
              {lead.profession && (
                <div className="text-xs text-muted-foreground mt-0.5">{lead.profession}</div>
              )}
              <div className="text-xs text-muted-foreground mt-1.5">
                From {lead.source} · {shortDate(lead.createdAt)}
                {lead.convertedOrgId && (
                  <> · became company <span className="text-foreground/80">{lead.convertedOrgId}</span></>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Status</p>
              <div className="flex flex-wrap gap-1.5">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => s !== lead.status && patch({ status: s })}
                    className={`rounded-full px-2.5 py-1 text-xs ring-1 transition-colors ${
                      s === lead.status
                        ? STATUS_STYLE[s]
                        : 'bg-white/[0.03] text-muted-foreground ring-white/10 hover:text-foreground'
                    }`}
                  >
                    {s[0] + s.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground">
                Company
                <input
                  defaultValue={lead.company ?? ''}
                  onBlur={(e) =>
                    e.target.value !== (lead.company ?? '') && patch({ company: e.target.value })
                  }
                  className="mt-1 w-full h-8 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2 text-sm text-foreground outline-none focus:ring-primary/40"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Estimated value ($ / mo)
                <input
                  type="number"
                  min={0}
                  defaultValue={lead.estimatedValueCents ? lead.estimatedValueCents / 100 : ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    patch({ estimatedValueCents: v === '' ? null : Math.round(Number(v) * 100) })
                  }}
                  className="mt-1 w-full h-8 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2 text-sm text-foreground outline-none focus:ring-primary/40"
                />
              </label>
            </div>

            <label className="block text-xs text-muted-foreground">
              Notes
              <textarea
                defaultValue={lead.notes ?? ''}
                onBlur={(e) => e.target.value !== (lead.notes ?? '') && patch({ notes: e.target.value })}
                rows={3}
                className="mt-1 w-full rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2 py-1.5 text-sm text-foreground outline-none focus:ring-primary/40 resize-y"
              />
            </label>

            <div className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 p-3">
              <p className="text-xs text-muted-foreground mb-2">Follow-ups</p>
              {followUps.length === 0 && (
                <p className="text-xs text-muted-foreground">Nothing scheduled.</p>
              )}
              {followUps.map((f) => (
                <div key={f.id} className="flex items-center gap-2 py-1 text-sm">
                  <button
                    type="button"
                    onClick={() => completeFollowUp(f.id, !f.doneAt)}
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      f.doneAt ? 'bg-emerald-500/20 border-emerald-500/40' : 'border-white/20'
                    }`}
                    aria-label={f.doneAt ? 'Reopen' : 'Mark done'}
                  >
                    {f.doneAt && <Check className="w-3 h-3 text-emerald-300" />}
                  </button>
                  <span className={f.doneAt ? 'line-through text-muted-foreground' : ''}>
                    {shortDate(f.dueAt)}
                    {f.note ? ` — ${f.note}` : ''}
                  </span>
                </div>
              ))}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <input
                  type="date"
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                  className="h-8 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2 text-xs outline-none focus:ring-primary/40"
                />
                <input
                  value={followUpNote}
                  onChange={(e) => setFollowUpNote(e.target.value)}
                  placeholder="What for?"
                  className="h-8 flex-1 min-w-[120px] rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2 text-xs outline-none focus:ring-primary/40"
                />
                <button
                  type="button"
                  onClick={scheduleFollowUp}
                  disabled={!followUpDate}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs ring-1 ring-white/10 hover:bg-white/[0.06] disabled:opacity-40"
                >
                  <CalendarClock className="w-3.5 h-3.5" />
                  Schedule
                </button>
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Log something</p>
              <div className="flex gap-1.5 mb-1.5">
                {(['NOTE', 'CALL', 'EMAIL', 'DEMO'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNoteType(t)}
                    className={`h-7 px-2.5 rounded-md text-xs ring-1 transition-colors ${
                      noteType === t
                        ? 'bg-primary/20 text-primary ring-primary/30'
                        : 'ring-white/10 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t[0] + t.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={2}
                placeholder="What happened?"
                className="w-full rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2 py-1.5 text-sm outline-none focus:ring-primary/40 resize-y"
              />
              <button
                type="button"
                onClick={addActivity}
                disabled={!noteText.trim() || saving}
                className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary/20 text-primary px-3 text-xs font-medium ring-1 ring-primary/30 hover:bg-primary/30 disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1.5">History</p>
              <div className="space-y-2">
                {activities.length === 0 && (
                  <p className="text-xs text-muted-foreground">Nothing logged yet.</p>
                )}
                {activities.map((a) => (
                  <div key={a.id} className="rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="uppercase tracking-wide">{a.type.replace('_', ' ')}</span>
                      <span>·</span>
                      <span>{new Date(a.createdAt).toLocaleString()}</span>
                      {a.authorName && (
                        <>
                          <span>·</span>
                          <span>{a.authorName}</span>
                        </>
                      )}
                    </div>
                    {a.body && <p className="mt-1 text-sm whitespace-pre-wrap">{a.body}</p>}
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={removeLead}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-red-300 ring-1 ring-red-500/30 hover:bg-red-500/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete lead
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function NewLeadDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    try {
      setBusy(true)
      setError('')
      const res = await apiFetch('/api/founder/crm/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, company }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Could not create the lead')
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the lead')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="relative w-full max-w-sm rounded-xl bg-white/[0.06] ring-1 ring-white/10 text-white p-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
        style={{
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        <h2 className="text-sm font-semibold mb-3">New lead</h2>
        {error && (
          <div className="mb-3 rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="w-full h-9 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2.5 text-sm outline-none focus:ring-primary/40"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            className="w-full h-9 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2.5 text-sm outline-none focus:ring-primary/40"
          />
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Company (optional)"
            className="w-full h-9 rounded-md bg-white/[0.04] ring-1 ring-white/10 px-2.5 text-sm outline-none focus:ring-primary/40"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md text-xs text-muted-foreground hover:text-foreground ring-1 ring-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim() || !email.trim()}
            className="h-8 px-3 rounded-md bg-primary/20 text-primary text-xs font-medium ring-1 ring-primary/30 hover:bg-primary/30 disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
