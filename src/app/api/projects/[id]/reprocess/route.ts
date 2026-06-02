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
import { rateLimit } from '@/lib/rate-limit'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { z } from 'zod'
import { logError } from '@/lib/logging'
import { computeExpectedTiers, detectCompletedTiers, TierSlug } from '@/lib/tier-planning'

export const runtime = 'nodejs'

const reprocessSchema = z.object({
  videoIds: z.array(z.string().min(1)).max(50).optional(),
  // 2.2.4+: caller can force a full re-encode (delete + re-do every
  // tier). Default = false = smart mode, which only encodes the
  // missing tiers.
  forceFull: z.boolean().optional(),
})

/**
 * 2.2.4+ POST /api/projects/[id]/reprocess
 *
 * SMART by default: for each READY/ERROR video the endpoint computes
 * the full expected tier ladder from the source's stored width/height
 * and the project's `previewResolution`, compares that against the
 * tiers already completed (union of `completedTiers` JSON + legacy
 * `preview*Path` columns), and enqueues only the MISSING tier jobs.
 * Already-finished tiers and their MP4/HLS files are left in place
 * — the worker's per-tier append + finalize logic merges the new
 * ones in alongside.
 *
 * Pass `{ forceFull: true }` to fall back to the pre-2.2.4 behaviour:
 * delete every preview file, reset the row, and re-enqueue
 * `prepare-video` so the whole ladder runs from scratch. Use that
 * for "I want everything re-encoded with new settings" cases (eg
 * after flipping the watermark on a 4K-deep project).
 *
 * Videos with missing-tier-set = empty are silently skipped — they
 * already have everything the project setting asks for, so there's
 * no work to do.
 *
 * Videos with width=0/height=0 (legacy rows that never got a metadata
 * probe) fall back to the full prepare-video path even in smart mode
 * — we can't plan a ladder without dimensions.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const projectMessages = messages?.projects || {}

  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: projectMessages.tooManyReprocessRequests || 'Too many reprocess requests. Please slow down.',
  }, 'project-reprocess')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id: projectId } = await params
    const body = await request.json().catch(() => ({}))
    const parsed = reprocessSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 })
    }
    const { videoIds, forceFull } = parsed.data

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        previewResolution: true,
      },
    })
    if (!project) {
      return NextResponse.json({ error: projectMessages.projectNotFoundApi || 'Project not found' }, { status: 404 })
    }

    const videos = await prisma.video.findMany({
      where: {
        projectId,
        status: { in: ['READY', 'ERROR'] },
        deletedAt: null,
        mediaType: 'VIDEO',
        ...(videoIds && videoIds.length > 0 ? { id: { in: videoIds } } : {}),
      },
      select: {
        id: true,
        name: true,
        versionLabel: true,
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
      } as any,
    })

    if (videos.length === 0) {
      return NextResponse.json({
        error: projectMessages.noVideosAvailableForReprocessing || 'No videos available for reprocessing',
      }, { status: 400 })
    }

    const queue = getVideoQueue()
    const enqueued: { id: string; name: string; versionLabel: string; mode: 'full' | 'smart'; missing: TierSlug[] }[] = []
    const skipped: { id: string; name: string; versionLabel: string; reason: string }[] = []

    for (const video of videos as any[]) {
      // ─── Mode selection ─────────────────────────────────────────
      // forceFull = caller asked for the destructive path explicitly.
      // dims invalid = we can't plan a ladder — fall back too.
      const dimsValid = (video.width ?? 0) > 0 && (video.height ?? 0) > 0
      const useFull = forceFull === true || !dimsValid

      if (useFull) {
        // ─── Legacy / forced full reprocess ────────────────────────
        // Same logic as pre-2.2.4: wipe every derived file (keep
        // original + custom thumbnails), reset row, enqueue prepare.
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

        await Promise.allSettled(filesToDelete.map(f => deleteFile(f)))

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
            projectId: project.id,
          },
          { priority: 1, jobId: `prepare-${video.id}` },
        )
        enqueued.push({
          id: video.id,
          name: video.name,
          versionLabel: video.versionLabel,
          mode: 'full',
          missing: [],
        })
        continue
      }

      // ─── Smart path ─────────────────────────────────────────────
      //
      // Thumbnail policy (2.2.4+): smart Re-process NEVER touches
      // `Video.thumbnailPath` and NEVER deletes the on-storage
      // thumbnail file. Encoded tiers and thumbnails are kept on
      // strictly independent code paths so a Re-process can't
      // accidentally clear a card image — that's what the dedicated
      // Re-generate Thumbnails button is for. The Prisma `update`
      // below intentionally omits `thumbnailPath` from its `data`,
      // and `encode-tier-processor` + `finalize-video-processor`
      // never reference the column.
      const expected = computeExpectedTiers(video.width, video.height, project.previewResolution)
      const completed = detectCompletedTiers(video)
      const completedSet = new Set(completed)
      const missing: TierSlug[] = expected.filter(t => !completedSet.has(t))

      if (missing.length === 0) {
        skipped.push({
          id: video.id,
          name: video.name,
          versionLabel: video.versionLabel,
          reason: 'All expected tiers already present',
        })
        continue
      }

      // Persist a cleaner planning state: plannedTiers = full
      // expected ladder, completedTiers = what we detected. This
      // keeps the UI's Quality menu in sync — it'll show every
      // missing tier as "pending 0%" until the new encode-tier
      // jobs flip them to 100%.
      try {
        await prisma.video.update({
          where: { id: video.id },
          data: {
            plannedTiers: expected as any,
            completedTiers: completed as any,
            // Flip ERROR rows to PROCESSING so the dashboard
            // banner picks them up; leave READY rows alone (their
            // first tier landed long ago, the new ones are
            // additive and shouldn't yank the status backwards).
            ...(video.status === 'ERROR' ? { status: 'PROCESSING' as any } : {}),
            // Soft-reset progress to the fraction we already know
            // about so the dashboard doesn't claim 0%.
            processingProgress: expected.length > 0
              ? Math.min(99, Math.round((completed.length / expected.length) * 100))
              : 0,
          } as any,
        })
      } catch (err: any) {
        if (err?.code === 'P2025') {
          skipped.push({
            id: video.id,
            name: video.name,
            versionLabel: video.versionLabel,
            reason: 'Row deleted between read and write',
          })
          continue
        }
        throw err
      }

      // Enqueue ONE encode-tier per missing tier — same priority
      // mapping as the normal upload path, so a maintenance sweep
      // composes nicely with in-flight encoding for fresh uploads.
      for (const tier of missing) {
        const job: EncodeTierJob = {
          videoId: video.id,
          projectId: project.id,
          originalStoragePath: video.originalStoragePath,
          tier,
        }
        await queue.add('encode-tier', job, {
          priority: priorityForTier(tier),
          jobId: `encode-${video.id}-${tier}`,
        })
      }

      // Finalize at the bottom of the pipeline — it'll trip when
      // completedTiers.length === plannedTiers.length, generate
      // the storyboard, and flag the row fully READY.
      const finalizeJob: FinalizeVideoJob = {
        videoId: video.id,
        projectId: project.id,
        originalStoragePath: video.originalStoragePath,
      }
      await queue.add('finalize-video', finalizeJob, {
        priority: VIDEO_JOB_PRIORITY.FINALIZE,
        jobId: `finalize-${video.id}`,
      })

      enqueued.push({
        id: video.id,
        name: video.name,
        versionLabel: video.versionLabel,
        mode: 'smart',
        missing,
      })
    }

    return NextResponse.json({
      success: true,
      count: enqueued.length,
      skippedCount: skipped.length,
      videos: enqueued,
      skipped,
    })
  } catch (error) {
    logError('Error reprocessing videos:', error)
    return NextResponse.json(
      { error: projectMessages.failedToReprocessVideos || 'Failed to reprocess videos' },
      { status: 500 },
    )
  }
}
