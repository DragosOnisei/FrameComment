import { NextRequest, NextResponse } from 'next/server'
import { prisma, setOrgContextOn, currentOrgId } from '@/lib/db'
import { deleteFile } from '@/lib/storage'
import { allFileLocations } from '@/lib/storage-backends'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError, logMessage } from '@/lib/logging'
import { cancelPendingVideoJobs } from '@/lib/queue'

export const runtime = 'nodejs'




// GET /api/videos/[id] - Get video status (for polling during processing)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const videoMessages = messages?.videos || {}

  // SECURITY: Require admin authentication
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limit status checks (allow frequent polling)
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120, // Allow 2 requests per second for polling
    message: videoMessages.tooManyVideoStatusRequests || 'Too many video status requests. Please slow down.',
  }, 'video-status')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    
    const video = await prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        processingProgress: true,
        processingError: true,
        duration: true,
        width: true,
        height: true,
      }
    })

    if (!video) {
  return NextResponse.json({ error: videoMessages.videoNotFoundApi || 'Video not found' }, { status: 404 })
    }

    return NextResponse.json(video)
  } catch (error) {
    logError('Error fetching video status:', error)
    return NextResponse.json(
      { error: videoMessages.failedToFetchVideoStatus || 'Failed to fetch video status' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const videoMessages = messages?.videos || {}

  // SECURITY: Require admin authentication
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limit admin toggles
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: videoMessages.tooManyVideoUpdateRequests || 'Too many video update requests. Please slow down.',
  }, 'video-update')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    const body = await request.json()
    const { name, versionLabel, duration } = body

    // Validate inputs
    // 4.x: `duration` reconciliation. The player reports the TRUE media
    // duration on load; some source containers store a wrong value that the
    // folder card would otherwise show. Accept a finite, non-negative,
    // sane (< 24h) number. 0 is allowed (stills have no duration).
    if (
      duration !== undefined &&
      (typeof duration !== 'number' ||
        !Number.isFinite(duration) ||
        duration < 0 ||
        duration > 24 * 60 * 60)
    ) {
      return NextResponse.json(
        { error: 'Invalid request: duration must be a number of seconds' },
        { status: 400 }
      )
    }

    if (name !== undefined && (!name || typeof name !== 'string' || name.trim().length === 0)) {
      return NextResponse.json(
        { error: videoMessages.invalidName || 'Invalid request: name must be a non-empty string' },
        { status: 400 }
      )
    }

    if (versionLabel !== undefined && (!versionLabel || typeof versionLabel !== 'string' || versionLabel.trim().length === 0)) {
      return NextResponse.json(
        { error: videoMessages.invalidVersionLabel || 'Invalid request: versionLabel must be a non-empty string' },
        { status: 400 }
      )
    }

    // At least one field must be provided
    if (name === undefined && versionLabel === undefined && duration === undefined) {
      return NextResponse.json(
        { error: videoMessages.invalidUpdateRequest || 'Invalid request: at least one field must be provided' },
        { status: 400 }
      )
    }

    // Get video details
    const video = await prisma.video.findUnique({
      where: { id },
      include: { project: true }
    })

    if (!video) {
  return NextResponse.json({ error: videoMessages.videoNotFoundApi || 'Video not found' }, { status: 404 })
    }

    // Per-ROW fields (version label) apply only to THIS version. Name is
    // handled separately below because it's the GROUP's identity, not a
    // single row's.
    const rowUpdate: any = {}

    if (versionLabel !== undefined) {
      rowUpdate.versionLabel = versionLabel.trim()
    }

    // Duration correction applies to THIS specific version row.
    if (duration !== undefined) {
      rowUpdate.duration = duration
    }

    // 4.2.4+: RENAME applies to the WHOLE version group.
    //
    // In this app's Frame.io-style stacking every version of a video
    // shares the same `name`; that shared name IS what groups the rows
    // into one stack (see /api/videos/[id]/stack) and what both the grid
    // card and the player header display. So renaming must rewrite every
    // row in the group — otherwise (a) the one renamed row would fall
    // out of its stack (its name no longer matches its siblings) and
    // (b) the remaining versions would keep the old name, so the header
    // still looked "wrong" for those. We scope by projectId + folderId +
    // the CURRENT name, i.e. exactly the rows that form this stack.
    const newName =
      name !== undefined && name.trim() !== video.name ? name.trim() : null

    await prisma.$transaction(async (tx) => {
      // 5.0 multi-tenant: arm the org context inside the transaction.
      await setOrgContextOn(tx as any, currentOrgId())
      if (newName !== null) {
        await tx.video.updateMany({
          where: {
            projectId: video.projectId,
            folderId: video.folderId,
            name: video.name,
            // 5.12.1: leave trashed rows out of group renames — renaming a
            // same-named Trash row would otherwise drag it into this stack
            // when restored.
            deletedAt: null,
          } as any,
          data: { name: newName },
        })
      }
      if (Object.keys(rowUpdate).length > 0) {
        await tx.video.update({ where: { id }, data: rowUpdate })
      }
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: videoMessages.failedToUpdateVideo || 'Failed to update video' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const videoMessages = messages?.videos || {}

  // SECURITY: Require admin authentication
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    // 5.12.2: 30/min starved "Empty Trash" (item-by-item client loop) on
    // large trashes — the tail of a 300-item sweep got 429s and stuck in
    // Trash. This is an authenticated admin route; 240/min still throttles
    // abuse while letting legitimate bulk sweeps drain.
    maxRequests: 240,
    message: videoMessages.tooManyVideoDeleteRequests || 'Too many video delete requests. Please slow down.',
  }, 'video-delete')
  if (rateLimitResult) return rateLimitResult

  // Optional `?permanent=1` skips the soft-delete bucket and removes
  // the row + storage immediately. Used by the Trash UI for the
  // explicit "Delete permanently" action and by the cleanup cron
  // when expiring 30-day-old soft-deleted rows.
  const permanent =
    new URL(request.url).searchParams.get('permanent') === '1'

  try {
    const { id } = await params
    // Get video details
    const video = await prisma.video.findUnique({
      where: { id },
      include: {
        assets: true,
      }
    })

    if (!video) {
      return NextResponse.json({ error: videoMessages.videoNotFoundApi || 'Video not found' }, { status: 404 })
    }

    // Default path (1.0.8+): soft-delete. The row stays in the DB
    // with `deletedAt` set and disappears from every listing; users
    // can restore it from the Trash for 30 days.
    if (!permanent) {
      await prisma.video.update({
        where: { id },
        data: { deletedAt: new Date() } as any,
      })
      // 2.2.0+: yank pending encode-tier + finalize jobs for this
      // videoId so the queue doesn't burn worker slots on a row
      // that's now in the trash. The currently-active encode (if
      // any) will still self-abort via the TranscodeAborted /
      // P2025 path on its next DB write — that hasn't changed
      // since 1.9.4.
      cancelPendingVideoJobs(id).catch((err) =>
        logError(`[VIDEO DELETE] cancelPendingVideoJobs failed for ${id}:`, err),
      )
      return NextResponse.json({ success: true, soft: true })
    }

    // 2.2.0+: cancel any pending breadth-first jobs before we tear
    // down the row + storage. Doing this first means the encode-tier
    // workers don't race us to look up a row that's about to vanish.
    await cancelPendingVideoJobs(id).catch((err) =>
      logError(`[VIDEO DELETE] cancelPendingVideoJobs (permanent) failed for ${id}:`, err),
    )

    // Permanent delete — same legacy behaviour as before: wipe every
    // associated file on disk, then drop the row.
    // 4.2.0+: delete from EVERY backend the file lives on (NULL = legacy env;
    // 2b: storageLocations may list more than one after a keep-source transfer).
    const backends = allFileLocations((video as any).storageBackend, (video as any).storageLocations)
    const deleteEverywhere = async (p: string, bks = backends) => {
      for (const b of bks) await deleteFile(p, b).catch(() => {})
    }
    try {
      // Delete asset files only if no other assets point to the same storage path
      for (const asset of video.assets) {
        const sharedCount = await prisma.videoAsset.count({
          where: {
            storagePath: asset.storagePath,
            id: { not: asset.id },
          },
        })

        if (sharedCount === 0) {
          await deleteEverywhere(asset.storagePath, allFileLocations((asset as any).storageBackend, (asset as any).storageLocations))
        }
      }

      // Delete original file
      if (video.originalStoragePath) {
        await deleteEverywhere(video.originalStoragePath)
      }

      // Delete preview files
      if (video.preview1080Path) {
        await deleteEverywhere(video.preview1080Path)
      }
      if (video.preview720Path) {
        await deleteEverywhere(video.preview720Path)
      }

      // Delete thumbnail
      if (video.thumbnailPath) {
        const thumbnailSharedAssets = await prisma.videoAsset.count({
          where: {
            storagePath: video.thumbnailPath,
            videoId: { not: id },
          },
        })
        const thumbnailSharedVideos = await prisma.video.count({
          where: {
            thumbnailPath: video.thumbnailPath,
            id: { not: id },
          },
        })

        // Only delete if no other assets or videos reference this thumbnail path
        if (thumbnailSharedAssets === 0 && thumbnailSharedVideos === 0) {
          await deleteEverywhere(video.thumbnailPath)
        }
      }
    } catch (error) {
      logError(`Failed to delete files for video ${video.id}:`, error)
      // Continue with database deletion even if storage deletion fails
    }

    // Delete video from database (cascade will handle comments)
    await prisma.video.delete({
      where: { id: id },
    })

    return NextResponse.json({
      success: true,
      message: videoMessages.videoDeletedSuccessfully || 'Video and all related files deleted successfully',
    })
  } catch (error) {
    return NextResponse.json(
      { error: videoMessages.failedToDeleteVideoApi || 'Failed to delete video' },
      { status: 500 }
    )
  }
}
