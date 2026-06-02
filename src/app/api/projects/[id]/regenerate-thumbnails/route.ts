import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getVideoQueue, VIDEO_JOB_PRIORITY, RegenerateThumbnailJob } from '@/lib/queue'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 2.2.4+ POST /api/projects/[id]/regenerate-thumbnails
 *
 * Enqueue a `regenerate-thumbnail` job for every READY video in the
 * project. Used by the "Re-generate Thumbnails" button under Project
 * Settings → Video Processing.
 *
 * This is a maintenance endpoint:
 *   - It does NOT touch encoded tiers, status, or planned/completed
 *     tier lists.
 *   - Each enqueued job runs at priority 700 (post-FINALIZE) so the
 *     sweep never delays in-flight encoding for fresh uploads.
 *   - Videos in non-READY states (UPLOADING / PROCESSING / ERROR)
 *     are skipped — they either don't have a usable original yet or
 *     are already in another stage of the pipeline.
 *
 * Skips IMAGE rows entirely (their thumbnail IS the original).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 10,
      message: 'Too many regenerate-thumbnails requests. Please slow down.',
    },
    'project-regenerate-thumbnails',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const videos = await prisma.video.findMany({
      where: {
        projectId,
        status: 'READY',
        deletedAt: null,
        mediaType: 'VIDEO',
      },
      select: {
        id: true,
        name: true,
        versionLabel: true,
        originalStoragePath: true,
      },
    })

    if (videos.length === 0) {
      return NextResponse.json({
        success: true,
        count: 0,
        videos: [],
      })
    }

    const queue = getVideoQueue()
    const enqueued: { id: string; name: string; versionLabel: string }[] = []

    for (const video of videos) {
      const job: RegenerateThumbnailJob = {
        videoId: video.id,
        projectId,
        originalStoragePath: video.originalStoragePath,
      }
      await queue.add('regenerate-thumbnail', job, {
        priority: VIDEO_JOB_PRIORITY.REGENERATE_THUMBNAIL,
        // Dedupe per video so a double-click on the button doesn't
        // double-schedule the same work.
        jobId: `regen-thumb-${video.id}`,
      })
      enqueued.push({
        id: video.id,
        name: video.name,
        versionLabel: video.versionLabel,
      })
    }

    return NextResponse.json({
      success: true,
      count: enqueued.length,
      videos: enqueued,
    })
  } catch (error) {
    logError('Error enqueueing regenerate-thumbnail jobs:', error)
    return NextResponse.json(
      { error: 'Failed to enqueue regenerate-thumbnail jobs' },
      { status: 500 },
    )
  }
}
