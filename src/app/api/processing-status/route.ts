import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getVideoQueue } from '@/lib/queue'
import { generateVideoAccessToken } from '@/lib/video-access'
import { isS3Mode } from '@/lib/storage'
import { logError, logMessage } from '@/lib/logging'
import { filterStoppedVideoIds } from '@/lib/encode-cancel'
import { predictTierSlugs } from '@/lib/tier-ladder'
import type { Prisma } from '@prisma/client'

// 4.2.3+: reap ABANDONED uploads so the bottom-right "Uploading videos"
// banner (and the per-card spinner) can't be pinned forever by an upload
// that never finished — the user closed the tab mid-upload, the network
// dropped, or the TUS client gave up. In those cases the `onUploadFinish`
// hook never fires (the bytes never fully land) and no server-side error
// is thrown, so the Video row is created UPLOADING and simply sits there.
// `/api/processing-status` counts every UPLOADING row, so a single zombie
// keeps the banner reading "1 in progress" indefinitely. This is exactly
// the "din cand in cand apare ca upload este in progress dar nu este" bug.
//
// A row counts as abandoned only after a safe window of ZERO activity:
//   - TUS mode (local / fc-on-local): every received chunk bumps
//     `uploadProgress`, which bumps `@updatedAt`, at least every ~1.5 s
//     during a live upload. So `updatedAt` older than 30 min means no
//     bytes have arrived for 30 min — the upload is unambiguously dead.
//     This never touches an upload that is actually still transferring.
//   - S3 mode: parts stream straight to the bucket, so the row's
//     `updatedAt` is NOT bumped during the transfer and stays at creation
//     time for the whole upload. We use a much larger 24 h floor so a
//     long large-file upload can never be reaped while it's still running.
//
// Abandoned rows are marked ERROR (NEVER deleted — this mirrors the
// existing `markVideoAsError` failure path and leaves the row visible as a
// "Failed" card the admin can review / remove). Scoped to UPLOADING only:
// PROCESSING rows are left completely alone, because a big 4K encode
// legitimately runs for a long time and must not be interrupted.
const STALE_UPLOAD_TUS_MS = 30 * 60 * 1000 // 30 minutes
// 7.9.0: how far back to look for READY rows that are still encoding higher tiers.
const RECENT_READY_WINDOW_MS = 6 * 60 * 60 * 1000 // 6 hours
const STALE_UPLOAD_S3_MS = 24 * 60 * 60 * 1000 // 24 hours
// Don't run the sweep on every 3 s poll — once a minute is plenty and the
// query is idempotent (it only matches genuinely-stale rows).
const UPLOAD_REAP_THROTTLE_MS = 60 * 1000
let lastUploadReapAt = 0

async function reapAbandonedUploads(): Promise<void> {
  const now = Date.now()
  if (now - lastUploadReapAt < UPLOAD_REAP_THROTTLE_MS) return
  lastUploadReapAt = now
  try {
    const staleMs = isS3Mode() ? STALE_UPLOAD_S3_MS : STALE_UPLOAD_TUS_MS
    const cutoff = new Date(now - staleMs)
    const reaped = await prisma.video.updateMany({
      where: { status: 'UPLOADING', updatedAt: { lt: cutoff } },
      data: {
        status: 'ERROR',
        processingError:
          'Upload did not complete (interrupted or abandoned) and was cleared automatically.',
      },
    })
    if (reaped.count > 0) {
      logMessage(
        `[processing-status] reaped ${reaped.count} abandoned UPLOADING row(s) older than ${Math.round(staleMs / 60000)} min`,
      )
    }
  } catch (err) {
    // Never fail the status endpoint over housekeeping.
    logError('[processing-status] stale-upload reap failed (non-fatal):', err)
  }
}

export const runtime = 'nodejs'
// 2.3.1+: belt-and-suspenders against the production-only "banner
// frozen at 75% HD+" bug. The handler IS dynamic — `requireApiAdmin`
// reads request headers — but Next.js's static-analysis didn't
// always detect that through the indirection, and prod was serving
// the same snapshot to every 3-second poll from the Data Cache.
// Local dev never saw it because dev disables route caching by
// default. Setting `force-dynamic` makes the dynamic intent
// explicit, and the `Cache-Control: no-store` header on the
// response below blocks any browser / reverse-proxy from
// memoising it on top.
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * 2.0.x+: lightweight roll-up of "what is the worker currently
 * busy with?" Used by the global `ProcessingStatusBanners` UI
 * at the bottom-right of the admin shell so the user knows when
 * a bulk import (e.g. `scripts/bulk-upload.mjs` against 4000
 * files) has actually finished processing.
 *
 * Returns counts + a sample list (max 50 each) for both
 * UPLOADING and PROCESSING states. The list is sorted by
 * `createdAt DESC` so the most recent activity appears first
 * when the user expands the banner. Includes minimal fields:
 * id, name, projectId, projectTitle, thumbnailPath, status,
 * versionLabel, createdAt.
 *
 * The list is capped at 50 per status to keep payload small
 * for the 3-second polling cadence. The top-level `count` is
 * the true total — useful for the "X / Y" banner label.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }
  // Match the sessionId pattern used by the folder listing
  // endpoint (`admin:<adminId>`) so thumbnail tokens minted
  // here are interchangeable with the ones minted there — same
  // namespacing in Redis, same TTL behaviour.
  const sessionId = `admin:${authResult.id}`
  // 7.10.0: the banners are personal. Every row still goes out (the folder
  // cards read the same list to paint their progress bar for everyone), but
  // each row says whether the signed-in person uploaded it, and the counts
  // that drive the bottom-right banners are computed for that person only.
  const viewerId = authResult.id

  // 4.2.3+: clear zombie UPLOADING rows before we count, so the banner this
  // request produces already reflects the reaped state (throttled internally).
  await reapAbandonedUploads()

  try {
    // Ask BullMQ which video-processing jobs are *actually*
    // running inside a worker right now. `getActive()` returns
    // jobs in the `active` state — i.e. their processor has
    // been entered but not yet resolved/rejected. We use the
    // resulting set of `videoId`s on the client to mark those
    // rows as ACTIVE vs the rest as QUEUED.
    //
    // In practice BullMQ's active list has brief empty windows:
    //   - the moment between job N completing and job N+1 being
    //     pulled off the wait queue
    //   - a worker restart
    //   - any transient Redis blip
    // In those windows we still want the user to see *something*
    // marked active (the dashboard is otherwise misleading — "no
    // active rows" implies the worker is idle). So we read the
    // active worker count alongside, and if BullMQ tells us "1
    // job should be active right now" but we couldn't actually
    // resolve a videoId, we'll fall back below to "the oldest N
    // PROCESSING rows" heuristic (BullMQ runs FIFO with bounded
    // concurrency, so the oldest-by-createdAt rows are the ones
    // a worker would have picked up first).
    let activeVideoIds = new Set<string>()
    let activeJobCount = 0
    let workerCount = 1
    try {
      const queue = getVideoQueue()
      const [active, workers] = await Promise.all([
        queue.getActive(0, 50),
        queue.getWorkers().catch(() => [] as Array<{ id?: string }>),
      ])
      // 3.9.x: only ENCODING jobs should light up the "Encoding tiers"
      // banner. Maintenance jobs that happen to run on the same queue —
      // regenerate-thumbnail and create-transcript — carry a `videoId`
      // too, and were incorrectly marking their (already-READY) video as
      // "processing", so a 17s clip's 2-minute transcript job showed as
      // "Encoding tiers … 100%" and just sat there. Those jobs have their
      // own bottom-right task banner, so we exclude them here.
      const encodingJobs = active.filter(
        (j) => j.name !== 'create-transcript' && j.name !== 'regenerate-thumbnail',
      )
      activeJobCount = encodingJobs.length
      activeVideoIds = new Set(
        encodingJobs.map((j) => (j.data as any)?.videoId).filter(Boolean)
      )
      // 6.14.0: a video the user explicitly STOPPED is not "still being
      // worked on", even though the tier that was already inside ffmpeg
      // keeps BullMQ's active list warm until it finishes. Without this, the
      // banner kept the row — at 100%, with nothing left to do — for the rest
      // of that encode, and there was no way to dismiss it.
      if (activeVideoIds.size > 0) {
        const stopped = await filterStoppedVideoIds([...activeVideoIds])
        for (const id of stopped) activeVideoIds.delete(id)
        activeJobCount = Math.max(0, activeJobCount - stopped.size)
      }
      // `getWorkers()` lists every BullMQ Worker connected to
      // this queue. With our single-process worker container
      // each `npm run worker` spawns one BullMQ Worker (with
      // `concurrency: N` internal slots), so workers.length is
      // 1 in production. Treat it as a floor of 1 so a stale
      // empty response doesn't accidentally suppress the
      // fallback heuristic.
      workerCount = Math.max(1, workers.length)
    } catch (err) {
      // Don't fail the whole status endpoint if BullMQ is
      // momentarily unreachable — fall through to the heuristic
      // below so the banner stays useful.
      logError('[processing-status] getActive failed:', err)
    }

    // 7.10.0: PROCESSING-or-active is counted twice — once for the company
    // (the cards) and once for the viewer (their banner). One `where`, so the
    // two can never disagree about what counts as "processing".
    const processingWhere: Prisma.VideoWhereInput =
      activeVideoIds.size > 0
        ? {
            OR: [
              { status: 'PROCESSING' },
              {
                id: { in: [...activeVideoIds] },
                status: { not: 'UPLOADING' },
              },
            ],
          }
        : { status: 'PROCESSING' }

    const [
      uploadingCount,
      processingCountBase,
      uploadingMineCount,
      processingMineCountBase,
      uploadingVideos,
      processingCandidates,
    ] = await Promise.all([
      prisma.video.count({ where: { status: 'UPLOADING' } }),
      // Count both "officially still PROCESSING" rows and the
      // higher-tier-still-encoding rows (status=READY but a
      // BullMQ worker is still on them). Matches the LIST query
      // below so the "X / Y done" banner header is consistent
      // with the rows the user can actually see when they
      // expand the panel.
      prisma.video.count({ where: processingWhere }),
      // 7.10.0: the viewer's own share of both, for the personal banners.
      prisma.video.count({ where: { status: 'UPLOADING', createdById: viewerId } }),
      prisma.video.count({ where: { AND: [processingWhere, { createdById: viewerId }] } }),
      prisma.video.findMany({
        where: { status: 'UPLOADING' },
        select: {
          id: true,
          name: true,
          versionLabel: true,
          thumbnailPath: true,
          status: true,
          createdAt: true,
          projectId: true,
          folderId: true,
          // 7.10.0: who uploaded it — the banners show a row only to that person.
          createdById: true,
          uploadProgress: true,
          processingProgress: true,
          // 6.14.0: the banner turns `uploadProgress` deltas into MB/s, which
          // needs the total. Works for ANY uploader — including a
          // bulk-upload.mjs run on another machine, where the browser has no
          // client-side transfer to measure.
          originalFileSize: true,
          width: true,
          height: true,
          // 2.2.6+: surface the tier ladder so the banner pip can
          // show the actual quality being encoded (SD / HD / HD+ /
          // 4K) instead of a generic pulsing dot.
          plannedTiers: true,
          completedTiers: true,
          // 2.2.6+: per-tier ffmpeg progress map (eg
          // `{"720p": 50}`). The processing banner uses it to
          // paint a SMOOTH overall progress instead of the
          // count-only `done/total` that previously sat at 0
          // until the row flipped to READY and jumped to 100.
          transcodeProgressByTier: true,
          project: { select: { id: true, title: true, previewResolution: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.video.findMany({
        // 2.0.x+: include videos with status=PROCESSING **or**
        // any videoId that BullMQ is currently working on. The
        // worker flips status=READY as soon as the first tier
        // (480p) lands so the player can stream immediately, but
        // it keeps churning on the higher tiers (720p, 1080p,
        // 2160p) for another 20-30 seconds after that. Without
        // pulling those still-active videos back in, the banner
        // would drop them the moment 480p finishes and the
        // active marker would jump to the next queued row even
        // though the worker is nowhere near done with the
        // original one.
        where: {
          OR: [
            { status: 'PROCESSING' },
            // The READY-but-BullMQ-active case. Guard against UPLOADING in
            // case a stale active job ever leaks across the upload boundary.
            ...(activeVideoIds.size > 0
              ? [{ id: { in: [...activeVideoIds] }, status: { not: 'UPLOADING' } } as Prisma.VideoWhereInput]
              : []),
            // 7.9.0: READY rows whose ladder is not finished. After 480p lands
            // a video is READY, and until now it stayed listed only while one
            // of its jobs was ACTIVE — so between two tiers, waiting for a free
            // slot, it vanished for a poll and the banner folded its whole
            // ladder into "done", then counted it again when it came back
            // ("25 / 27" for four uploads). The database knows the truth
            // regardless of the queue: keep it listed while
            // completedTiers < plannedTiers (filtered below; JSON columns
            // cannot be compared in the query). Bounded to recent rows.
            { status: 'READY', updatedAt: { gte: new Date(Date.now() - RECENT_READY_WINDOW_MS) } },
          ],
        },
        select: {
          id: true,
          name: true,
          versionLabel: true,
          thumbnailPath: true,
          status: true,
          createdAt: true,
          projectId: true,
          folderId: true,
          // 7.10.0: who uploaded it — the banners show a row only to that person.
          createdById: true,
          uploadProgress: true,
          processingProgress: true,
          originalFileSize: true,
          width: true,
          height: true,
          // 2.2.6+: see UPLOADING select above.
          plannedTiers: true,
          completedTiers: true,
          transcodeProgressByTier: true,
          project: { select: { id: true, title: true, previewResolution: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 120,
      }),
    ])

    // 7.9.0: keep a READY row only while its ladder is unfinished (or BullMQ
    // says it is active); PROCESSING rows always stay. See the query comment.
    const ladderUnfinished = (v: { plannedTiers: unknown; completedTiers: unknown }) => {
      const planned = Array.isArray(v.plannedTiers) ? v.plannedTiers.length : 0
      const completed = Array.isArray(v.completedTiers) ? v.completedTiers.length : 0
      return planned > 0 && completed < planned
    }
    const processingVideos = processingCandidates
      .filter((v) => v.status !== 'READY' || activeVideoIds.has(v.id) || ladderUnfinished(v))
      .slice(0, 50)
    // The DB count above covers PROCESSING and BullMQ-active rows; add the
    // READY-but-unfinished ones the query alone could not count.
    const processingCount =
      processingCountBase +
      processingVideos.filter((v) => v.status === 'READY' && !activeVideoIds.has(v.id)).length
    const processingMineCount =
      processingMineCountBase +
      processingVideos.filter(
        (v) => v.status === 'READY' && !activeVideoIds.has(v.id) && v.createdById === viewerId,
      ).length

    // Build the "effective active set" — what we actually return
    // as `isActive` on each row. Two sources, in priority order:
    //
    //  1. BullMQ's `getActive()` videoIds, when we resolved any.
    //     This is the authoritative answer when it's available.
    //  2. Fallback heuristic: the N oldest PROCESSING rows are
    //     assumed active, where N = max(activeJobCount, 1). This
    //     covers (a) the brief window between job N completing
    //     and job N+1 entering the processor, and (b) any
    //     Redis blip that makes `getActive()` return empty
    //     mid-batch. The reasoning: BullMQ runs the queue FIFO,
    //     so a worker is always working on the oldest waiting
    //     job — which by extension is one of the oldest rows
    //     still in PROCESSING.
    //
    // The user-visible effect is that exactly one row (or N for
    // higher concurrency) shows as active at all times the
    // worker is busy, instead of "long blank gaps".
    // First, try to honour BullMQ — but only keep videoIds that
    // actually appear in our visible PROCESSING list. A common
    // failure mode in earlier rounds was BullMQ returning an
    // active videoId whose DB row had already flipped to READY
    // between the two reads (or that lives outside our top-50
    // window) — leaving every visible row as queued.
    const visibleProcessingIds = new Set(processingVideos.map((v) => v.id))
    const bullmqHits = new Set(
      [...activeVideoIds].filter((id) => visibleProcessingIds.has(id))
    )
    let effectiveActiveIds: Set<string>
    if (bullmqHits.size > 0) {
      effectiveActiveIds = bullmqHits
    } else {
      // Fallback: BullMQ either gave us nothing, or only ids that
      // aren't in our visible list. The queue is FIFO with bounded
      // concurrency, so a worker is always chewing on one of the
      // oldest PROCESSING rows. Pick the N oldest and mark them
      // active. N = max(activeJobCount from BullMQ, 1) so that a
      // higher-concurrency worker still highlights the right
      // number of rows even when BullMQ's `data.videoId` lookup
      // misses.
      const fallbackN = Math.max(activeJobCount, 1)
      effectiveActiveIds = new Set(
        [...processingVideos]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, fallbackN)
          .map((v) => v.id)
      )
    }
    // workerCount intentionally unused on the response — we only
    // need it inside the active set computation. Silence eslint.
    void workerCount

    // Flatten the project relation + mint a thumbnail token so
    // the client can show a small poster image on each row. We
    // skip token minting for videos without a `thumbnailPath`
    // (e.g. UPLOADING rows that haven't reached the worker yet —
    // the instant-thumbnail step in /api/uploads runs only after
    // bytes are flushed). Failures are swallowed: the UI just
    // falls back to a muted placeholder.
    const shape = async (v: typeof uploadingVideos[number]) => {
      let thumbnailUrl: string | null = null
      if (v.thumbnailPath) {
        try {
          const token = await generateVideoAccessToken(
            v.id,
            v.projectId,
            'thumbnail',
            request,
            sessionId,
          )
          thumbnailUrl = `/api/content/${token}`
        } catch (err) {
          // Thumbnail not critical — log and continue.
          logError('[processing-status] thumbnail token failed:', err)
        }
      }
      return {
        id: v.id,
        name: v.name,
        versionLabel: v.versionLabel,
        thumbnailPath: v.thumbnailPath,
        thumbnailUrl,
        width: v.width,
        height: v.height,
        status: v.status,
        createdAt: v.createdAt.toISOString(),
        projectId: v.projectId,
        projectTitle: v.project?.title || '',
        folderId: v.folderId,
        uploadProgress: v.uploadProgress,
        processingProgress: v.processingProgress,
        // BigInt → number. File sizes here are at most terabytes, far inside
        // the safe-integer range, and the client only does arithmetic on it.
        originalFileSize:
          (v as any).originalFileSize != null ? Number((v as any).originalFileSize) : null,
        // 2.2.6+: forward the tier ladder so the banner can show
        // SD/HD/HD+/4K labels for the currently-encoding tier.
        // Pass-through as `string[] | null` — the Video schema
        // stores them as Json so they arrive as `unknown` from
        // Prisma; the client filters down to strings.
        plannedTiers: Array.isArray((v as any).plannedTiers)
          ? ((v as any).plannedTiers as unknown[]).filter((x) => typeof x === 'string') as string[]
          : null,
        // 7.9.0: the ladder the worker WILL decide, for rows it has not
        // reached yet — from the dimensions the browser probed at upload, or
        // from the project cap. Lets the banner's total be right from the
        // first second instead of growing as prepare-video reaches each file.
        plannedTiersPredicted:
          Array.isArray((v as any).plannedTiers) && ((v as any).plannedTiers as unknown[]).length > 0
            ? null
            : predictTierSlugs(v.width, v.height, (v as any).project?.previewResolution ?? 'auto'),
        completedTiers: Array.isArray((v as any).completedTiers)
          ? ((v as any).completedTiers as unknown[]).filter((x) => typeof x === 'string') as string[]
          : null,
        // 2.2.6+: forward the per-tier progress map. Defensive
        // narrowing — Json column comes back as `unknown`; we
        // only keep entries shaped `{ [tier]: number }`.
        transcodeProgressByTier:
          (v as any).transcodeProgressByTier &&
          typeof (v as any).transcodeProgressByTier === 'object'
            ? ((v as any).transcodeProgressByTier as Record<string, unknown>)
            : null,
        isActive: effectiveActiveIds.has(v.id),
        // 7.10.0: true when the signed-in person uploaded this row. The
        // bottom-right banners show only these; the folder cards show all.
        // A row with no uploader on record (very old rows, or a dev database
        // without the column) is nobody's — it stays on the cards for
        // everyone and in no one's banner.
        isMine: v.createdById != null && v.createdById === viewerId,
      }
    }

    const [shapedUploading, shapedProcessing] = await Promise.all([
      Promise.all(uploadingVideos.map(shape)),
      Promise.all(processingVideos.map(shape)),
    ])

    return NextResponse.json(
      {
        uploading: {
          count: uploadingCount,
          // 7.10.0: how many of them the viewer uploaded — the true total,
          // not the length of the capped list, so "3 in progress" is right
          // even when a colleague's bulk upload fills the 50-row window.
          mineCount: uploadingMineCount,
          videos: shapedUploading,
        },
        processing: {
          count: processingCount,
          mineCount: processingMineCount,
          videos: shapedProcessing,
        },
      },
      {
        // 2.3.1+: explicit no-store so neither browsers nor any
        // reverse proxy in front of the app (TrueNAS's traefik,
        // a CloudFlare tunnel, an nginx terminator …) hold on to
        // a snapshot between polls.
        headers: { 'Cache-Control': 'no-store, must-revalidate' },
      },
    )
  } catch (error) {
    logError('Error fetching processing status:', error)
    return NextResponse.json(
      { error: 'Failed to fetch processing status' },
      { status: 500 }
    )
  }
}
