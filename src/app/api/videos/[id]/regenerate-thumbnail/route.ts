import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import {
  getVideoQueue,
  enqueueRegenerateThumbnail,
  regenerateThumbnailJobId,
  RegenerateThumbnailJob,
} from '@/lib/queue'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.8.x POST /api/videos/[id]/regenerate-thumbnail
 *
 * Per-video sibling of the project-level regenerate-thumbnails sweep.
 * Enqueues a single `regenerate-thumbnail` job — used by the "Regenerate
 * thumbnail" item in the video kebab / right-click menu when a clip ended
 * up with a missing or broken cover. Deduped per video so double-clicks
 * don't double-schedule. Admin-only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many regenerate-thumbnail requests. Please slow down.',
    },
    'video-regenerate-thumbnail',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: videoId } = await params

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        originalStoragePath: true,
        mediaType: true,
        deletedAt: true,
      },
    })

    if (!video || video.deletedAt) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }
    if (video.mediaType === 'IMAGE') {
      // Images use the original as their thumbnail — nothing to regenerate.
      return NextResponse.json(
        { error: 'Images use the original as their thumbnail' },
        { status: 400 },
      )
    }

    const job: RegenerateThumbnailJob = {
      videoId: video.id,
      projectId: video.projectId,
      originalStoragePath: video.originalStoragePath,
    }
    // 7.12.0: a finished or failed job under this video's id is replaced, so
    // the click always results in a run; one still queued or running is
    // reported as such instead of being silently swallowed.
    const outcome = await enqueueRegenerateThumbnail(job)

    return NextResponse.json({ success: true, alreadyQueued: outcome === 'already-queued' })
  } catch (error) {
    logError('Error enqueueing per-video regenerate-thumbnail job:', error)
    return NextResponse.json(
      { error: 'Failed to enqueue regenerate-thumbnail job' },
      { status: 500 },
    )
  }
}

/**
 * 7.12.0 GET /api/videos/[id]/regenerate-thumbnail
 *
 * The state of this video's regenerate job, for the banner the folder view
 * shows after the click. Until now the banner could only watch the grid for a
 * changed `thumbnailPath` and, after a minute, closed with "Thumbnail updated"
 * whether or not anything had happened — reassuring, and wrong every time the
 * job had failed. Now it asks: `waiting`/`active` keep the spinner honest
 * for as long as the worker is really on it, `failed` carries the reason the
 * worker threw, `completed` and `none` (already swept) mean the grid is the
 * truth. `thumbnailPath` is returned alongside so one poll answers both
 * questions.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  // Polled every few seconds while a banner is open; 20 per minute per
  // video is the natural rate, this leaves room for a few open at once.
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 120, message: 'Too many status requests.' },
    'video-regenerate-thumbnail-status',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: videoId } = await params
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, thumbnailPath: true, deletedAt: true },
    })
    if (!video || video.deletedAt) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const job = await getVideoQueue().getJob(regenerateThumbnailJobId(videoId))
    const state = job ? await job.getState() : 'none'
    return NextResponse.json(
      {
        state,
        failedReason: job && state === 'failed' ? job.failedReason || 'Unknown error' : null,
        attemptsMade: job ? job.attemptsMade : 0,
        thumbnailPath: video.thumbnailPath,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    logError('Error reading regenerate-thumbnail job state:', error)
    return NextResponse.json({ error: 'Failed to read job state' }, { status: 500 })
  }
}
