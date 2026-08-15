import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { armOrgForVideoId } from '@/lib/share-org'
import { verifyProjectAccess } from '@/lib/project-access'
import { generateVideoAccessToken } from '@/lib/video-access'
import { EXACT_DOWNLOAD_TIERS, exactPreviewPath } from '@/lib/video-qualities'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'


/**
 * Generate a temporary download token for video downloads (admins and share users)
 * This allows using window.open() without loading files into browser memory
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const videoMessages = messages?.videos || {}

  try {
    const { id: videoId } = await params

    // Get video with project info
    // 5.8: RLS — arm the owning org BEFORE this pre-auth lookup (post-flip
    // the un-armed query was blanked by the policies; see lib/share-org.ts).
    await armOrgForVideoId(videoId)
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: { project: true },
    })

    if (!video) {
      return NextResponse.json({ error: videoMessages.videoNotFoundApi || 'Video not found' }, { status: 404 })
    }

    // Verify user has access to this project
    const accessCheck = await verifyProjectAccess(
      request,
      video.project.id,
      video.project.sharePassword,
      video.project.authMode,
      {
        allowGuest: false,
        requiredPermission: 'download',
      }
    )

    if (!accessCheck.authorized) {
      return NextResponse.json({ error: videoMessages.unauthorizedApi || 'Unauthorized' }, { status: 403 })
    }

    // Check download permissions for non-admins
    if (!accessCheck.isAdmin) {
      if (!video.project.allowAssetDownload) {
        return NextResponse.json(
          { error: videoMessages.downloadsDisabledForProject || 'Downloads are disabled for this project' },
          { status: 403 }
        )
      }

    }

    // 6.9.0: an explicit resolution may be requested. Anything else — including
    // no body at all — keeps the old behaviour and downloads the source, so
    // every existing caller is unaffected.
    let requestedQuality = 'original'
    try {
      const body = await request.json().catch(() => null)
      const q = typeof body?.quality === 'string' ? body.quality : null
      if (q && EXACT_DOWNLOAD_TIERS.includes(q)) {
        // Verify the tier actually exists before minting a token for it, so a
        // stale menu can't produce a link that 404s at the last moment.
        if (exactPreviewPath(video, q)) requestedQuality = q
      }
    } catch {
      // No body / malformed body → original.
    }

    // Generate video access token; tag admin sessions to avoid analytics inflation
    const sessionId = accessCheck.shareTokenSessionId || (accessCheck.isAdmin ? `admin:${Date.now()}` : `guest:${Date.now()}`)
    const token = await generateVideoAccessToken(
      videoId,
      video.project.id,
      requestedQuality,
      request,
      sessionId
    )

    // Return download URL (uses /api/content endpoint with download flag)
    return NextResponse.json({
      url: `/api/content/${token}?download=true`,
    })
  } catch (error) {
    logError('Download token generation error:', error)
    return NextResponse.json(
      { error: videoMessages.failedToGenerateDownloadLink || 'Failed to generate download link' },
      { status: 500 }
    )
  }
}
