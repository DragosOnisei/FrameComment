'use client'

/**
 * 6.7.0 Founder → AI Agents (Faza 4).
 *
 * Three agents that read what this instance already knows and write a report:
 * the weekly digest, the pipeline review, and churn watch. Run by hand for
 * now, each run recorded with its duration and cost.
 *
 * The page is explicit about two things, because both are easy to get wrong
 * silently: the figures in a report are computed in code (never by the model),
 * and when no OpenAI key is configured the report still ships — as facts,
 * without narrative.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bot, Loader2, Play, RefreshCw, X } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { FounderCard, FounderPage } from '@/components/founder/FounderPage'
import { logError } from '@/lib/logging'

interface AgentRow {
  id: string
  name: string
  type: string
  enabled: boolean
  cadence: string
  lastRunAt: string | null
  catalog: { label: string; reads: string; question: string } | null
  lastRun: {
    id: string
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'
    startedAt: string
    durationMs: number | null
    costCents: number | null
    model: string | null
    error: string | null
    reportId: string | null
    reportTitle: string | null
    hasNarrative: boolean
  } | null
}

interface ReportRow {
  id: string
  title: string
  hasNarrative: boolean
  createdAt: string
  agentName: string
  costCents: number | null
  model: string | null
}

function cost(cents: number | null): string {
  if (cents == null) return 'no model call'
  if (cents === 0) return 'under $0.01'
  return `$${(cents / 100).toFixed(2)}`
}

export default function FounderAgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [reports, setReports] = useState<ReportRow[]>([])
  const [modelConfigured, setModelConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [openReportId, setOpenReportId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError('')
      const res = await apiFetch('/api/founder/agents')
      if (!res.ok) throw new Error('Could not load agents')
      const data = await res.json()
      setAgents(data.agents ?? [])
      setReports(data.reports ?? [])
      setModelConfigured(!!data.modelConfigured)
    } catch (err) {
      logError('[agents] load failed:', err)
      setError(err instanceof Error ? err.message : 'Could not load agents')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (id: string) => {
    try {
      setRunning(id)
      setError('')
      const res = await apiFetch(`/api/founder/agents/${id}/run`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'The run failed')
      await load()
    } catch (err) {
      logError('[agents] run failed:', err)
      setError(err instanceof Error ? err.message : 'The run failed')
    } finally {
      setRunning(null)
    }
  }

  const toggle = async (id: string, enabled: boolean) => {
    await apiFetch(`/api/founder/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    await load()
  }

  return (
    <FounderPage
      title="AI Agents"
      subtitle="Jobs that read this instance's own data and write you a report."
    >
      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={load}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground ring-1 ring-white/10 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {!modelConfigured && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30 px-3 py-2 text-sm text-amber-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            No OpenAI key is configured, so reports will contain the measured figures without a
            written summary. Everything else works — the numbers never come from a model.
          </span>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        {agents.map((a) => (
          <FounderCard key={a.id} title={a.name}>
            <div className="flex items-start gap-2">
              <Bot className="w-4 h-4 mt-0.5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">{a.catalog?.question}</p>
                <p className="mt-1 text-xs text-muted-foreground">Reads: {a.catalog?.reads}</p>
              </div>
            </div>

            <div className="mt-3 rounded-lg bg-white/[0.03] ring-1 ring-white/10 px-3 py-2 text-xs">
              {a.lastRun ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={
                        a.lastRun.status === 'SUCCEEDED'
                          ? 'text-emerald-300'
                          : a.lastRun.status === 'FAILED'
                            ? 'text-red-300'
                            : 'text-amber-300'
                      }
                    >
                      {a.lastRun.status.toLowerCase()}
                    </span>
                    <span className="text-muted-foreground">
                      · {new Date(a.lastRun.startedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {a.lastRun.durationMs != null ? `${(a.lastRun.durationMs / 1000).toFixed(1)}s` : '—'}
                    {' · '}
                    {cost(a.lastRun.costCents)}
                    {a.lastRun.model ? ` · ${a.lastRun.model}` : ''}
                  </div>
                  {a.lastRun.error && (
                    <p className="mt-1 text-red-300">{a.lastRun.error}</p>
                  )}
                  {a.lastRun.reportId && (
                    <button
                      type="button"
                      onClick={() => setOpenReportId(a.lastRun!.reportId)}
                      className="mt-1.5 text-primary hover:underline"
                    >
                      Open last report
                    </button>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Never run.</span>
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => run(a.id)}
                disabled={!a.enabled || running === a.id}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary/20 text-primary px-3 text-xs font-medium ring-1 ring-primary/30 hover:bg-primary/30 transition-colors disabled:opacity-40"
              >
                {running === a.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {running === a.id ? 'Running…' : 'Run now'}
              </button>
              <button
                type="button"
                onClick={() => toggle(a.id, !a.enabled)}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground ring-1 ring-white/10"
              >
                {a.enabled ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          </FounderCard>
        ))}
        {agents.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground">
            No agents are registered. They are created by the database migration.
          </p>
        )}
      </div>

      <div className="mt-4">
        <FounderCard title="Reports">
          {reports.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {loading ? 'Loading…' : 'No reports yet. Run an agent above.'}
            </p>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {reports.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setOpenReportId(r.id)}
                  className="w-full text-left py-2 hover:bg-white/[0.03] px-1 -mx-1 rounded"
                >
                  <div className="text-sm">{r.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.agentName} · {new Date(r.createdAt).toLocaleString()} · {cost(r.costCents)}
                    {!r.hasNarrative && ' · figures only'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </FounderCard>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Every figure in a report is computed from the database in code. The model, when configured,
        is only asked to write the summary sentence over those figures — it is never the source of a
        number. Agents read; they do not scan, probe, or change anything.
      </p>

      {openReportId && (
        <ReportModal id={openReportId} onClose={() => setOpenReportId(null)} />
      )}
    </FounderPage>
  )
}

/** Minimal markdown rendering — headings, bullets, bold. No library for this. */
function renderMarkdown(md: string) {
  return md.split('\n').map((line, i) => {
    const key = `l${i}`
    const bold = (text: string) =>
      text.split(/\*\*(.+?)\*\*/g).map((part, j) =>
        j % 2 === 1 ? (
          <strong key={j} className="font-semibold text-foreground">
            {part}
          </strong>
        ) : (
          <span key={j}>{part}</span>
        ),
      )

    if (line.startsWith('## ')) {
      return (
        <h3 key={key} className="mt-4 mb-1.5 text-sm font-semibold">
          {line.slice(3)}
        </h3>
      )
    }
    if (line.startsWith('- ')) {
      return (
        <p key={key} className="text-sm text-muted-foreground pl-3 -indent-3">
          • {bold(line.slice(2))}
        </p>
      )
    }
    if (line.startsWith('_') && line.endsWith('_') && line.length > 2) {
      return (
        <p key={key} className="mt-2 text-xs italic text-muted-foreground">
          {line.slice(1, -1)}
        </p>
      )
    }
    if (!line.trim()) return <div key={key} className="h-2" />
    return (
      <p key={key} className="text-sm">
        {bold(line)}
      </p>
    )
  })
}

function ReportModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [report, setReport] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch(`/api/founder/reports/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Not found'))))
      .then(setReport)
      .catch((err) => logError('[agents] report failed:', err))
      .finally(() => setLoading(false))
  }, [id])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="relative w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl bg-white/[0.06] ring-1 ring-white/10 text-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
        style={{
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        <div className="sticky top-0 flex items-center gap-2 bg-white/[0.08] px-4 py-3 border-b border-white/[0.08]">
          <h2 className="flex-1 text-sm font-semibold truncate">
            {report?.title ?? (loading ? 'Loading…' : 'Report')}
          </h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-white/[0.08]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">
          {report && (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                {report.agentName} · {new Date(report.createdAt).toLocaleString()} ·{' '}
                {report.durationMs != null ? `${(report.durationMs / 1000).toFixed(1)}s` : '—'} ·{' '}
                {cost(report.costCents)}
                {report.model ? ` · ${report.model}` : ''}
                {!report.hasNarrative && ' · figures only, no model summary'}
              </p>
              <div>{renderMarkdown(report.markdown)}</div>
            </>
          )}
          {!report && !loading && (
            <p className="text-sm text-muted-foreground">That report is gone.</p>
          )}
        </div>
      </div>
    </div>
  )
}
