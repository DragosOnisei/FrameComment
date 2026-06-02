import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getVideoQueue, VIDEO_JOB_PRIORITY, RegenerateThumbnailJob } from '@/lib/queue'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 2.2.4+ POST /api/settings/regenerate-thumbnails
 *
 * Global maintenance sweep — enqueue a `regenerate-thumbnail` job
 * for every READY video across every (non-trash) project. Triggered
 * by the "Re-generate Thumbnails" button under Global Settings →
 * Video Processing.
 *
 * Same semantics as the per-project endpoint, just project-agnostic.
 * Jobs run at priority 700 (post-FINALIZE) so a multi-thousand-video
 * sweep never delays in-flight tier encoding for fresh uploads.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  // Stricter window than the per-project endpoint: this is a
  // catalog-wide sweep so the operator shouldn't be firing it more
  // than once a minute.
  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 3,
      message: 'Too many global regenerate-thumbnails requests. Please slow down.',
    },
    'global-regenerate-thumbnails',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const videos = await prisma.video.findMany({
      where: {
        status: 'READY',
        deletedAt: null,
        mediaType: 'VIDEO',
        project: { deletedAt: null },
      },
      select: {
        id: true,
        projectId: true,
        originalStoragePath: true,
      },
    })

    if (videos.length === 0) {
      return NextResponse.json({ success: true, count: 0 })
    }

    const queue = getVideoQueue()
    let enqueued = 0
    for (const video of videos) {
      const job: RegenerateThumbnailJob = {
        videoId: video.id,
        projectId: video.projectId,
        originalStoragePath: video.originalStoragePath,
      }
      await queue.add('regenerate-thumbnail', job, {
        priority: VIDEO_JOB_PRIORITY.REGENERATE_THUMBNAIL,
        jobId: `regen-thumb-${video.id}`,
      })
      enqueued++
    }

    return NextResponse.json({ success: true, count: enqueued })
  } catch (error) {
    logError('Error enqueueing global regenerate-thumbnail jobs:', error)
    return NextResponse.json(
      { error: 'Failed to enqueue global regenerate-thumbnail jobs' },
      { status: 500 },
    )
  }
}
