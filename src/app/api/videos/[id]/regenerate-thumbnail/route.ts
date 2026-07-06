import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getVideoQueue, VIDEO_JOB_PRIORITY, RegenerateThumbnailJob } from '@/lib/queue'
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

    const queue = getVideoQueue()
    const job: RegenerateThumbnailJob = {
      videoId: video.id,
      projectId: video.projectId,
      originalStoragePath: video.originalStoragePath,
    }
    await queue.add('regenerate-thumbnail', job, {
      priority: VIDEO_JOB_PRIORITY.REGENERATE_THUMBNAIL,
      jobId: `regen-thumb-${video.id}`,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error enqueueing per-video regenerate-thumbnail job:', error)
    return NextResponse.json(
      { error: 'Failed to enqueue regenerate-thumbnail job' },
      { status: 500 },
    )
  }
}
