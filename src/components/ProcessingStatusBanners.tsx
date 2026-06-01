'use client'

import { useState } from 'react'
import { Upload, Cog, ChevronDown, ChevronUp, CheckCircle2, FolderOpen } from 'lucide-react'
import Link from 'next/link'
import { useProcessingStatus, type ProcessingVideo } from '@/contexts/ProcessingStatusContext'

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
  const total = Math.max(hwm, current)
  const done = Math.max(0, total - current)
  // We treat the banner as "complete" only when the current
  // count is zero *and* something actually happened (hwm > 0).
  // The HWM reset window in the context will hide the banner a
  // few seconds later.
  const isDone = current === 0 && hwm > 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null

  const Icon = isDone ? CheckCircle2 : kind === 'upload' ? Upload : Cog
  const labelHead =
    kind === 'upload'
      ? isDone
        ? 'All uploads complete'
        : 'Uploading videos'
      : isDone
      ? 'All processing complete'
      : 'Processing videos'
  // 2.0.6+: when work is in flight, surface "X in progress" prominently
  // instead of "0 / N done". With CLI bulk uploads the banner used to
  // sit at "0 / 6 done" for minutes while the worker actually was
  // chewing through them — there was no signal that anything was alive.
  // Now the live count of in-flight items leads, and the done counter
  // tags along only once at least one item has finished.
  const labelCount = isDone
    ? `${total} / ${total} done`
    : done > 0
    ? `${current} in progress · ${done} / ${total} done`
    : `${current} in progress`

  return (
    <div
      className="pointer-events-auto w-[340px] rounded-xl border border-border bg-card/95 backdrop-blur-md shadow-[0_12px_40px_rgba(0,0,0,0.4)] animate-in slide-in-from-bottom-2 fade-in duration-200 overflow-hidden"
      role="status"
    >
      {/* Header row — click to expand the list. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3 flex items-start gap-2.5 hover:bg-muted/40 transition-colors"
        aria-expanded={expanded}
        aria-label={`${labelHead}. ${labelCount}. Click to ${expanded ? 'collapse' : 'expand'} the list.`}
      >
        <div className="shrink-0 mt-0.5">
          <Icon
            className={`w-4 h-4 ${
              isDone
                ? 'text-green-500'
                : kind === 'upload'
                ? 'text-primary'
                : 'text-primary animate-spin [animation-duration:2.4s]'
            }`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-card-foreground truncate">
            {labelHead}
          </div>
          <div className="text-[11px] text-muted-foreground truncate tabular-nums">
            {labelCount}
          </div>
        </div>
        <div className="shrink-0 -mt-0.5 -mr-0.5 p-1 text-muted-foreground">
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
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${
              isDone ? 'bg-green-500' : 'bg-primary'
            }`}
            style={{ width: `${isDone ? 100 : pct ?? 0}%` }}
          />
        </div>
        {pct !== null && (
          <div className="mt-1 text-[10px] text-muted-foreground tabular-nums">
            {isDone ? 100 : pct}%
          </div>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border max-h-[260px] overflow-y-auto">
          {videos.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
              {isDone ? 'All done. The banner will close shortly.' : 'No videos in this state.'}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {videos.map((v) => (
                <VideoRow key={v.id} video={v} kind={kind} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function VideoRow({ video, kind }: { video: ProcessingVideo; kind: BannerKind }) {
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
  const isActive = video.isActive || uploadInFlight

  return (
    <li>
      <Link
        href={href}
        className={`flex items-center gap-2.5 px-3 py-2 hover:bg-muted/40 transition-colors ${
          isActive ? '' : 'opacity-50'
        }`}
      >
        <Thumb video={video} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-card-foreground truncate" title={`${video.name} ${video.versionLabel}`}>
            {video.name}
            {video.versionLabel ? (
              <span className="ml-1 text-[10px] text-muted-foreground font-normal">
                {video.versionLabel}
              </span>
            ) : null}
          </div>
          <div className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
            <FolderOpen className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate">{video.projectTitle || 'Untitled project'}</span>
          </div>
        </div>
        <StatusPip kind={kind} active={isActive} />
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
        className="shrink-0 rounded bg-muted"
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
      className="shrink-0 rounded object-cover bg-muted"
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
function StatusPip({ kind, active }: { kind: BannerKind; active: boolean }) {
  const SIZE = 36
  const dotColour = active
    ? kind === 'upload'
      ? 'bg-primary'
      : 'bg-amber-500'
    : 'bg-muted-foreground/40'
  const ringColour = active
    ? kind === 'upload'
      ? 'border-primary/40'
      : 'border-amber-500/40'
    : 'border-muted-foreground/20'
  return (
    <div
      className={`shrink-0 relative rounded-full border ${ringColour} flex items-center justify-center`}
      style={{ width: SIZE, height: SIZE }}
      aria-label={active ? 'Active — worker started' : 'Queued — waiting for a worker slot'}
      title={active ? 'Active — worker just started this video' : 'Queued — waiting for a worker slot'}
    >
      <span
        className={`block w-1.5 h-1.5 rounded-full ${dotColour} ${active ? 'animate-pulse' : ''}`}
      />
    </div>
  )
}

