'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, CheckCircle2, StopCircle, Trash2, XCircle } from 'lucide-react'
import { apiJson, apiPost } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { canManageSettings } from '@/lib/permissions'

/**
 * 5.12.0 — global bottom-right "Transferring files" banner.
 *
 * Mirrors the Uploads / Encoding-tier banners: while the storage worker is
 * copying files it shows total vs. remaining items, a percentage +
 * accent-colored progress bar, the live MB/s rate and copied-of-total bytes.
 * Data comes from the org-scoped Redis state via the cheap `?light=1` poll
 * (no DB scans), so this can safely sit in the admin layout for every page.
 *
 * Only rendered for roles that can manage settings — the status endpoint is
 * gated the same way, and transfers are an admin concern.
 */

interface LightTransferState {
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  mode: 'transfer' | 'purge'
  targetLabel: string
  purgeBackend: string | null
  total: number
  processed: number
  copiedFiles: number
  deletedFiles: number
  failed: number
  currentLabel: string
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  totalBytes: number
  copiedBytes: number
}

function formatBytes(b: number): string {
  if (!b || b <= 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`
  return `${(b / 1024 ** 4).toFixed(2)} TB`
}

function backendLabelSafe(b: string | null | undefined): string {
  switch (b) {
    case 'local': return 'Personal Server'
    case 'fc': return 'FrameComment Server'
    case 'r2': return 'Cloudflare R2'
    case 'aws': return 'AWS S3'
    default: return 'storage'
  }
}

const IDLE_POLL_MS = 15_000
const ACTIVE_POLL_MS = 2_000
/** Keep the final "Done" card on screen for a beat before hiding. */
const LINGER_MS = 6_000

export function StorageTransferBanner() {
  const { user } = useAuth()
  const allowed = canManageSettings((user as any)?.role)

  const [state, setState] = useState<LightTransferState | null>(null)
  // Only show terminal states for runs we actually WATCHED — otherwise a
  // week-old "completed" state would flash a banner on every page load.
  const watchedRunRef = useRef<number | null>(null)
  const [visible, setVisible] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Live MB/s: exponential moving average over poll deltas.
  const speedRef = useRef<{ t: number; bytes: number; ema: number } | null>(null)
  const [speedBps, setSpeedBps] = useState(0)

  const poll = useCallback(async () => {
    try {
      const s = await apiJson<LightTransferState>('/api/settings/storage/transfer?light=1')
      setState(s)

      if (s.status === 'running') {
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
        watchedRunRef.current = s.startedAt
        setVisible(true)
        // Speed from copiedBytes deltas (transfer mode only).
        const now = Date.now()
        const prev = speedRef.current
        if (prev && s.copiedBytes >= prev.bytes && now > prev.t) {
          const inst = ((s.copiedBytes - prev.bytes) * 1000) / (now - prev.t)
          const ema = prev.ema > 0 ? prev.ema * 0.7 + inst * 0.3 : inst
          speedRef.current = { t: now, bytes: s.copiedBytes, ema }
          setSpeedBps(ema)
        } else {
          speedRef.current = { t: now, bytes: s.copiedBytes, ema: prev?.ema ?? 0 }
        }
      } else if (
        watchedRunRef.current !== null &&
        s.startedAt === watchedRunRef.current &&
        (s.status === 'completed' || s.status === 'cancelled' || s.status === 'error')
      ) {
        // A run we were showing just finished — linger, then hide.
        setVisible(true)
        if (!hideTimerRef.current) {
          hideTimerRef.current = setTimeout(() => {
            setVisible(false)
            watchedRunRef.current = null
            speedRef.current = null
            setSpeedBps(0)
            hideTimerRef.current = null
          }, LINGER_MS)
        }
      } else {
        setVisible(false)
      }
    } catch {
      /* transient — keep last state */
    }
  }, [])

  useEffect(() => {
    if (!allowed) return
    void poll()
    const running = state?.status === 'running'
    const id = setInterval(() => { void poll() }, running ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(id)
  }, [allowed, poll, state?.status])

  // Instant pickup when the Settings page / video kebab starts a job.
  useEffect(() => {
    if (!allowed) return
    const onPoke = () => { void poll() }
    window.addEventListener('storage-transfer:poke', onPoke)
    return () => window.removeEventListener('storage-transfer:poke', onPoke)
  }, [allowed, poll])

  const handleCancel = useCallback(async () => {
    try {
      await apiPost('/api/settings/storage/transfer', { action: 'cancel' })
      void poll()
    } catch {
      /* ignore */
    }
  }, [poll])

  if (!allowed || !visible || !state) return null

  const isPurge = state.mode === 'purge'
  const running = state.status === 'running'
  const pct = state.total > 0 ? Math.min(100, Math.round((state.processed / state.total) * 100)) : 0
  const remaining = Math.max(0, state.total - state.processed)

  const title = running
    ? isPurge
      ? `Cleaning up ${backendLabelSafe(state.purgeBackend)}`
      : `Transferring files to ${state.targetLabel || 'storage'}`
    : state.status === 'completed'
      ? isPurge
        ? `Cleanup of ${backendLabelSafe(state.purgeBackend)} complete`
        : `Transfer to ${state.targetLabel || 'storage'} complete`
      : state.status === 'cancelled'
        ? 'Transfer cancelled'
        : 'Transfer failed'

  const Icon = running ? ArrowLeftRight : state.status === 'completed' ? CheckCircle2 : state.status === 'error' ? XCircle : StopCircle

  return (
    <div
      className="fixed bottom-4 right-4 z-[2147483601] flex flex-col gap-2 max-w-[calc(100vw-2rem)]"
      aria-live="polite"
    >
      <div
        className="pointer-events-auto w-[340px] rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white animate-in slide-in-from-bottom-2 fade-in duration-200 overflow-hidden"
        style={{
          backgroundColor: 'rgba(22, 37, 51, 0.62)',
          backgroundImage:
            'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          transform: 'translate3d(0, 0, 0)',
          willChange: 'backdrop-filter, transform',
          isolation: 'isolate',
        }}
        role="status"
      >
        <div className="px-3.5 pt-3 pb-3 space-y-2">
          <div className="flex items-center gap-2.5">
            <span className={'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ' + (isPurge && running ? 'bg-red-500/15 text-red-300' : 'bg-primary/15 text-primary')}>
              {isPurge && running ? <Trash2 className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{title}</p>
              <p className="text-[11px] text-white/55 tabular-nums">
                {running
                  ? `${state.processed} / ${state.total} items · ${remaining} left · ${pct}%`
                  : state.status === 'error'
                    ? state.error || 'Job failed'
                    : `${state.processed} / ${state.total} items${state.failed > 0 ? ` · ${state.failed} skipped` : ''}`}
              </p>
            </div>
            {running && (
              <button
                type="button"
                onClick={handleCancel}
                className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/70 hover:text-white bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10"
              >
                <StopCircle className="w-3.5 h-3.5" /> Cancel
              </button>
            )}
          </div>

          {/* Accent progress bar (red when purging). */}
          <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className={'h-full transition-all ' + (isPurge ? 'bg-red-400/80' : 'bg-primary')}
              style={{ width: `${state.status === 'completed' ? 100 : pct}%` }}
            />
          </div>

          {/* Byte-level line — transfer mode only (purges delete, they don't move bytes). */}
          {!isPurge && (
            <div className="flex items-center justify-between text-[11px] text-white/55 tabular-nums">
              <span>
                {formatBytes(state.copiedBytes)}
                {state.totalBytes > 0 ? ` of ~${formatBytes(state.totalBytes)}` : ''}
              </span>
              {running && speedBps > 1 && <span>{formatBytes(speedBps)}/s</span>}
            </div>
          )}
          {running && state.currentLabel && (
            <p className="text-[11px] text-white/40 truncate">{state.currentLabel}</p>
          )}
        </div>
      </div>
    </div>
  )
}
