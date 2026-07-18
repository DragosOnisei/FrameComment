import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import {
  getVideoQueue,
  VIDEO_JOB_PRIORITY,
  priorityForTier,
  EncodeTierJob,
  FinalizeVideoJob,
} from '@/lib/queue'
import { deleteFile } from '@/lib/storage'
import { resolveFileBackend } from '@/lib/storage-backends'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { computeExpectedTiers, detectCompletedTiers } from '@/lib/tier-planning'
import { z } from 'zod'

export const runtime = 'nodejs'

const reprocessAllSchema = z.object({
  // 2.2.4+: see the per-project route for the rationale. Default
  // is the SMART path — only missing tiers get encoded.
  forceFull: z.boolean().optional(),
})

/**
 * 2.2.4+ POST /api/settings/reprocess-all-videos
 *
 * Global reprocess sweep — same smart-by-default logic as
 * `/api/projects/[id]/reprocess`, fanned out across every
 * (non-trash) project. Each video gets:
 *   - Smart mode (default): only the tiers missing from its
 *     project's expected ladder get encoded. Already-finished
 *     tiers stay on disk and in the DB.
 *   - Full mode (forceFull=true): the legacy "wipe + re-do
 *     everything" path. Heavy. Use only when reprocessing all
 *     tiers is actually what you want (eg after switching
 *     watermark presets globally).
 *
 * Rate-limited stricter than the per-project endpoint (2 reqs/min)
 * — this can enqueue thousands of jobs per call.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 2,
      message: 'Too many global reprocess requests. Please slow down.',
    },
    'global-reprocess-all',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json().catch(() => ({}))
    const parsed = reprocessAllSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const { forceFull } = parsed.data

    const videos = await prisma.video.findMany({
      where: {
        status: { in: ['READY', 'ERROR'] },
        deletedAt: null,
        mediaType: 'VIDEO',
        project: { deletedAt: null },
      },
      select: {
        id: true,
        projectId: true,
        status: true,
        width: true,
        height: true,
        originalStoragePath: true,
        thumbnailPath: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        preview2160Path: true,
        cleanPreview720Path: true,
        cleanPreview1080Path: true,
        cleanPreview2160Path: true,
        completedTiers: true,
        plannedTiers: true,
        project: { select: { previewResolution: true } },
      } as any,
    })

    if (videos.length === 0) {
      return NextResponse.json({ success: true, count: 0, skippedCount: 0 })
    }

    const queue = getVideoQueue()
    let enqueued = 0
    let skipped = 0

    for (const video of videos as any[]) {
      const dimsValid = (video.width ?? 0) > 0 && (video.height ?? 0) > 0
      const useFull = forceFull === true || !dimsValid

      if (useFull) {
        const hasCustomThumbnail = video.thumbnailPath
          ? !!(await prisma.videoAsset.findFirst({
              where: { videoId: video.id, storagePath: video.thumbnailPath },
              select: { id: true },
            })) || video.thumbnailPath.includes('/videos/assets/')
          : false

        const filesToDelete = [
          video.preview2160Path,
          video.preview720Path,
          video.preview1080Path,
          video.preview480Path,
          video.cleanPreview2160Path,
          video.cleanPreview720Path,
          video.cleanPreview1080Path,
          hasCustomThumbnail ? null : video.thumbnailPath,
        ].filter(Boolean) as string[]

        const videoBackend = resolveFileBackend(video.storageBackend)
        await Promise.allSettled(filesToDelete.map(f => deleteFile(f, videoBackend)))

        await prisma.video.update({
          where: { id: video.id },
          data: {
            status: 'PROCESSING',
            preview480Path: null,
            preview720Path: null,
            preview1080Path: null,
            preview2160Path: null,
            cleanPreview720Path: null,
            cleanPreview1080Path: null,
            cleanPreview2160Path: null,
            thumbnailPath: hasCustomThumbnail ? video.thumbnailPath : null,
          } as any,
        })

        await queue.add(
          'prepare-video',
          {
            videoId: video.id,
            originalStoragePath: video.originalStoragePath,
            projectId: video.projectId,
          },
          { priority: 1, jobId: `prepare-${video.id}` },
        )
        enqueued++
        continue
      }

      // Smart-path thumbnail policy (2.2.4+): identical to the
      // per-project endpoint — `Video.thumbnailPath` is intentionally
      // never written here, and no `deleteFile` is ever called for
      // the on-storage thumbnail. The dedicated Re-generate
      // Thumbnails button is the only path that mutates thumbnails.
      const expected = computeExpectedTiers(
        video.width,
        video.height,
        video.project?.previewResolution || 'auto',
      )
      const completed = detectCompletedTiers(video)
      const completedSet = new Set(completed)
      const missing = expected.filter(t => !completedSet.has(t))

      if (missing.length === 0) {
        skipped++
        continue
      }

      try {
        await prisma.video.update({
          where: { id: video.id },
          data: {
            plannedTiers: expected as any,
            completedTiers: completed as any,
            ...(video.status === 'ERROR' ? { status: 'PROCESSING' as any } : {}),
            processingProgress: expected.length > 0
              ? Math.min(99, Math.round((completed.length / expected.length) * 100))
              : 0,
          } as any,
        })
      } catch (err: any) {
        if (err?.code === 'P2025') {
          skipped++
          continue
        }
        throw err
      }

      for (const tier of missing) {
        const job: EncodeTierJob = {
          videoId: video.id,
          projectId: video.projectId,
          originalStoragePath: video.originalStoragePath,
          tier,
        }
        await queue.add('encode-tier', job, {
          priority: priorityForTier(tier),
          jobId: `encode-${video.id}-${tier}`,
        })
      }

      const finalizeJob: FinalizeVideoJob = {
        videoId: video.id,
        projectId: video.projectId,
        originalStoragePath: video.originalStoragePath,
      }
      await queue.add('finalize-video', finalizeJob, {
        priority: VIDEO_JOB_PRIORITY.FINALIZE,
        jobId: `finalize-${video.id}`,
      })

      enqueued++
    }

    return NextResponse.json({ success: true, count: enqueued, skippedCount: skipped })
  } catch (error) {
    logError('Error enqueueing global reprocess jobs:', error)
    return NextResponse.json(
      { error: 'Failed to enqueue global reprocess jobs' },
      { status: 500 },
    )
  }
}
