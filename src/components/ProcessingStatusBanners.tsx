'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Cog, ChevronDown, ChevronUp, CheckCircle2, FolderOpen, Trash2, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { useProcessingStatus, type ProcessingVideo } from '@/contexts/ProcessingStatusContext'
import { ConfirmModal } from '@/components/ConfirmModal'
import { apiDelete, apiPost } from '@/lib/api-client'
import { logError } from '@/lib/logging'

/**
 * 6.14.0 — live transfer rate for the upload banner.
 *
 * The banner is fed by the server: it polls `/api/processing-status`, which
 * reports each row's `uploadProgress`. That number is bumped by the TUS
 * endpoint as chunks land, so the DIFFERENCE between two polls is real bytes
 * over real time — no client-side transfer state required. Which is the point:
 * this works for an upload running in another tab, in another browser, or from
 * `bulk-upload.mjs` on a different machine entirely.
 *
 * Until now the megabytes-per-second readout lived only inside the upload
 * modal, over its own TUS progress events. Close the modal — or upload from
 * anywhere else — and the banner could only show a percentage that sometimes
 * sat still for minutes with no way to tell "slow" from "dead".
 *
 * Smoothing: an exponential moving average, because a 3-second poll against a
 * chunked transfer is naturally lumpy — two chunks landing in one window and
 * none in the next would otherwise read as 40 MB/s followed by 0.
 */
function useTransferRate(video: ProcessingVideo, enabled: boolean) {
  const [mbps, setMbps] = useState<number | null>(null)
  const [stalledMs, setStalledMs] = useState(0)
  const sample = useRef<{ bytes: number; at: number } | null>(null)
  const ema = useRef<number | null>(null)
  // Seeded on the first effect run, not during render — `Date.now()` in a
  // render body is impure and React's lint rule is right to refuse it.
  const lastMoveAt = useRef<number | null>(null)

  const size = video.originalFileSize ?? 0
  const pct = Math.max(0, Math.min(100, video.uploadProgress ?? 0))
  const bytes = size > 0 ? (size * pct) / 100 : pct // percent-only fallback

  useEffect(() => {
    if (!enabled) return
    const now = Date.now()
    if (lastMoveAt.current == null) lastMoveAt.current = now
    const prev = sample.current
    sample.current = { bytes, at: now }
    if (!prev) return

    const dt = (now - prev.at) / 1000
    const moved = bytes - prev.bytes
    if (dt <= 0) return

    if (moved > 0) {
      lastMoveAt.current = now
      if (size > 0) {
        const instant = moved / dt / (1024 * 1024)
        ema.current = ema.current == null ? instant : ema.current * 0.6 + instant * 0.4
        setMbps(ema.current)
      }
    }
  }, [bytes, enabled, size])

  // A second ticker so "no data for 18s" counts up on screen instead of only
  // updating when a poll happens to bring new bytes.
  useEffect(() => {
    if (!enabled) {
      setStalledMs(0)
      return
    }
    const t = setInterval(() => {
      if (lastMoveAt.current == null) lastMoveAt.current = Date.now()
      const quiet = Date.now() - lastMoveAt.current
      setStalledMs(quiet)
      if (quiet > 8000) setMbps(0)
    }, 1000)
    return () => clearInterval(t)
  }, [enabled])

  return { mbps, stalledMs }
}

/** No bytes for this long and we stop calling it "uploading". */
const BANNER_STALL_MS = 20_000

/**
 * 2.0.x+: bottom-right pair of "Uploading X/Y videos" and
 * "Processing X/Y videos" status banners. Mounted alongside the
 * existing `DownloadBanners` in the admin layout so all three
 * surfaces (downloads, uploads, processing) stack consistently.
 *
 * Counts are global (every project the signed-in admin has
 * access to), so a `bulk-upload.mjs` run on a separate machine
 * also surfaces here. Polling lives in
 * `ProcessingStatusContext` — this component is pure render.
 *
 * Click anywhere on a banner row to expand a scrollable list of
 * the in-flight videos with their project name. Closing the
 * banner just folds the list; the banner itself stays visible
 * while there's still work in flight (or HWM > 0 for the brief
 * "Done!" pulse). Renders nothing when both banners are idle.
 */
export function ProcessingStatusBanners() {
  const {
    uploadingCount,
    uploadingHwm,
    uploadingVideos,
    processingCount,
    processingHwm,
    processingVideos,
  } = useProcessingStatus()

  const showUpload = uploadingCount > 0 || uploadingHwm > 0
  const showProcess = processingCount > 0 || processingHwm > 0
  if (!showUpload && !showProcess) return null

  return (
    <div
      // Sit just to the LEFT of the download banners so the two
      // stacks don't fight for the same bottom-right corner.
      // Same vertical baseline + same width as the download
      // banner.
      className="fixed bottom-4 right-4 z-[2147483600] flex flex-col gap-2 max-w-[calc(100vw-2rem)] pointer-events-none"
      aria-live="polite"
    >
      {showUpload && (
        <StatusBanner
          kind="upload"
          current={uploadingCount}
          hwm={uploadingHwm}
          videos={uploadingVideos}
        />
      )}
      {showProcess && (
        <StatusBanner
          kind="processing"
          current={processingCount}
          hwm={processingHwm}
          videos={processingVideos}
        />
      )}
    </div>
  )
}

type BannerKind = 'upload' | 'processing'

// 2.2.6+: smooth per-video progress fraction (0..1) for the
// banner's overall bar. Mirrors the formula the player Quality
// menu uses so the two surfaces agree at every poll cycle.
//
// For PROCESSING rows:
//   - `plannedTiers.length` = denominator.
//   - `completedTiers` contribute 1.0 each.
//   - The next tier in the ladder NOT yet in `completedTiers`
//     contributes `transcodeProgressByTier[tier] / 100`.
//   - Fallback (legacy rows missing the JSON columns) →
//     `processingProgress / 100`, which gives at least the
//     coarse pre-2.2.0 behaviour.
//
// For UPLOADING rows: TUS-driven `uploadProgress / 100`. Falls
// back to 0 when the row hasn't started receiving bytes yet.
function computeSmoothProgressForVideo(
  v: ProcessingVideo,
  kind: BannerKind,
): number {
  if (kind === 'upload') {
    const up = Math.max(0, Math.min(100, v.uploadProgress ?? 0))
    return up / 100
  }
  // Processing.
  //
  // 2.2.10+: do NOT shortcut on `status === 'READY'`. The worker
  // intentionally flips status to READY the moment 480p lands so
  // the player can start streaming the low tier — but it then
  // keeps encoding 720p / 1080p / 2160p in the background. The
  // pre-2.2.10 shortcut returned 1.0 (i.e. "100% done") for those
  // READY-but-still-encoding videos, which is what made the
  // banner say "All processing complete" right after SD finished
  // even though the worker had three tiers left to go, AND why
  // re-entering the folder mid-encode showed 100% on the bar
  // while the HD ring was still climbing. The honest answer is
  // "fraction of plannedTiers that completedTiers covers, plus
  // the smooth tick from the in-flight tier" — same shape for
  // PROCESSING and READY-but-encoding rows.
  const planned = Array.isArray(v.plannedTiers)
    ? v.plannedTiers.filter((t): t is string => typeof t === 'string')
    : null
  if (!planned || planned.length === 0) {
    // Legacy row with no per-tier ladder — fall back to whatever
    // overall progress the worker reports. If the row is READY
    // we still call it done (no per-tier visibility to refute it).
    if (v.status === 'READY') return 1
    const fallback = Math.max(0, Math.min(100, v.processingProgress ?? 0))
    return fallback / 100
  }
  const completed = new Set(
    Array.isArray(v.completedTiers)
      ? v.completedTiers.filter((t): t is string => typeof t === 'string')
      : [],
  )
  const completedCount = planned.filter((t) => completed.has(t)).length
  if (completedCount >= planned.length) return 1

  // 2.3.3+: sum effective per-tier fractions. The old formula
  // (`completedCount + nextTierFraction` for the FIRST not-completed
  // tier) assumed strictly sequential encoding — fine in 2.2.x,
  // wrong from 2.3.0 onward where after 480p drains the worker
  // happily runs 720p + 1080p + 2160p in parallel.
  //
  // Concrete failure: after 720p + 1080p complete and the worker
  // moves on to 2160p, there's a brief window where the next poll
  // sees `completedTiers=["480p","720p"]` (1080p hasn't been
  // atomically added yet) AND `transcodeProgressByTier={"1080p":100,
  // "2160p":11}`. Old code picked 1080p (first not-completed),
  // saw 100, returned (2 + 1)/4 = 75% — and froze there because
  // the *next* poll inevitably had the same shape until 1080p was
  // formally promoted to completedTiers seconds later. User-
  // visible symptom: banner stuck at 75% HD+ while the in-video
  // menu (which uses a different signal) already showed 4K at 11%.
  //
  // New shape: per-tier effective fraction. Each tier contributes
  // 1.0 if it's in completedTiers OR its progress hit 100, else
  // its raw progress / 100. Sum / total = honest overall progress
  // that doesn't care which tiers run in parallel.
  const perTier = v.transcodeProgressByTier
  const readProgress = (tier: string): number => {
    if (!perTier || typeof perTier !== 'object') return 0
    const raw = (perTier as Record<string, unknown>)[tier]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
    return Math.max(0, Math.min(100, raw))
  }
  let totalFraction = 0
  for (const tier of planned) {
    if (completed.has(tier)) {
      totalFraction += 1
      continue
    }
    const pct = readProgress(tier)
    // A tier that reports 100 % progress but hasn't been formally
    // promoted to completedTiers yet is effectively done — count
    // it as 1.0 so the bar doesn't stall in the race window.
    totalFraction += pct >= 100 ? 1 : pct / 100
  }
  return totalFraction / planned.length
}


/**
 * 6.14.0 — count TIERS for the encoding banner, not videos.
 *
 * The header used to read "0 / 2 done" while the bar underneath sat at 16% and
 * a row visibly ground through a 4K encode. Both numbers were true — zero
 * VIDEOS had finished — but put next to each other they read as a bug, and the
 * banner is literally labelled "Encoding tiers". So count the thing the label
 * names: individual tiers, which finish every few minutes instead of every
 * half hour, and move while you watch.
 *
 * Videos that finish leave the polled list entirely, so their tiers are folded
 * into a running base — otherwise the denominator would shrink as work
 * completes and "3 / 8" would become "1 / 4", which looks like going
 * backwards. The base resets once the queue drains.
 */
function useTierTally(videos: ProcessingVideo[], isDone: boolean) {
  // Base = tiers belonging to videos that have already left the list. Held in
  // state (not a ref) so reading it during render is legitimate.
  const [base, setBase] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [seen, setSeen] = useState<Record<string, number>>({})

  useEffect(() => {
    if (isDone) {
      setBase({ done: 0, total: 0 })
      setSeen({})
      return
    }
    const live = new Set(videos.map((v) => v.id))
    setSeen((prevSeen) => {
      let finishedTiers = 0
      const next: Record<string, number> = {}
      for (const [id, planned] of Object.entries(prevSeen)) {
        if (live.has(id)) continue
        // Gone from the list = finished. Its whole ladder counts as done.
        finishedTiers += planned
      }
      for (const v of videos) next[v.id] = v.plannedTiers?.length ?? 0
      if (finishedTiers > 0) {
        setBase((b) => ({ done: b.done + finishedTiers, total: b.total + finishedTiers }))
      }
      const sameKeys =
        Object.keys(next).length === Object.keys(prevSeen).length &&
        Object.keys(next).every((k) => prevSeen[k] === next[k])
      return sameKeys ? prevSeen : next
    })
  }, [videos, isDone])

  let done = base.done
  let total = base.total
  for (const v of videos) {
    done += v.completedTiers?.length ?? 0
    total += v.plannedTiers?.length ?? 0
  }
  return { done, total }
}

function StatusBanner({
  kind,
  current,
  hwm,
  videos,
}: {
  kind: BannerKind
  current: number
  hwm: number
  videos: ProcessingVideo[]
}) {
  const [expanded, setExpanded] = useState(false)
  const { refetch } = useProcessingStatus()
  // 6.14.0: cancelling from the banner. The pip turns into a bin on hover,
  // and this is the confirmation behind it.
  const [pendingCancel, setPendingCancel] = useState<ProcessingVideo | null>(null)
  const [cancelling, setCancelling] = useState(false)
  // What survives a stop: exactly the tiers already encoded. The dialog names
  // only the HIGHEST of them — "keep SD and HD and HD+" is three ways of
  // saying the same thing, because the ladder is cumulative: keeping HD+ means
  // SD and HD are there too. The top rung is the number the person is deciding
  // about.
  const keptTiers = pendingCancel?.completedTiers ?? []
  const keptTop = keptTiers.length > 0 ? highestTier(keptTiers) : null

  const cancelVideo = useCallback(async (video: ProcessingVideo) => {
    setCancelling(true)
    try {
      if (kind === 'processing') {
        // 6.14.0: stopping an encode is not the same as discarding the video.
        // The server keeps whatever tiers already landed and deletes the row
        // only when none have — see /api/videos/[id]/stop-encoding.
        const res = await apiPost(`/api/videos/${video.id}/stop-encoding`, {})
        if (!res.ok && res.status !== 404) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
      } else {
        // An upload has nothing worth keeping: hard delete, skipping Trash.
        // Deleting the row is also what un-stacks it — if this file was
        // dropped onto an existing video as a new version, the reel goes back
        // to the versions that actually exist.
        const res = await apiDelete(`/api/videos/${video.id}?permanent=1`)
        if (!res.ok && res.status !== 404) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
      }
    } catch (error) {
      logError('[banner] Could not cancel:', error)
    } finally {
      setCancelling(false)
      setPendingCancel(null)
      // Re-poll immediately so the row disappears now rather than in three
      // seconds — and so the banner closes if that was the last one.
      refetch()
    }
  }, [refetch, kind])

  const total = Math.max(hwm, current)
  const done = Math.max(0, total - current)
  const tierTally = useTierTally(videos, current === 0 && hwm > 0)
  // We treat the banner as "complete" only when the current
  // count is zero *and* something actually happened (hwm > 0).
  // The HWM reset window in the context will hide the banner a
  // few seconds later.
  const isDone = current === 0 && hwm > 0
  // 2.2.6+: SMOOTH overall progress. Pre-2.2.6 this was just
  // `done / total` — a count-based percent that sat at 0% until
  // the row flipped to READY and jumped to 100. For a 1-video
  // batch you'd literally never see any movement until the
  // whole encode finished. Now we sum each in-flight video's
  // SMOOTH per-tier progress (same formula the Quality menu
  // uses inside the player) and add the count of finished
  // videos, so the bar climbs continuously alongside ffmpeg.
  const smoothInFlight = videos.reduce(
    (acc, v) => acc + computeSmoothProgressForVideo(v, kind),
    0,
  )
  const pct =
    total > 0
      ? Math.min(100, Math.round(((done + smoothInFlight) / total) * 100))
      : null

  const Icon = isDone ? CheckCircle2 : kind === 'upload' ? Upload : Cog
  // 2.2.0+: the processing banner now reflects the new breadth-first
  // pipeline. "Encoding tiers" is more accurate than the legacy
  // "Processing videos" copy because the worker is no longer doing
  // any one video end-to-end — it's chewing through individual
  // encode-tier jobs (480p across all videos, then 720p, then 1080p,
  // etc.) The completion copy stays as "All processing complete"
  // because that's terminal regardless of how the pipeline got there.
  const labelHead =
    kind === 'upload'
      ? isDone
        ? 'All uploads complete'
        : 'Uploading videos'
      : isDone
      ? 'All processing complete'
      : 'Encoding tiers'
  // 2.1.8+: "in progress" should reflect what the WORKER is actively
  // chewing on, not the entire queue. Counting all PROCESSING rows
  // overstates concurrency — a 6-video bulk upload would say "6 in
  // progress" while only 2 ffmpegs were actually running and the
  // other 4 sat in `wait`. We now count the rows the API marked
  // `isActive` (BullMQ getActive + the oldest-N fallback) for the
  // processing banner. For the upload banner there's no equivalent
  // "active vs queued" split — TUS uploads run in parallel from
  // the client and any UPLOADING row IS receiving bytes — so we
  // keep using the total there.
  const activeInFlight =
    kind === 'processing'
      ? videos.filter((v) => v.isActive).length || current
      : current
  // 2.4.2+: simplified processing copy. On a 4000-video bulk
  // backfill, "2 in progress · 400 / 3945 done" is hard to scan
  // and the "in progress" number is dominated by worker
  // concurrency rather than batch shape — the user only cares
  // about overall progress through the queue. The expanded list
  // is now filtered to ONLY the actively encoding rows (see the
  // expanded panel below), so the user can still glance at which
  // specific videos the worker is on without the header being
  // crowded.
  //
  // Upload banner keeps its old shape because there's no
  // "queued" concept on the client side — every UPLOADING row IS
  // streaming bytes.
  const labelCount = isDone
    ? kind === 'processing'
      ? `${tierTally.total} / ${tierTally.total} tiers done`
      : `${total} / ${total} done`
    : kind === 'processing'
    ? `${tierTally.done} / ${tierTally.total} tiers done`
    : done > 0
    ? `${activeInFlight} in progress · ${done} / ${total} done`
    : `${activeInFlight} in progress`

  return (
    <div
      // 2.5.1+: v2.5 frosted glass — same vocabulary as
      // GlassCalendar / ConfirmDialog / dropdowns. The previous
      // `bg-card/95` was effectively opaque dark grey (#1f1f1f at
      // 95%) and didn't read as glass. Now: translucent navy +
      // spotlight-tinted radial wash + 40px backdrop blur. Ring
      // (not border) so we don't fight the rounded-xl.
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
      {/* Header row — click to expand the list. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3 flex items-start gap-2.5 hover:bg-white/[0.06] transition-colors"
        aria-expanded={expanded}
        aria-label={`${labelHead}. ${labelCount}. Click to ${expanded ? 'collapse' : 'expand'} the list.`}
      >
        <div className="shrink-0 mt-0.5">
          <Icon
            className={`w-4 h-4 ${
              isDone
                ? 'text-emerald-300'
                : kind === 'upload'
                ? 'text-primary'
                : 'text-primary animate-spin [animation-duration:2.4s]'
            }`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white truncate">
            {labelHead}
          </div>
          <div className="text-[11px] text-white/55 truncate tabular-nums">
            {labelCount}
          </div>
        </div>
        <div className="shrink-0 -mt-0.5 -mr-0.5 p-1 text-white/55">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5" />
          )}
        </div>
      </button>
      {/* Progress bar. We always have a denominator here because
          either current>0 (HWM grew to match) or isDone (in which
          case we just paint 100%). */}
      <div className="px-3 pb-3">
        <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${
              isDone ? 'bg-emerald-400' : 'bg-primary'
            }`}
            style={{ width: `${isDone ? 100 : pct ?? 0}%` }}
          />
        </div>
        {pct !== null && (
          <div className="mt-1 text-[10px] text-white/55 tabular-nums">
            {isDone ? 100 : pct}%
          </div>
        )}
      </div>
      {expanded && (() => {
        // 2.4.2+: for the PROCESSING banner, the expanded list now
        // shows ONLY the rows the worker is actively encoding —
        // i.e. those marked `isActive` by the API (BullMQ
        // getActive + oldest-N fallback). The previous behaviour
        // listed every PROCESSING row with a 50% opacity dim on
        // the queued ones, which on a 1300-video backfill turned
        // into an unscrollable wall of greyed-out rows that all
        // looked the same.
        //
        // Fallback: if NOTHING is marked active (worker between
        // jobs, or the API hasn't replied yet) we fall back to
        // the unfiltered list so the panel never appears empty
        // for a healthy queue.
        //
        // Upload banner keeps its full list — there's no
        // active/queued distinction client-side.
        const visibleVideos =
          kind === 'processing'
            ? (() => {
                const onlyActive = videos.filter((v) => v.isActive)
                return onlyActive.length > 0 ? onlyActive : videos
              })()
            : videos
        return (
          <div className="border-t border-white/10 max-h-[260px] overflow-y-auto custom-scrollbar">
            {visibleVideos.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-white/55 text-center">
                {isDone ? 'All done. The banner will close shortly.' : 'No videos in this state.'}
              </div>
            ) : (
              <ul className="divide-y divide-white/10">
                {visibleVideos.map((v) => (
                  <VideoRow
                    key={v.id}
                    video={v}
                    kind={kind}
                    onRequestCancel={setPendingCancel}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })()}

      {/* 6.14.0: one confirmation, whichever pip was clicked. */}
      <ConfirmModal
        open={pendingCancel !== null}
        onOpenChange={(next) => {
          if (!next) setPendingCancel(null)
        }}
        title={kind === 'upload' ? 'Cancel this upload?' : 'Stop encoding?'}
        description={
          <>
            <span className="font-medium text-white">{pendingCancel?.name}</span>{' '}
            {kind === 'upload' ? (
              <>
                will stop uploading and be removed. Anything already
                transferred is discarded, and if it was uploaded as a new
                version of an existing video it is taken back out of that
                version stack.
              </>
            ) : keptTop ? (
              <>
                will stop encoding and stay playable up to{' '}
                <span className="font-medium text-white">{tierLabel(keptTop)}</span>
                . The qualities still queued are cancelled.
              </>
            ) : (
              <>
                has not finished a single quality yet, so there is nothing
                playable to keep — it will be removed.
              </>
            )}
          </>
        }
        confirmLabel={
          kind === 'upload'
            ? 'Cancel upload'
            : keptTop
              ? `Stop and keep ${tierLabel(keptTop)}`
              : 'Stop and remove'
        }
        cancelLabel="Keep going"
        variant="destructive"
        busy={cancelling}
        onConfirm={() => {
          if (pendingCancel) void cancelVideo(pendingCancel)
        }}
      />
    </div>
  )
}

function VideoRow({
  video,
  kind,
  onRequestCancel,
}: {
  video: ProcessingVideo
  kind: BannerKind
  onRequestCancel: (video: ProcessingVideo) => void
}) {
  // Deep-link to the project page (or folder if known) so the
  // user can click straight from the banner into the right
  // place. Versions of the same upload share project + folder.
  const href = video.folderId
    ? `/admin/projects/${video.projectId}/folder/${video.folderId}`
    : `/admin/projects/${video.projectId}`

  // Active/queued is decided server-side: the API endpoint takes
  // BullMQ's `getActive()` result, narrows it to videoIds that
  // are actually in the visible list, and falls back to "N
  // oldest PROCESSING rows" when BullMQ comes up empty. That
  // means as long as the worker is busy, exactly one row (or N
  // for higher concurrency) is marked active here at all times
  // — no more "every row dimmed" gaps.
  //
  // For UPLOADING rows the worker isn't involved (TUS uploads
  // run client-side), so we additionally fall back to "the row
  // has uploadProgress > 0" as a sign that bytes are flowing.
  const uploadInFlight = kind === 'upload' && (video.uploadProgress ?? 0) > 0
  const { mbps, stalledMs } = useTransferRate(video, kind === 'upload')
  const stalled = kind === 'upload' && stalledMs > BANNER_STALL_MS
  // A stalled transfer is not an active one — dim it like a queued row so the
  // banner stops implying that bytes are moving.
  const isActive = (video.isActive || uploadInFlight) && !stalled

  return (
    <li>
      <Link
        href={href}
        className={`flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.06] transition-colors ${
          isActive ? '' : 'opacity-50'
        }`}
      >
        <Thumb video={video} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-white truncate" title={`${video.name} ${video.versionLabel}`}>
            {video.name}
            {video.versionLabel ? (
              <span className="ml-1 text-[10px] text-white/55 font-normal">
                {video.versionLabel}
              </span>
            ) : null}
          </div>
          <div className="text-[10px] text-white/55 truncate flex items-center gap-1">
            <FolderOpen className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate">{video.projectTitle || 'Untitled project'}</span>
          </div>
          {kind === 'upload' && (
            <div className="text-[10px] truncate">
              {stalled ? (
                <span className="text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                  No data for {Math.round(stalledMs / 1000)}s — retrying
                </span>
              ) : mbps != null ? (
                <span className="text-white/45 tabular-nums">
                  {mbps.toFixed(1)} MB/s
                </span>
              ) : (
                <span className="text-white/35">Starting…</span>
              )}
            </div>
          )}
        </div>
        <StatusPip
          kind={kind}
          active={isActive}
          video={video}
          onCancel={() => onRequestCancel(video)}
        />
      </Link>
    </li>
  )
}

/**
 * Thumbnail box on the left side of each row. Renders at the
 * video's own aspect ratio so a portrait reel doesn't get
 * squished into a landscape rectangle (very common in the
 * bulk-upload.mjs case the user feeds it).
 *
 * Why this is fiddly: width/height in the DB get filled in by
 * the worker AFTER ffprobe runs (around first-tier completion).
 * Before that — for rows that are still UPLOADING or sitting in
 * the BullMQ wait queue — the DB columns are NULL even though
 * the instant-thumbnail step has already produced a real JPEG
 * with the actual aspect ratio. We sidestep the gap by reading
 * `naturalWidth/naturalHeight` from the image element itself
 * once it loads, and treating that as authoritative.
 *
 * Render order:
 *   1. First paint: best-guess aspect from API width/height,
 *      defaulting to 16:9 when unknown. Avoids a 0×34 flash.
 *   2. `<img>` resolves → `onLoad` fires → naturalAspect set →
 *      React re-renders the row at the true aspect ratio.
 * Fixed height (34px), hard-capped width (60px) so a 21:9 cinema
 * scope frame doesn't blow out the row. Falls back to a muted
 * 16:9 placeholder when the thumbnail token wasn't ready yet
 * (rare; the brief window between TUS upload finishing and the
 * instant-thumbnail step in /api/uploads landing).
 */
function Thumb({ video }: { video: ProcessingVideo }) {
  const HEIGHT = 34
  const MAX_WIDTH = 60
  const MIN_WIDTH = 19

  const [naturalAspect, setNaturalAspect] = useState<number | null>(null)
  const apiAspect =
    video.width && video.height && video.width > 0 && video.height > 0
      ? video.width / video.height
      : null
  // Once the image fires `onLoad`, naturalAspect takes over —
  // even if the DB columns were NULL we now know the truth.
  const aspect = naturalAspect ?? apiAspect ?? 16 / 9
  const computedWidth = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, Math.round(HEIGHT * aspect)),
  )

  if (!video.thumbnailUrl) {
    return (
      <div
        className="shrink-0 rounded bg-white/10 ring-1 ring-white/10"
        style={{ width: Math.round(HEIGHT * (16 / 9)), height: HEIGHT }}
        aria-hidden="true"
      />
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={video.thumbnailUrl}
      alt=""
      className="shrink-0 rounded object-cover bg-white/10 ring-1 ring-white/10"
      style={{ width: computedWidth, height: HEIGHT }}
      onLoad={(e) => {
        const img = e.currentTarget
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          const nextAspect = img.naturalWidth / img.naturalHeight
          // Don't trigger a re-render if the aspect we already
          // had matches the natural one closely (within 1%) —
          // saves a paint when the API's width/height happened
          // to agree with the thumbnail.
          if (
            naturalAspect === null ||
            Math.abs(naturalAspect - nextAspect) / nextAspect > 0.01
          ) {
            setNaturalAspect(nextAspect)
          }
        }
      }}
      loading="lazy"
      draggable={false}
    />
  )
}

/**
 * Single status indicator used for every row. We deliberately
 * dropped the circular-percentage variant: the worker's coarse
 * `processingProgress` only ticks between tiers (so for
 * sub-minute clips you see 0 → vanish, never anything in
 * between) and lying with a fake animated ring was misleading.
 * Now there are exactly two states — active (the row currently
 * inside a worker) pulses in the kind's colour, queued (waiting
 * for a slot) sits static and muted. Combined with the row's
 * opacity wrapper the active row pops at a glance.
 */
// 2.2.6+: tier-slug → YouTube-style quality label. Matches the
// PlayerSettingsMenu quality badge so the user reads the same
// vocabulary in both places.
const TIER_LABEL: Record<string, string> = {
  '480p': 'SD',
  '720p': 'HD',
  '1080p': 'HD+',
  '2160p': '4K',
}

// 2.2.6+: ladder order. Used to detect the "next" tier in
// `plannedTiers \ completedTiers` — that's what the worker is
// currently encoding (or about to encode).
const TIER_ORDER = ['480p', '720p', '1080p', '2160p']

function getInProgressTier(video: ProcessingVideo): string | null {
  // Uploading rows aren't encoding yet — no tier to surface.
  // The pip falls back to the legacy pulsing dot for those.
  if (video.status === 'UPLOADING') return null

  const planned = Array.isArray(video.plannedTiers)
    ? video.plannedTiers.filter((t): t is string => typeof t === 'string')
    : null
  const completed = Array.isArray(video.completedTiers)
    ? new Set(video.completedTiers.filter((t): t is string => typeof t === 'string'))
    : new Set<string>()

  if (!planned || planned.length === 0) return null

  // 2.3.3+: parallel-encoding-aware tier picker. From 2.3.0 on the
  // worker can have 720p / 1080p / 2160p in flight simultaneously
  // after 480p drains. Old code just returned the first planned
  // tier that wasn't in completedTiers — wrong in two scenarios:
  //
  //   1. RACE WINDOW. 1080p finished encoding but the worker
  //      hasn't atomically added it to completedTiers yet; 2160p
  //      already shows fresh progress in transcodeProgressByTier.
  //      Old picker returned 1080p, pip read HD+, user saw it
  //      stuck on 1080p while playback inside the video already
  //      showed 4K processing.
  //   2. PARALLEL. 1080p at 80 %, 2160p at 20 % — both in flight,
  //      old picker returned 1080p (closer to done). The user's
  //      intuition is "show me what we're chasing", i.e. the
  //      highest-tier in flight.
  //
  // New rule:
  //   PASS 1: walk TIER_ORDER from HIGHEST to lowest. Return the
  //   first planned, not-completed tier whose progress is in the
  //   active range (>0 and <100). That's the "highest tier
  //   currently being worked on".
  //   PASS 2 (fallback): no tier has active progress yet (e.g.
  //   between jobs). Return the first non-completed tier in
  //   ascending order — same "next up" behaviour as before.
  const perTier = video.transcodeProgressByTier
  const readProgress = (tier: string): number | null => {
    if (!perTier || typeof perTier !== 'object') return null
    const raw = (perTier as Record<string, unknown>)[tier]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  }
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i]
    if (!planned.includes(tier) || completed.has(tier)) continue
    const pct = readProgress(tier)
    if (pct !== null && pct > 0 && pct < 100) {
      return tier
    }
  }
  for (const tier of TIER_ORDER) {
    if (planned.includes(tier) && !completed.has(tier)) {
      return tier
    }
  }
  return null
}

/** '480p' → 'SD', so the confirmation speaks the same language as the pip. */
function tierLabel(tier: string): string {
  return TIER_LABEL[tier] || tier
}

/** The top rung of a set of tiers, in ladder order. */
function highestTier(tiers: string[]): string | null {
  let best = -1
  for (const tier of tiers) {
    const idx = TIER_ORDER.indexOf(tier)
    if (idx > best) best = idx
  }
  return best >= 0 ? TIER_ORDER[best] : null
}

function getInProgressTierLabel(video: ProcessingVideo): string | null {
  const tier = getInProgressTier(video)
  return tier ? TIER_LABEL[tier] || tier : null
}

/**
 * 2.2.10+: 0..100 progress for the tier currently in flight on a
 * processing row. Reads `transcodeProgressByTier[tier]` (same field
 * the smooth banner progress is built on) and clamps to a 0..100
 * range. Returns null when we have no per-tier data — the pip then
 * falls back to its pre-2.2.10 static ring.
 */
function getInProgressTierPercent(video: ProcessingVideo): number | null {
  const tier = getInProgressTier(video)
  if (!tier) return null
  const map = video.transcodeProgressByTier
  if (!map || typeof map !== 'object') return null
  const raw = (map as Record<string, unknown>)[tier]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.max(0, Math.min(100, raw))
}

function StatusPip({
  kind,
  active,
  video,
  onCancel,
}: {
  kind: BannerKind
  active: boolean
  video: ProcessingVideo
  onCancel: () => void
}) {
  const SIZE = 36
  // 6.14.0: hover the pip and it offers to stop the thing it is reporting on.
  // The pip is already the row's status object — the dot for a transfer, the
  // SD/HD/4K ring for an encode — so turning it into a bin on hover puts the
  // escape hatch exactly where the eye already is, without adding a button to
  // every row.
  const [hovered, setHovered] = useState(false)
  const tierLabel = getInProgressTierLabel(video)
  // 2.2.10+: read per-tier progress so the ring around the label
  // fills 0..100 instead of staying a flat static border. Only
  // applies when (a) we know which tier is in flight AND (b) the
  // worker has reported at least one progress tick on it. Falls
  // back to the static border otherwise (legacy rows, uploads,
  // queued-but-not-yet-started, etc) so the visual is never blank.
  const tierPercent = getInProgressTierPercent(video)
  const dotColour = active
    ? kind === 'upload'
      ? 'bg-primary'
      : 'bg-amber-400'
    : 'bg-white/30'
  const ringColour = active
    ? kind === 'upload'
      ? 'border-primary/40'
      : 'border-amber-400/40'
    : 'border-white/15'
  // SVG ring geometry. r=16 (just inside SIZE=36 minus the 2px
  // stroke band), circumference = 2πr ≈ 100.53. We render the
  // foreground stroke with `strokeDasharray=C` and
  // `strokeDashoffset=C*(1 - pct/100)` so the visible arc length
  // is `C*pct/100`. Rotated -90° so the arc starts at 12 o'clock
  // and sweeps clockwise — same visual idiom as YouTube/Drive
  // upload rings, and Frame.io's render progress.
  const RING_RADIUS = 16
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
  const showRing = tierLabel != null && tierPercent != null
  const arcStrokeColour = active
    ? kind === 'upload'
      ? 'stroke-primary'
      : 'stroke-amber-400'
    : 'stroke-white/30'
  const trackStrokeColour = active
    ? kind === 'upload'
      ? 'stroke-primary/20'
      : 'stroke-amber-400/20'
    : 'stroke-white/10'
  // 2.2.6+: when we know the tier in flight, swap the pulsing dot
  // for a YouTube-style quality label (SD / HD / HD+ / 4K). The
  // pulse moves up to the label colour so the row still reads as
  // "active" at a glance. When we don't know (uploads, legacy rows
  // without plannedTiers), keep the original generic pulse so the
  // banner still communicates "something's happening".
  const textColour = active
    ? kind === 'upload'
      ? 'text-primary'
      : 'text-amber-400'
    : 'text-white/55'
  const labelAria = tierLabel
    ? active
      ? `Encoding ${tierLabel}`
      : `Queued — next tier ${tierLabel}`
    : active
      ? 'Active — worker started'
      : 'Queued — waiting for a worker slot'
  const labelTitle = tierLabel
    ? active
      ? `Currently encoding ${tierLabel}`
      : `Queued — next tier ${tierLabel}`
    : active
      ? 'Active — worker just started this video'
      : 'Queued — waiting for a worker slot'
  return (
    <button
      type="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onClick={(e) => {
        // The whole row is a link to the project; cancelling must not navigate.
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
      className={`shrink-0 relative rounded-full flex items-center justify-center transition-colors ${
        hovered
          ? 'ring-1 ring-destructive/50 bg-destructive/15'
          : showRing
            ? ''
            : `border ${ringColour}`
      }`}
      style={{ width: SIZE, height: SIZE }}
      aria-label={
        showRing
          ? `${labelAria} — ${Math.round(tierPercent!)}%`
          : labelAria
      }
      title={
        hovered
          ? kind === 'upload'
            ? 'Cancel this upload'
            : 'Cancel this encode'
          : showRing
            ? `${labelTitle} (${Math.round(tierPercent!)}%)`
            : labelTitle
      }
    >
      {/* 2.2.10+: SVG progress ring. Inset 2px from the box edge so
          the stroke sits just inside the rounded container. Track
          (faint background arc) draws the full circle; the
          foreground arc draws `tierPercent` of it. */}
      {showRing && !hovered && (
        <svg
          className="absolute inset-0 -rotate-90"
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          aria-hidden
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={2}
            className={trackStrokeColour}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={2.5}
            strokeLinecap="round"
            className={`${arcStrokeColour} transition-[stroke-dashoffset] duration-300 ease-out`}
            style={{
              strokeDasharray: RING_CIRCUMFERENCE,
              strokeDashoffset:
                RING_CIRCUMFERENCE * (1 - (tierPercent ?? 0) / 100),
            }}
          />
        </svg>
      )}
      {hovered ? (
        <Trash2 className="relative w-4 h-4 text-destructive" aria-hidden />
      ) : tierLabel ? (
        <span
          className={`relative text-[10px] font-semibold tracking-tight tabular-nums ${textColour} ${
            // 2.2.10+: when the ring is doing the "alive" job, drop
            // the pulse on the label — two pulses fighting each
            // other looks busier than the actual work.
            active && !showRing ? 'animate-pulse' : ''
          }`}
        >
          {tierLabel}
        </span>
      ) : (
        <span
          className={`block w-1.5 h-1.5 rounded-full ${dotColour} ${active ? 'animate-pulse' : ''}`}
        />
      )}
    </button>
  )
}

