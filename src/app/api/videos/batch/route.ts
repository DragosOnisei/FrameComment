import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'




export async function PATCH(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const videoMessages = messages?.videos || {}

  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // 1.7.1+: rate limit removed — batch ops are admin-only and the
  // legitimate use case (bulk-creating folders for a 200-file
  // upload) blew past 60/min. `requireApiAdmin` above is the only
  // gate we need here.

  try {
    const body = await request.json()
    const { videoIds, name, folderId } = body

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return NextResponse.json(
        { error: videoMessages.invalidBatchRequest || 'Invalid request' },
        { status: 400 }
      )
    }

    // Batch size limit: max 100 items
    if (videoIds.length > 100) {
      return NextResponse.json(
        { error: videoMessages.batchSizeLimitExceeded || 'Batch size limit exceeded' },
        { status: 400 }
      )
    }

    // Each call must include at least one of `name` or `folderId`.
    // 1.0.7+: `folderId` (string | null) lets the caller move a whole
    // version group into another folder in one round trip — used by
    // drag-and-drop of a video card onto a folder card.
    const hasName = name !== undefined
    const hasFolder = folderId !== undefined
    if (!hasName && !hasFolder) {
      return NextResponse.json(
        { error: videoMessages.invalidBatchRequest || 'Invalid request' },
        { status: 400 }
      )
    }
    if (hasName && (!name || typeof name !== 'string' || name.trim().length === 0)) {
      return NextResponse.json(
        { error: videoMessages.invalidBatchName || 'name must be a non-empty string' },
        { status: 400 }
      )
    }
    if (
      hasFolder &&
      folderId !== null &&
      (typeof folderId !== 'string' || folderId.trim().length === 0)
    ) {
      return NextResponse.json(
        { error: 'folderId must be a string or null' },
        { status: 400 }
      )
    }

    // If the caller is moving videos into a folder, make sure the
    // folder exists AND belongs to the same project as every video.
    // This keeps cross-project moves out of the picture (which would
    // be a permission-leak vector).
    if (hasFolder && folderId !== null) {
      const targetFolder = await prisma.folder.findUnique({
        where: { id: folderId as string },
        select: { id: true, projectId: true },
      })
      if (!targetFolder) {
        return NextResponse.json(
          { error: 'Target folder not found' },
          { status: 404 },
        )
      }
      const videos = await prisma.video.findMany({
        where: { id: { in: videoIds } },
        select: { id: true, projectId: true },
      })
      const wrongProject = videos.find(
        (v) => v.projectId !== targetFolder.projectId,
      )
      if (wrongProject) {
        return NextResponse.json(
          { error: 'Target folder belongs to a different project' },
          { status: 400 },
        )
      }
    }

    // Build the update payload — only the fields the caller supplied
    // get touched. Both updates happen in a single Prisma call.
    const data: { name?: string; folderId?: string | null } = {}
    if (hasName) data.name = (name as string).trim()
    if (hasFolder) data.folderId = folderId as string | null

    const result = await prisma.video.updateMany({
      where: { id: { in: videoIds } },
      data,
    })

    return NextResponse.json({
      success: true,
      updated: result.count
    })
  } catch (error) {
    logError('Error batch updating videos:', error)
    return NextResponse.json(
      { error: videoMessages.failedToUpdateVideosBatch || 'Failed to update videos' },
      { status: 500 }
    )
  }
}
