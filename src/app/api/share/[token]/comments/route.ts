import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPrimaryRecipient } from '@/lib/recipients'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment, buildGuestSessionIndex } from '@/lib/comment-sanitization'
import { getRateLimitSettings } from '@/lib/settings'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'
import { verifyVideoShareName } from '@/lib/share-video-sig'

export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

/**
 * GET /api/share/[token]/comments
 *
 * Load comments for a share page (token-based access)
 * Replaces direct project ID access for better security
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const locale = await getConfiguredLocale().catch(() => 'en')
    const messages = await loadLocaleMessages(locale).catch(() => null)
    const shareMessages = messages?.share
    const { ipRateLimit } = await getRateLimitSettings()

    // Rate limiting to prevent scraping
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: ipRateLimit ? Math.max(1, Math.min(ipRateLimit, 1000)) : 30,
      message: shareMessages?.tooManyRequests || 'Too many requests. Please slow down.'
    }, `share-comments:${token}`)

    if (rateLimitResult) return rateLimitResult

    // Fetch project by token (not by ID - more secure)
    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        companyName: true,
        hideFeedback: true,
        guestMode: true,
      }
    })

    if (!project) {
      return NextResponse.json({ error: shareMessages?.accessDenied || 'Access denied' }, { status: 403 })
    }

    // SECURITY: If feedback is hidden, return empty array (don't expose comments)
    if (project.hideFeedback) {
      return NextResponse.json([])
    }

    // Get primary recipient for author name
    const primaryRecipient = await getPrimaryRecipient(project.id)
    // Priority: companyName → primary recipient → 'Client'
    const fallbackName = project.companyName || primaryRecipient?.name || 'Client'

    // Verify project access using bearer admin/share tokens
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse!
    }

    const { isAdmin, isAuthenticated, isGuest } = accessCheck

    // Block guest users from seeing comments (guests only have 'view' permission)
    if (isGuest) {
      return NextResponse.json([])
    }

    const assetSelect = {
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        fileType: true,
        category: true,
        createdAt: true,
      },
    }

    // 1.2.0+: emoji reactions per comment, chronologically ordered.
    const reactionSelect = {
      select: {
        id: true,
        emoji: true,
        authorName: true,
        sessionId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' as const },
    }

    // 1.2.0+: single-video share scope. The signed URL pinned to one
    // video also restricts the comments listing to that video group, so
    // the reviewer doesn't see commentary on siblings they can't open.
    // Same scope rules as the main share GET — applied to every viewer
    // (admin included) when the URL carries valid `v` + `sig` params.
    const singleVideoName = (request.nextUrl.searchParams.get('v') || '').trim()
    const singleVideoSig = (request.nextUrl.searchParams.get('sig') || '').trim()
    const singleVideoScopeActive =
      singleVideoName.length > 0 &&
      singleVideoSig.length > 0 &&
      verifyVideoShareName(token, singleVideoName, singleVideoSig)
    let scopedVideoIds: string[] | null = null
    if (singleVideoScopeActive) {
      const rows = await prisma.video.findMany({
        where: { projectId: project.id, name: singleVideoName },
        select: { id: true },
      })
      scopedVideoIds = rows.map((r) => r.id)
      // Empty scope = no comments returned. Safer to short-circuit
      // than to omit the filter and leak the entire project.
      if (scopedVideoIds.length === 0) {
        return NextResponse.json([])
      }
    }

    // Fetch comments with nested replies
    const comments = await prisma.comment.findMany({
      where: {
        projectId: project.id,
        parentId: null, // Only top-level comments
        ...(scopedVideoIds ? { videoId: { in: scopedVideoIds } } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
          }
        },
        assets: assetSelect,
        reactions: reactionSelect,
        replies: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
                email: true,
              }
            },
            assets: assetSelect,
            reactions: reactionSelect,
          },
          orderBy: { createdAt: 'asc' }
        }
      } as any,
      orderBy: { createdAt: 'asc' }
    })

    // 1.0.7+: build a stable Client 1 / Client 2 / Client N index
    // across the whole listing so multiple guest reviewers don't all
    // collapse into "Client" — handy when a single share link is
    // forwarded around an agency.
    const guestIndex = buildGuestSessionIndex(comments as any[])

    // 1.2.0+: viewer identity for the `mine` flag on reactions.
    const browserId = (request.headers.get('x-framecomment-client-id') || '').trim()
    const viewerSessionId = isAdmin
      ? `admin:${(accessCheck as any).user?.id || ''}`
      : browserId
        ? `client:${browserId}`
        : (accessCheck as any).shareTokenSessionId || null

    // Sanitize comments - never expose PII to non-admins
    const sanitizedComments = comments.map((comment: any) => sanitizeComment(
      comment,
      isAdmin,
      isAuthenticated,
      fallbackName,
      guestIndex,
      viewerSessionId,
    ))

    return NextResponse.json(sanitizedComments)
  } catch (error) {
    logError('Error fetching comments:', error)
    const locale = await getConfiguredLocale().catch(() => 'en')
    const messages = await loadLocaleMessages(locale).catch(() => null)
    return NextResponse.json({ error: messages?.share?.unableToProcessRequest || 'Unable to process request' }, { status: 500 })
  }
}
