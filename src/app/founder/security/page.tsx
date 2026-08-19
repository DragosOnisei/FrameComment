'use client'

/**
 * 6.18.0 Founder → Security.
 *
 * Two halves, in the order a sceptical reader needs them:
 *
 *   1. WHAT IS HAPPENING — every attempt to authenticate against this
 *      installation, where it came from, and what it tried. Wordfence's
 *      dashboard, which is the shape people already recognise.
 *   2. WHETHER WE ARE CONFIGURED CORRECTLY — the scan, with a live stage strip
 *      and findings that name the observed value and the fix.
 *
 * The order matters for the audience. An investor's first question is not "do
 * you have security features", it is "how would you know if something was
 * wrong" — and traffic you can point at answers that before any checklist does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, Ban, CheckCircle2, Globe2, Loader2, Lock,
  MinusCircle, RefreshCw, Shield, ShieldAlert, ShieldCheck, XCircle,
} from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

// ── types ───────────────────────────────────────────────────────────────────
interface TopIp {
  ip: string; country: string | null; countryName: string | null; city: string | null
  asn: string | null; attempts: number; lastSeen: string; blocked: boolean
}
interface Overview {
  windowDays: number
  retentionDays: number
  geoip: { available: boolean; directory: string; city: boolean; asn: boolean }
  totals: { total: number; failed: number; succeeded: number; critical: number; uniqueIps: number }
  topIps: TopIp[]
  topCountries: Array<{ country: string | null; countryName: string | null; ips: number; attempts: number }>
  topIdentifiers: Array<{ identifier: string; attempts: number; existingUser: boolean }>
  recent: Array<Record<string, any>>
  daily: Array<{ day: string; failed: number; succeeded: number }>
  lastScan: Record<string, any> | null
}
interface Finding {
  id: string; stage: string; checkId: string; title: string
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED'
  severity: string; detail: string | null; remediation: string | null
  impact: string | null
}
interface ScanState {
  stages: Array<{ id: string; label: string; blurb: string }>
  scan: (Record<string, any> & { findings: Finding[]; log: Array<{ at: string; text: string }> }) | null
}

/**
 * Flag emoji from a country code. Regional indicator symbols, computed rather
 * than fetched — no sprite sheet, no icon library, nothing to update when a
 * country changes its flag.
 */
function flag(code: string | null | undefined): string {
  if (!code || code.length !== 2 || !/^[A-Za-z]{2}$/.test(code)) return '🏳️'
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)),
  )
}

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const KIND_LABEL: Record<string, string> = {
  LOGIN_FAILED: 'Failed sign-in',
  LOGIN_SUCCESS: 'Signed in',
  LOGIN_LOCKED: 'Locked out',
  RATE_LIMITED: 'Rate limited',
  TOKEN_DEVICE_MISMATCH: 'Token from another device',
  TOKEN_REPLAY: 'Token refused',
  BLOCKED_IP: 'Blocked address',
  SHARE_PASSWORD_FAILED: 'Share password failed',
}

export default function FounderSecurityPage() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [scanState, setScanState] = useState<ScanState | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [windowDays, setWindowDays] = useState(7)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadOverview = useCallback(async (days: number) => {
    try {
      const res = await apiFetch(`/api/founder/security/overview?days=${days}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOverview(await res.json())
      setError(null)
    } catch (err) {
      setError('Could not load security data.')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadScan = useCallback(async () => {
    try {
      const res = await apiFetch('/api/founder/security/scan')
      if (res.ok) setScanState(await res.json())
    } catch {
      /* the page is still useful without it */
    }
  }, [])

  useEffect(() => {
    void loadOverview(windowDays)
  }, [windowDays, loadOverview])

  useEffect(() => {
    void loadScan()
  }, [loadScan])

  // Poll only while a scan is running. A dashboard that refetches forever is a
  // dashboard nobody leaves open, because it keeps the machine awake.
  const running = scanState?.scan?.status === 'RUNNING'
  useEffect(() => {
    if (!running) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    pollRef.current = setInterval(() => { void loadScan() }, 1500)
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [running, loadScan])

  const startScan = async () => {
    setStarting(true)
    try {
      const res = await apiFetch('/api/founder/security/scan', { method: 'POST' })
      if (res.ok) await loadScan()
    } finally {
      setStarting(false)
    }
  }

  const toggleBlock = async (ip: string, blocked: boolean) => {
    // Optimistic: the row flips immediately and the refetch confirms it. A
    // spinner on a button that takes 80ms is worse than no feedback at all.
    setOverview((prev) =>
      prev ? { ...prev, topIps: prev.topIps.map((r) => (r.ip === ip ? { ...r, blocked: !blocked } : r)) } : prev,
    )
    await apiFetch('/api/founder/security/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, block: !blocked }),
    }).catch(() => {})
    void loadOverview(windowDays)
  }

  const scan = scanState?.scan
  const findingsByStage = useMemo(() => {
    const map = new Map<string, Finding[]>()
    for (const f of scan?.findings ?? []) {
      const list = map.get(f.stage) ?? []
      list.push(f)
      map.set(f.stage, list)
    }
    return map
  }, [scan])

  const problems = (scan?.findings ?? []).filter((f) => f.status === 'FAIL' || f.status === 'WARN')

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 p-10">
        <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-white/70 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex-1 min-w-0 max-w-full overflow-x-hidden p-4 sm:p-6 lg:p-8 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            Security
          </h1>
          <p className="mt-1 text-sm text-white/50">
            Every attempt to reach this installation, and whether it is configured to resist them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg ring-1 ring-white/12 overflow-hidden">
            {[1, 7, 30].map((d) => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                className={`px-3 h-8 text-xs font-medium transition-colors ${
                  windowDays === d ? 'bg-primary text-primary-foreground' : 'text-white/60 hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                {d === 1 ? '24h' : `${d}d`}
              </button>
            ))}
          </div>
          <button
            onClick={() => void loadOverview(windowDays)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-white/75 bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/12 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl ring-1 ring-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <section className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <Stat label="Attempts" value={overview?.totals.total ?? 0} icon={Activity} tone="neutral" />
        <Stat label="Failed" value={overview?.totals.failed ?? 0} icon={XCircle} tone={overview?.totals.failed ? 'warn' : 'good'} />
        <Stat label="Unique addresses" value={overview?.totals.uniqueIps ?? 0} icon={Globe2} tone="neutral" />
        <Stat label="Critical events" value={overview?.totals.critical ?? 0} icon={ShieldAlert} tone={overview?.totals.critical ? 'bad' : 'good'} />
        <Stat
          label="Security score"
          value={typeof scan?.score === 'number' ? scan.score : '—'}
          suffix={typeof scan?.score === 'number' ? '/100' : ''}
          icon={ShieldCheck}
          tone={typeof scan?.score !== 'number' ? 'neutral' : scan.score >= 90 ? 'good' : scan.score >= 70 ? 'warn' : 'bad'}
        />
      </section>

      {!overview?.geoip.available && (
        <p className="text-[11px] text-white/40 flex items-center gap-1.5">
          <Globe2 className="w-3.5 h-3.5 shrink-0" />
          No local geolocation database, so flags come only from Cloudflare when it is in front.
          Drop GeoLite2-City.mmdb into <code className="text-white/55">{overview?.geoip.directory}</code> for
          full coverage — resolved locally, so no visitor address ever leaves this machine.
        </p>
      )}

      {/* ── Blocked IPs / countries / usernames ─────────────────────────── */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="Top addresses by failed attempts" icon={Ban}>
          {overview && overview.topIps.length > 0 ? (
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-white/40">
                  <th className="text-left font-medium pb-2">Address</th>
                  {/* 6.19.0: origin drops out below `sm` rather than pushing
                      the table into a horizontal scrollbar. The address and
                      the count are the two columns you actually scan; the
                      country is context, and context is what you give up
                      first on a narrow screen. */}
                  <th className="text-left font-medium pb-2 hidden sm:table-cell">Origin</th>
                  <th className="text-right font-medium pb-2">Attempts</th>
                  <th className="text-right font-medium pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {overview.topIps.map((row) => (
                  <tr key={row.ip} className="border-t border-white/[0.06]">
                    <td className="py-2 pr-2">
                      <span className="font-mono text-xs text-white/85 break-all">{row.ip}</span>
                      <span className="block text-[10px] text-white/35">{timeAgo(row.lastSeen)}</span>
                    </td>
                    <td className="py-2 pr-2 hidden sm:table-cell">
                      <span className="text-base leading-none mr-1.5">{flag(row.country)}</span>
                      <span className="text-xs text-white/70">{row.countryName || row.country || 'Unknown'}</span>
                      {row.asn && <span className="block text-[10px] text-white/35 truncate max-w-[180px]">{row.asn}</span>}
                    </td>
                    <td className="py-2 text-right font-semibold text-white/85 tabular-nums">{row.attempts}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => void toggleBlock(row.ip, row.blocked)}
                        className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors ${
                          row.blocked
                            ? 'text-white/50 bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/12'
                            : 'text-destructive bg-destructive/10 hover:bg-destructive/20 ring-1 ring-destructive/25'
                        }`}
                      >
                        {row.blocked ? 'Unblock' : 'Block'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No failed attempts in this window. That is the good outcome.</Empty>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Countries" icon={Globe2}>
            {overview && overview.topCountries.length > 0 ? (
              <ul className="space-y-1.5">
                {overview.topCountries.map((c) => (
                  <li key={c.country} className="flex items-center gap-2 text-sm">
                    <span className="text-base leading-none">{flag(c.country)}</span>
                    <span className="text-white/75 flex-1 truncate">{c.countryName || c.country}</span>
                    <span className="text-[11px] text-white/40">{c.ips} IP{c.ips === 1 ? '' : 's'}</span>
                    <span className="font-semibold text-white/85 tabular-nums w-10 text-right">{c.attempts}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Nothing to show yet.</Empty>
            )}
          </Panel>

          <Panel title="Usernames tried" icon={Lock}>
            {overview && overview.topIdentifiers.length > 0 ? (
              <ul className="space-y-1.5">
                {overview.topIdentifiers.map((u) => (
                  <li key={u.identifier} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-white/75 flex-1 truncate">{u.identifier}</span>
                    {/* Whether the guessed name exists is the useful column:
                        400 attempts on a real account is a different problem
                        from 400 attempts on "admin", which we do not have. */}
                    <span className={`text-[10px] font-semibold uppercase ${u.existingUser ? 'text-destructive' : 'text-emerald-400/70'}`}>
                      {u.existingUser ? 'Real account' : 'No such user'}
                    </span>
                    <span className="font-semibold text-white/85 tabular-nums w-8 text-right">{u.attempts}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No failed sign-ins in this window.</Empty>
            )}
          </Panel>
        </div>
      </section>

      {/* ── The scan ────────────────────────────────────────────────────── */}
      <section className="rounded-xl ring-1 ring-white/10 bg-white/[0.03] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              Configuration scan
            </h2>
            <p className="text-[11px] text-white/45 mt-0.5">
              {scan?.finishedAt
                ? `Last run ${timeAgo(scan.finishedAt)}${scan.startedByName ? ` by ${scan.startedByName}` : ''}`
                : 'Never run'}
              {/* 6.18.1: how many checks, how long, and how many could not run.
                  "Did that actually do anything?" is the first thing anyone
                  asks of a scan that finishes in under a second, and pass /
                  warn / fail counts alone cannot answer it — a run with 34
                  checks and no skips looks identical to one where most stages
                  quietly bailed out. */}
              {scan?.status === 'COMPLETED' && (
                <>
                  {' · '}
                  {(scan.passed ?? 0) + (scan.warnings ?? 0) + (scan.failures ?? 0) + (scan.skipped ?? 0)} checks
                  {typeof scan.durationMs === 'number' && ` in ${(scan.durationMs / 1000).toFixed(1)}s`}
                  {(scan.skipped ?? 0) > 0 && ` · ${scan.skipped} could not run`}
                </>
              )}
            </p>
            {/* A scan of a laptop is not evidence about production. Saying
                which installation the run describes stops a development result
                being shown to anyone as if it were the live posture. */}
            {scan?.environment && (
              <p className="text-[11px] text-white/30 mt-0.5 font-mono">{scan.environment}</p>
            )}
          </div>
          <button
            onClick={() => void startScan()}
            disabled={starting || running}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed transition-[filter]"
          >
            {running || starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
            {running ? 'Scanning…' : starting ? 'Starting…' : 'Run scan'}
          </button>
        </div>

        {/*
          Stage strip.
          6.19.0: a wrapping grid, not a horizontal rail. The rail was
          `min-w-max` inside `overflow-x-auto`, which is a horizontal
          scrollbar by construction — and a scrollbar is a worse answer than
          a second row, because the stages past the edge are invisible rather
          than merely lower down. The connector lines went with it: they only
          ever made sense on a single line, and a wrapped strip with dangling
          connectors reads as broken.
        */}
        <div className="px-4 py-4">
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-12 gap-y-4 gap-x-2">
            {(scanState?.stages ?? []).map((stage) => {
              const stageFindings = findingsByStage.get(stage.id) ?? []
              const done = stageFindings.length > 0
              const hasFail = stageFindings.some((f) => f.status === 'FAIL')
              const hasWarn = stageFindings.some((f) => f.status === 'WARN')
              const allSkipped = done && stageFindings.every((f) => f.status === 'SKIPPED')
              const isCurrent = running && scan?.currentStage === stage.label
              return (
                <div
                  key={stage.id}
                  className="flex flex-col items-center gap-1.5 min-w-0"
                  title={`${stage.blurb}${done ? ` — ${stageFindings.length} checks` : ''}`}
                >
                  <span
                    className={`inline-flex h-7 w-7 items-center justify-center rounded-full ring-1 transition-colors ${
                      isCurrent ? 'bg-primary/20 ring-primary/50 text-primary'
                      : hasFail ? 'bg-destructive/15 ring-destructive/40 text-destructive'
                      : hasWarn ? 'bg-amber-400/15 ring-amber-400/40 text-amber-300'
                      : allSkipped ? 'bg-white/[0.06] ring-white/15 text-white/40'
                      : done ? 'bg-emerald-500/15 ring-emerald-400/40 text-emerald-300'
                      : 'bg-white/[0.04] ring-white/10 text-white/25'
                    }`}
                  >
                    {isCurrent ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : hasFail ? <XCircle className="w-4 h-4" />
                      : hasWarn ? <AlertTriangle className="w-4 h-4" />
                      : allSkipped ? <MinusCircle className="w-4 h-4" />
                      : done ? <CheckCircle2 className="w-4 h-4" />
                      : <Lock className="w-3 h-3" />}
                  </span>
                  <span className={`text-[10px] text-center leading-tight break-words ${done || isCurrent ? 'text-white/70' : 'text-white/30'}`}>
                    {stage.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {running && (
          <div className="px-4 pb-3">
            <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full bg-primary transition-[width] duration-500"
                style={{ width: `${scan?.progress ?? 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Live log — the reassurance that something real is happening. */}
        {(scan?.log?.length ?? 0) > 0 && (
          <div className="custom-scrollbar mx-4 mb-4 rounded-lg bg-black/30 ring-1 ring-white/[0.06] p-3 max-h-40 overflow-y-auto">
            {scan!.log.slice(-12).map((line, i) => (
              <p key={i} className="text-[11px] font-mono text-white/55 leading-relaxed">
                <span className="text-white/30">
                  [{new Date(line.at).toLocaleTimeString()}]
                </span>{' '}
                {line.text}
              </p>
            ))}
          </div>
        )}

        {/* Findings: problems first, because a wall of green hides the one red. */}
        {scan && scan.findings.length > 0 && (
          <div className="px-4 pb-4 space-y-4">
            <div className="flex flex-wrap gap-4 text-xs">
              <span className="text-emerald-300">{scan.passed} passed</span>
              <span className="text-amber-300">{scan.warnings} warnings</span>
              <span className="text-destructive">{scan.failures} failures</span>
              {(scan.skipped ?? 0) > 0 && (
                <span className="text-white/35" title="These checks need something this installation does not have — they are not passes.">
                  {scan.skipped} could not run
                </span>
              )}
            </div>

            {problems.length > 0 ? (
              <div className="space-y-2">
                {problems.map((f) => <FindingRow key={f.id} finding={f} />)}
              </div>
            ) : (
              <div className="rounded-lg bg-emerald-500/10 ring-1 ring-emerald-400/25 px-3 py-2.5 text-sm text-emerald-200 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                Every check passed.
              </div>
            )}

            <details className="group">
              <summary className="cursor-pointer text-xs text-white/45 hover:text-white/70 transition-colors">
                Show all {scan.findings.length} checks
              </summary>
              <div className="mt-2 space-y-2">
                {scan.findings.map((f) => <FindingRow key={`all-${f.id}`} finding={f} />)}
              </div>
            </details>
          </div>
        )}
      </section>

      {/* ── Raw feed ────────────────────────────────────────────────────── */}
      <Panel title="Recent activity" icon={Activity}>
        {overview && overview.recent.length > 0 ? (
          <div className="custom-scrollbar max-h-[420px] overflow-y-auto -mx-1 px-1">
            <table className="w-full text-sm table-fixed">
              <tbody>
                {overview.recent.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.05]">
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <span className={`text-[10px] font-semibold uppercase tracking-wide ${
                        r.succeeded ? 'text-emerald-400/80'
                        : r.severity === 'CRITICAL' ? 'text-destructive'
                        : 'text-amber-300/80'
                      }`}>
                        {KIND_LABEL[r.kind] || r.kind}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-white/70 break-all">{r.ipAddress}</td>
                    {/* 6.19.0: columns drop away as the screen narrows rather
                        than the table growing a horizontal scrollbar. Kind,
                        address and time survive to the smallest width — they
                        are what the row is for. */}
                    <td className="py-1.5 pr-2 whitespace-nowrap hidden sm:table-cell">
                      <span className="text-sm mr-1">{flag(r.country)}</span>
                      <span className="text-[11px] text-white/45">{r.city || r.countryName || ''}</span>
                    </td>
                    <td className="py-1.5 pr-2 text-xs text-white/55 truncate hidden md:table-cell">{r.identifier || '—'}</td>
                    <td className="py-1.5 pr-2 text-[11px] text-white/35 whitespace-nowrap hidden lg:table-cell">{r.client || ''}</td>
                    <td className="py-1.5 text-[11px] text-white/35 text-right whitespace-nowrap">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing recorded yet. Attempts appear here as they happen.</Empty>
        )}
        <p className="mt-3 text-[11px] text-white/35">
          Addresses are personal data, so records are deleted after {overview?.retentionDays ?? 90} days.
          Aggregate counts survive; they identify nobody.
        </p>
      </Panel>
    </div>
  )
}

// ── small pieces ────────────────────────────────────────────────────────────

function Stat({
  label, value, suffix, icon: Icon, tone,
}: {
  label: string; value: number | string; suffix?: string
  icon: React.ComponentType<{ className?: string }>
  tone: 'good' | 'warn' | 'bad' | 'neutral'
}) {
  const colour =
    tone === 'good' ? 'text-emerald-300'
    : tone === 'warn' ? 'text-amber-300'
    : tone === 'bad' ? 'text-destructive'
    : 'text-white'
  return (
    <div className="rounded-xl ring-1 ring-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-white/40">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <p className={`mt-1.5 text-2xl font-bold tabular-nums ${colour}`}>
        {value}
        {suffix && <span className="text-sm font-normal text-white/35">{suffix}</span>}
      </p>
    </div>
  )
}

function Panel({
  title, icon: Icon, children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl ring-1 ring-white/10 bg-white/[0.03] p-4">
      <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-white/40" />
        {title}
      </h2>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-white/35 py-4 text-center">{children}</p>
}

function FindingRow({ finding }: { finding: Finding }) {
  const icon =
    finding.status === 'PASS' ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
    : finding.status === 'WARN' ? <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
    : finding.status === 'FAIL' ? <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
    : <MinusCircle className="w-4 h-4 text-white/25 shrink-0 mt-0.5" />

  const ring =
    finding.status === 'FAIL' ? 'ring-destructive/25 bg-destructive/[0.07]'
    : finding.status === 'WARN' ? 'ring-amber-400/25 bg-amber-400/[0.06]'
    : 'ring-white/[0.07] bg-white/[0.02]'

  return (
    <div className={`rounded-lg ring-1 ${ring} px-3 py-2.5 flex items-start gap-2.5`}>
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm text-white/90">{finding.title}</span>
          {finding.severity !== 'INFO' && finding.status !== 'PASS' && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-white/35">
              {finding.severity}
            </span>
          )}
        </div>
        {/* The observed value, always. A check that says only "failed" is a
            check you cannot act on or argue with. */}
        {finding.detail && (
          <p className="mt-0.5 text-[11px] text-white/50 font-mono break-words">{finding.detail}</p>
        )}
        {/*
          6.19.0 — what this means, before what to type.
          `detail` is a measurement and `remediation` is an instruction; both
          assume you already know why the check exists. This is the sentence in
          between, and it comes first because deciding whether to care has to
          precede deciding what to do.
        */}
        {finding.impact && finding.status !== 'PASS' && (
          <p className="mt-1.5 text-xs text-white/80 leading-relaxed">{finding.impact}</p>
        )}
        {finding.remediation && finding.status !== 'PASS' && (
          <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
            <span className="text-white/30">Fix: </span>
            {finding.remediation}
          </p>
        )}
      </div>
    </div>
  )
}
