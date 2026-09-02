import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getVideoQueue, VIDEO_JOB_PRIORITY, ApplySpeedJob } from '@/lib/queue'
import { isSaveableSpeedFactor, formatSpeedFactor } from '@/lib/video-speed'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const speedSchema = z.object({
  factor: z
    .number()
    .refine(isSaveableSpeedFactor, 'Unsupported speed factor'),
})

/**
 * 7.5.0: POST /api/videos/[id]/speed — permanently rewrite the video at a
 * faster speed (the "Save" button next to the player's speed pill, behind
 * its warning dialog).
 *
 * This is DESTRUCTIVE and admin-only, same guard as deleting the video: the
 * original is re-encoded at the factor and replaced, every quality is
 * rebuilt from it, comments and markers are repositioned, and there is no
 * way back except re-uploading the source. The route itself only validates
 * and enqueues — the heavy lifting (ffmpeg, the atomic swap+rescale, the
 * pipeline re-entry) lives in the worker's apply-speed processor.
 *
 * Only READY videos qualify: a video mid-encode has jobs in flight that
 * would race the swap, and an ERROR row has no trustworthy master state to
 * transform. The row flips to PROCESSING here so the UI reacts immediately.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 5, message: 'Too many speed changes. Please wait a moment.' },
    'video-apply-speed',
  )
  if (limited) return limited

  try {
    const { id: videoId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = speedSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const { factor } = parsed.data

    // Armed client: RLS scopes the lookup to the caller's organization.
    const video = (await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        originalStoragePath: true,
        mediaType: true,
        status: true,
        deletedAt: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        preview2160Path: true,
        cleanPreview720Path: true,
        cleanPreview1080Path: true,
        cleanPreview2160Path: true,
        hlsBasePath: true,
      } as any,
    })) as any
    if (!video || video.deletedAt) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }
    if (video.mediaType !== 'VIDEO') {
      return NextResponse.json({ error: 'Speed can only be saved on videos' }, { status: 400 })
    }
    if (video.status !== 'READY') {
      return NextResponse.json(
        { error: 'The video is still processing — try again when it is ready' },
        { status: 409 },
      )
    }

    // Flip to PROCESSING AND unhook every playable derived file right now.
    // The first cut only flipped the status and left the old tiers on the
    // row "so the video stays playable until the swap" — and live testing
    // (2026-09-02) showed exactly why that was wrong: the page kept playing
    // the OLD-speed video mid-rewrite before snapping to the new one. From
    // this update on there is nothing old-speed left to play — the player
    // shows processing until the first NEW tier lands. The files themselves
    // are deleted by the worker after a successful swap (their paths travel
    // in the job); on failure the worker rebuilds tiers from the untouched
    // old master, so the video comes back playable either way.
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: 'PROCESSING',
        processingProgress: 0,
        processingError: null,
        preview480Path: null,
        preview720Path: null,
        preview1080Path: null,
        preview2160Path: null,
        preview480Size: null,
        preview720Size: null,
        preview1080Size: null,
        preview2160Size: null,
        cleanPreview720Path: null,
        cleanPreview1080Path: null,
        cleanPreview2160Path: null,
        hlsBasePath: null,
        hlsQualities: [],
        transcodeProgressByTier: {},
        plannedTiers: [],
        completedTiers: [],
      } as any,
    })

    try {
      const queue = getVideoQueue()
      // A completed apply-speed job from <1h ago would swallow a re-add with
      // the same deterministic id — clear it first (no-op when absent).
      await queue.remove(`apply-speed-${videoId}`).catch(() => {})
      const job: ApplySpeedJob = {
        videoId,
        projectId: video.projectId,
        originalStoragePath: video.originalStoragePath,
        factor,
        oldPreviewPaths: [
          video.preview480Path,
          video.preview720Path,
          video.preview1080Path,
          video.preview2160Path,
          video.cleanPreview720Path,
          video.cleanPreview1080Path,
          video.cleanPreview2160Path,
        ].filter(Boolean),
        oldHlsBasePath: video.hlsBasePath ?? null,
      }
      await queue.add('apply-speed', job, {
        priority: VIDEO_JOB_PRIORITY.APPLY_SPEED,
        jobId: `apply-speed-${videoId}`,
        // Single shot, no automatic retries: the failure path restores the
        // video (tiers rebuilt from the untouched old master) and the admin
        // can simply press Save again — that is a far better story than a
        // background retry re-running ffmpeg minutes later on a video whose
        // owner already moved on. Stalled-job redelivery after a worker
        // crash still exists, which is what the processor's path guard is
        // for.
        attempts: 1,
      })
    } catch (queueErr) {
      // Redis unreachable between the status flip and the enqueue would
      // leave the row claiming PROCESSING forever with no job to deliver
      // it. Put the truth back before reporting the failure.
      await prisma.video
        .update({ where: { id: videoId }, data: { status: 'READY', processingProgress: 100 } as any })
        .catch(() => {})
      throw queueErr
    }

    logMessage(`[video-speed] ${videoId}: enqueued permanent rewrite at ${formatSpeedFactor(factor)}`)
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[video-speed] failed:', error)
    return NextResponse.json({ error: 'Failed to start the speed rewrite' }, { status: 500 })
  }
}
