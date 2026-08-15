import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { armOrgForProjectSlug } from '@/lib/share-org'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { getRedis } from '@/lib/redis'
import { getClientIpAddress } from '@/lib/utils'
import crypto from 'crypto'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * Generate a temporary download token for downloading every ready video as ZIP.
 * Used by share page "Download All" button.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const shareMessages = messages?.share || {}

  const { token: slug } = await params
  // 5.5 multi-tenant: arm the owning org FIRST (privileged slug->org resolve;
  // post-flip every query below, incl. settings/rate-limit reads, is RLS-scoped).
  await armOrgForProjectSlug(slug)

  // Rate limit
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 5,
    message: shareMessages.tooManyRequestsGeneric || 'Too many download requests. Please slow down.',
  }, `download-all-token:${slug}`)
  if (rateLimitResult) return rateLimitResult

  try {
    // Find project by slug
    const project = await prisma.project.findUnique({
      where: { slug },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        allowAssetDownload: true,
        title: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: shareMessages.projectNotFound || 'Project not found' }, { status: 404 })
    }

    // Verify access (must have download permission, no guests)
    const accessCheck = await verifyProjectAccess(
      request,
      project.id,
      project.sharePassword,
      project.authMode,
      {
        allowGuest: false,
        requiredPermission: 'download',
      }
    )

    if (!accessCheck.authorized) {
      return NextResponse.json({ error: shareMessages.accessDenied || 'Access denied' }, { status: 403 })
    }

    // Non-admins need allowAssetDownload enabled
    if (!accessCheck.isAdmin && !project.allowAssetDownload) {
      return NextResponse.json(
        { error: shareMessages.downloadsDisabled || 'Downloads are disabled for this project' },
        { status: 403 }
      )
    }

    // 6.11.0: every ready clip, latest version per name — approval is gone.
    const downloadableVideos = await prisma.video.findMany({
      where: {
        projectId: project.id,
        status: { in: ['READY', 'PROCESSING'] },
      },
      select: {
        id: true,
        name: true,
        versionLabel: true,
        originalFileName: true,
        originalStoragePath: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    if (downloadableVideos.length === 0) {
      return NextResponse.json(
        { error: shareMessages.noVideosToDownload || 'No videos available for download' },
        { status: 404 }
      )
    }

    // Generate secure token
    const downloadToken = crypto.randomBytes(32).toString('base64url')

    const redis = getRedis()
    const sessionId = accessCheck.shareTokenSessionId || (accessCheck.isAdmin ? `admin:${Date.now()}` : `guest:${Date.now()}`)
    const ipAddress = getClientIpAddress(request)
    const userAgentHash = crypto
      .createHash('sha256')
      .update(request.headers.get('user-agent') || 'unknown')
      .digest('hex')

    const tokenData = {
      projectId: project.id,
      projectTitle: project.title,
      videoIds: downloadableVideos.map((v) => v.id),
      sessionId,
      ipAddress,
      userAgentHash,
      createdAt: Date.now(),
      isAdmin: accessCheck.isAdmin || false,
    }

    await redis.setex(
      `bulk_download:${downloadToken}`,
      15 * 60, // 15 minutes
      JSON.stringify(tokenData)
    )

    return NextResponse.json({
      url: `/api/content/bulk-zip/${downloadToken}`,
      videoCount: downloadableVideos.length,
    })
  } catch (error) {
    logError('Bulk download token generation error:', error)
    return NextResponse.json(
      { error: shareMessages.downloadFailed || 'Failed to generate download link' },
      { status: 500 }
    )
  }
}
