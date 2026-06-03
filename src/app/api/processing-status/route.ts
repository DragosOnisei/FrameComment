import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getVideoQueue } from '@/lib/queue'
import { generateVideoAccessToken } from '@/lib/video-access'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

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
      activeJobCount = active.length
      activeVideoIds = new Set(
        active.map((j) => (j.data as any)?.videoId).filter(Boolean)
      )
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

    const [
      uploadingCount,
      processingCount,
      uploadingVideos,
      processingVideos,
    ] = await Promise.all([
      prisma.video.count({ where: { status: 'UPLOADING' } }),
      // Count both "officially still PROCESSING" rows and the
      // higher-tier-still-encoding rows (status=READY but a
      // BullMQ worker is still on them). Matches the LIST query
      // below so the "X / Y done" banner header is consistent
      // with the rows the user can actually see when they
      // expand the panel.
      activeVideoIds.size > 0
        ? prisma.video.count({
            where: {
              OR: [
                { status: 'PROCESSING' },
                {
                  id: { in: [...activeVideoIds] },
                  status: { not: 'UPLOADING' },
                },
              ],
            },
          })
        : prisma.video.count({ where: { status: 'PROCESSING' } }),
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
          uploadProgress: true,
          processingProgress: true,
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
          project: { select: { id: true, title: true } },
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
        where:
          activeVideoIds.size > 0
            ? {
                OR: [
                  { status: 'PROCESSING' },
                  // The READY-but-BullMQ-active case. Guard
                  // against UPLOADING in case a stale active job
                  // ever leaks across the upload boundary.
                  {
                    id: { in: [...activeVideoIds] },
                    status: { not: 'UPLOADING' },
                  },
                ],
              }
            : { status: 'PROCESSING' },
        select: {
          id: true,
          name: true,
          versionLabel: true,
          thumbnailPath: true,
          status: true,
          createdAt: true,
          projectId: true,
          folderId: true,
          uploadProgress: true,
          processingProgress: true,
          width: true,
          height: true,
          // 2.2.6+: see UPLOADING select above.
          plannedTiers: true,
          completedTiers: true,
          transcodeProgressByTier: true,
          project: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ])

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
        // 2.2.6+: forward the tier ladder so the banner can show
        // SD/HD/HD+/4K labels for the currently-encoding tier.
        // Pass-through as `string[] | null` — the Video schema
        // stores them as Json so they arrive as `unknown` from
        // Prisma; the client filters down to strings.
        plannedTiers: Array.isArray((v as any).plannedTiers)
          ? ((v as any).plannedTiers as unknown[]).filter((x) => typeof x === 'string') as string[]
          : null,
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
      }
    }

    const [shapedUploading, shapedProcessing] = await Promise.all([
      Promise.all(uploadingVideos.map(shape)),
      Promise.all(processingVideos.map(shape)),
    ])

    return NextResponse.json({
      uploading: {
        count: uploadingCount,
        videos: shapedUploading,
      },
      processing: {
        count: processingCount,
        videos: shapedProcessing,
      },
    })
  } catch (error) {
    logError('Error fetching processing status:', error)
    return NextResponse.json(
      { error: 'Failed to fetch processing status' },
      { status: 500 }
    )
  }
}
