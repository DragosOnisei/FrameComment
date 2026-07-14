import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { getRateLimitSettings } from '@/lib/settings'
import { logError } from '@/lib/logging'
import { verifyVideoShareName } from '@/lib/share-video-sig'
import { getAuthContext } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.1.0+: GET /api/share/[token]/markers
 *
 * Token-based marker listing for the share page. Mirrors the share
 * comments GET: resolves the project by slug, gates via
 * `verifyProjectAccess`, honours the single-video (`v` + `sig`) scope,
 * and blocks guests / hidden-feedback projects.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params
    const { ipRateLimit } = await getRateLimitSettings()
    const rl = await rateLimit(
      request,
      {
        windowMs: 60 * 1000,
        maxRequests: ipRateLimit ? Math.max(1, Math.min(ipRateLimit, 1000)) : 30,
        message: 'Too many requests. Please slow down.',
      },
      `share-markers:${token}`,
    )
    if (rl) return rl

    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: { id: true, sharePassword: true, authMode: true, hideFeedback: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    if (project.hideFeedback) return NextResponse.json([])

    const accessCheck = await verifyProjectAccess(
      request,
      project.id,
      project.sharePassword,
      project.authMode,
    )
    if (!accessCheck.authorized) return accessCheck.errorResponse!
    if (accessCheck.isGuest) return NextResponse.json([])

    // Single-video share scope (same signed v+sig rule as comments).
    const singleVideoName = (request.nextUrl.searchParams.get('v') || '').trim()
    const singleVideoSig = (request.nextUrl.searchParams.get('sig') || '').trim()
    const scopeActive =
      singleVideoName.length > 0 &&
      singleVideoSig.length > 0 &&
      verifyVideoShareName(token, singleVideoName, singleVideoSig)
    let scopedVideoIds: string[] | null = null
    if (scopeActive) {
      const rows = await prisma.video.findMany({
        where: { projectId: project.id, name: singleVideoName },
        select: { id: true },
      })
      scopedVideoIds = rows.map((r) => r.id)
      if (scopedVideoIds.length === 0) return NextResponse.json([])
    }

    const authContext = await getAuthContext(request)
    const browserId = (request.headers.get('x-framecomment-client-id') || '').trim()
    const viewerSessionId = accessCheck.isAdmin
      ? `admin:${authContext.user?.id || ''}`
      : browserId
        ? `client:${browserId}`
        : (accessCheck as any).shareTokenSessionId || null

    const markers = await (prisma as any).marker.findMany({
      where: {
        projectId: project.id,
        ...(scopedVideoIds ? { videoId: { in: scopedVideoIds } } : {}),
      },
      orderBy: { timestampMs: 'asc' },
    })

    const shaped = markers.map((m: any) => ({
      id: m.id,
      videoId: m.videoId,
      videoVersion: m.videoVersion ?? null,
      timestampMs: m.timestampMs,
      color: m.color,
      label: m.label ?? null,
      authorName: m.authorName ?? null,
      isInternal: m.isInternal,
      createdAt: m.createdAt,
      mine:
        !!accessCheck.isAdmin ||
        (!!m.editorSessionId && m.editorSessionId === viewerSessionId),
    }))

    return NextResponse.json(shaped)
  } catch (error) {
    logError('Error fetching share markers:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
