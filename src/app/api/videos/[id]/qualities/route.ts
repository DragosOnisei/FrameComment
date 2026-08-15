import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { armOrgForVideoId } from '@/lib/share-org'
import { verifyProjectAccess } from '@/lib/project-access'
import { listVideoQualities } from '@/lib/video-qualities'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 6.9.0 — GET /api/videos/[id]/qualities
 *
 * Which resolutions this video can be downloaded at, and how big each one is.
 * Same permission rules as the download itself, so the menu can never offer
 * something the download would then refuse.
 *
 * The original is listed for admins only — clients get the encoded tiers,
 * which is what the project's download permission covers.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: videoId } = await params

    await armOrgForVideoId(videoId)
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: { project: true },
    })
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const accessCheck = await verifyProjectAccess(
      request,
      video.project.id,
      video.project.sharePassword,
      video.project.authMode,
      { allowGuest: false, requiredPermission: 'download' },
    )
    if (!accessCheck.authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (!accessCheck.isAdmin) {
      if (!video.project.allowAssetDownload) {
        return NextResponse.json({ qualities: [], reason: 'downloads-disabled' })
      }
      if (!video.approved) {
        return NextResponse.json({ qualities: [], reason: 'not-approved' })
      }
    }

    const qualities = await listVideoQualities(videoId, {
      includeOriginal: accessCheck.isAdmin,
    })

    return NextResponse.json({ qualities }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    logError('[GET /api/videos/[id]/qualities] failed:', error)
    return NextResponse.json({ error: 'Failed to list qualities' }, { status: 500 })
  }
}
