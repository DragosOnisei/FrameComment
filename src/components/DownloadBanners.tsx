'use client'

import { Download, X, AlertCircle, CheckCircle2, Loader2, Trash2, RefreshCw } from 'lucide-react'
import { useDownloadManager, type DownloadJob } from '@/contexts/DownloadManager'

/**
 * 2.0.x+: bottom-right stack of in-progress download banners. One row
 * per active job (folder ZIP, multi-file save, etc.) — each shows a
 * progress bar, percentage / N-of-M count, and a Cancel/Dismiss
 * button. Picks up jobs from the shared `DownloadManager` context.
 *
 * Mounted once at the root of every page that wants downloads
 * (admin app shell + the public folder share page). Renders nothing
 * when there are no jobs.
 *
 * 3.9.x: `hideTaskBanners` drops the low-priority indeterminate
 * `task` banners (e.g. "Regenerating thumbnail…") while keeping the
 * download/upload ZIP banners visible. The admin layout sets this in
 * the player view where the bottom-right corner collides with the
 * "Leave your comment" input — same reasoning that hides
 * ProcessingStatusBanners there. Big ZIP transfers still show through
 * so an admin can watch a 5 GB download while reviewing a clip.
 */
export function DownloadBanners({
  hideTaskBanners = false,
}: {
  hideTaskBanners?: boolean
} = {}) {
  const { jobs, cancel, dismiss } = useDownloadManager()

  const visibleJobs = hideTaskBanners
    ? jobs.filter((j) => j.kind !== 'task')
    : jobs

  if (visibleJobs.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-[2147483600] flex flex-col gap-2 max-w-[calc(100vw-2rem)] pointer-events-none"
      aria-live="polite"
    >
      {visibleJobs.map((job) => (
        <DownloadBanner
          key={job.id}
          job={job}
          onCancel={() => cancel(job.id)}
          onDismiss={() => dismiss(job.id)}
        />
      ))}
    </div>
  )
}

function DownloadBanner({
  job,
  onCancel,
  onDismiss,
}: {
  job: DownloadJob
  onCancel: () => void
  onDismiss: () => void
}) {
  const isManual = job.kind === 'manual'
  const isTask = job.kind === 'task'
  const isTerminal =
    job.status === 'success' || job.status === 'error' || job.status === 'cancelled'

  // Compute percentage. For stream jobs, prefer bytes/totalBytes; if
  // totalBytes hasn't arrived yet (or it's a stat-less request), fall
  // back to "indeterminate" — render the bar as a slow pulse instead
  // of a stuck 0%.
  let pct: number | null = null
  let progressLabel = ''
  if (isTask) {
    // Indeterminate — no % or byte/item count. The `sublabel`
    // (e.g. "Regenerating thumbnail…") drives the status line and
    // the bar renders as a pulse.
    progressLabel = job.sublabel || ''
  } else if (isManual) {
    const done = job.completedItems ?? 0
    const total = job.totalItems ?? 0
    const unit = job.unit || 'files'
    pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null
    progressLabel = total > 0 ? `${done} / ${total} ${unit}` : `${done} ${unit}`
  } else {
    const recv = job.bytesReceived ?? 0
    const total = job.totalBytes ?? 0
    if (total > 0) {
      pct = Math.min(100, Math.round((recv / total) * 100))
      progressLabel = `${formatBytes(recv)} / ${formatBytes(total)}`
    } else if (recv > 0) {
      progressLabel = formatBytes(recv)
    }
  }
  if (job.status === 'success') pct = 100

  return (
    <div
      // 2.5.1+: v2.5 frosted glass — same recipe as
      // ProcessingStatusBanners so download / upload / encoding
      // banners read as a coherent stack.
      className="pointer-events-auto w-[340px] rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white p-3 animate-in slide-in-from-bottom-2 fade-in duration-200"
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
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 mt-0.5">
          {job.status === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-300" />
          ) : job.status === 'error' ? (
            <AlertCircle className="w-4 h-4 text-red-300" />
          ) : job.status === 'cancelled' ? (
            <X className="w-4 h-4 text-white/55" />
          ) : job.icon === 'refresh' ? (
            <RefreshCw className="w-4 h-4 animate-spin text-primary" />
          ) : pct === null ? (
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          ) : job.icon === 'trash' ? (
            <Trash2 className="w-4 h-4 text-primary" />
          ) : (
            <Download className="w-4 h-4 text-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white truncate" title={job.label}>
            {job.label}
          </div>
          <div className="text-[11px] text-white/55 truncate">
            {job.status === 'success'
              ? isTask
                ? job.sublabel || 'Done'
                : 'Done'
              : job.status === 'error'
              ? job.error || 'Failed'
              : job.status === 'cancelled'
              ? 'Cancelled'
              : job.status === 'pending'
              ? 'Preparing…'
              : progressLabel || (isTask ? 'Working…' : 'Downloading…')}
          </div>
        </div>
        {/* Action button: Cancel during a running download, but tasks
            (server-side jobs we can't abort) and terminal banners just
            dismiss. */}
        <button
          type="button"
          onClick={isTerminal || isTask ? onDismiss : onCancel}
          className="shrink-0 -mt-0.5 -mr-0.5 p-1 rounded-md hover:bg-white/[0.08] text-white/55 hover:text-white transition-colors"
          aria-label={isTerminal || isTask ? 'Dismiss' : 'Cancel download'}
          title={isTerminal || isTask ? 'Dismiss' : 'Cancel download'}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Progress bar: solid fill if we know %, indeterminate sweep
          otherwise. Hidden for success/cancelled so the banner can
          fade out cleanly. */}
      {!isTerminal && (
        <div className="mt-2.5 h-1 w-full rounded-full bg-white/10 overflow-hidden">
          {pct !== null ? (
            <div
              className={`h-full rounded-full transition-all duration-200 ease-out ${
                job.status === 'error' ? 'bg-red-400' : 'bg-primary'
              }`}
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="h-full w-1/3 rounded-full bg-primary/70 animate-pulse" />
          )}
        </div>
      )}
      {pct !== null && !isTerminal && (
        <div className="mt-1 text-[10px] text-white/55 tabular-nums">{pct}%</div>
      )}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
