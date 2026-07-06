import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { validateRequest, createCommentSchema, safeParseBody } from '@/lib/validation'
import { getPrimaryRecipient } from '@/lib/recipients'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment, buildGuestSessionIndex } from '@/lib/comment-sanitization'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import {

  validateCommentPermissions,
  resolveCommentAuthor,
  sanitizeAndValidateContent,
  handleCommentNotifications,
  fetchProjectComments

} from '@/lib/comment-helpers'
export const runtime = 'nodejs'


// Prevent static generation for this route
export const dynamic = 'force-dynamic'

/**
 * GET /api/comments?projectId=xxx
 * Fetch all comments for a project
 */
export async function GET(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  // Rate limiting: 60 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: shareMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.'
  }, 'comments-read')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId') ?? ''

    // Fetch the project to check password protection
    const project = await prisma.project.findUnique({
      where: { id: projectId },
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
      return NextResponse.json(
        { error: shareMessages.accessDenied || 'Access denied' },
        { status: 403 }
      )
    }

    // SECURITY: If feedback is hidden, return empty array (don't expose comments)
    if (project.hideFeedback) {
      return NextResponse.json([])
    }

    // Verify project access using dual auth pattern
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode)

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse!
    }

    const { isAdmin, isAuthenticated, isGuest } = accessCheck

    // Block guest users from seeing comments (guests only have 'view' permission)
    if (isGuest) {
      return NextResponse.json([])
    }

    // Get primary recipient for author name fallback
    const primaryRecipient = await getPrimaryRecipient(projectId)
    // Priority: companyName → primary recipient → 'Client'
    const fallbackName = project.companyName || primaryRecipient?.name || 'Client'

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

    // 1.2.0+: include emoji reactions on every comment + reply.
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

    // Fetch all comments for the project
    const allComments = await prisma.comment.findMany({
      where: {
        projectId,
        parentId: null, // Only get top-level comments
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

    // 1.0.7+: number anonymous guest reviewers as Client 1 / 2 / N
    // so two incognito viewers don't collapse into a single "Client".
    const getGuestIndex = buildGuestSessionIndex(allComments as any[])

    // 1.2.0+: identity for the `mine` flag on reactions. Prefer the
    // per-browser id when present (matches reactions POST behaviour).
    const browserId = (request.headers.get('x-framecomment-client-id') || '').trim()
    const viewerSessionId = isAdmin
      ? `admin:${(accessCheck as any).user?.id || ''}`
      : browserId
        ? `client:${browserId}`
        : (accessCheck as any).shareTokenSessionId || null

    // Sanitize the response data
    const sanitizedComments = allComments.map((comment: any) =>
      sanitizeComment(
        comment,
        isAdmin,
        isAuthenticated,
        fallbackName,
        getGuestIndex,
        viewerSessionId,
      )
    )

    return NextResponse.json(sanitizedComments)
  } catch (error) {
    console.error('[/api/comments] failed:', error)
    return NextResponse.json({ error: commentsMessages.operationFailed || 'Operation failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  // Rate limiting to prevent comment spam
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: commentsMessages.tooManyComments || 'Too many comments. Please slow down.'
  }, 'comments-create')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    // Get authentication context first (before body parsing)
    const authContext = await getAuthContext(request)

    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const body = parsed.data

    // Note: Don't log body - may contain PII (emails)

    // Validate and sanitize input
    const validation = validateRequest(createCommentSchema, body)
    if (!validation.success) {
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400 }
      )
    }

    const {
      projectId,
      videoId,
      videoVersion,
      timecode,
      timecodeEnd,
      timestampMs,
      content,
      authorName,
      authorEmail,
      recipientId,
      parentId,
      isInternal,
      isCopied,
      assetIds,
      annotations,
    } = validation.data

    // Enforce configurable max comment attachments
    if (assetIds && assetIds.length > 0) {
      const globalSettings = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { maxCommentAttachments: true },
      })
      const maxAttachments = globalSettings?.maxCommentAttachments ?? 10
      if (assetIds.length > maxAttachments) {
        return NextResponse.json(
          { error: (commentsMessages.tooManyAttachments || 'Too many attachments. Maximum allowed: {maxAttachments}').replace('{maxAttachments}', String(maxAttachments)) },
          { status: 400 }
        )
      }
    }

    // Validate comment permissions
    const permissionCheck = await validateCommentPermissions({
      projectId,
      isInternal: isInternal || false,
      currentUser: authContext.user
    })

    if (!permissionCheck.valid) {
      return NextResponse.json(
        { error: permissionCheck.error },
        { status: permissionCheck.errorStatus || 403 }
      )
    }

    // Get project for access verification
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
      }
    })

    if (!project) {
      return NextResponse.json(
        { error: shareMessages.accessDenied || 'Access denied' },
        { status: 403 }
      )
    }

    // Verify project access using dual auth pattern
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode, {
      allowGuest: false,
      requiredPermission: 'comment',
    })

    if (!accessCheck.authorized) {
      return accessCheck.errorResponse || NextResponse.json(
        { error: shareMessages.unableToProcessRequest || 'Unable to process request' },
        { status: 400 }
      )
    }

    const uploaderSessionId = accessCheck.shareTokenSessionId
    if (!uploaderSessionId) {
      return NextResponse.json(
        { error: shareMessages.unableToProcessRequest || 'Unable to process request' },
        { status: 400 }
      )
    }

    // Per-browser id sent by the share player (1.0.7+). When present
    // and the visitor is anonymous, we treat it as the authoritative
    // session id so two incognito windows on the same IP get
    // distinct `editorSessionId` rows — fixes both "Client 1 vs
    // Client 2" labelling and the edit/delete authorization match.
    const clientBrowserId = (request.headers.get('x-framecomment-client-id') || '').trim()
    const effectiveSessionId =
      !authContext.user && clientBrowserId.length > 0
        ? `client:${clientBrowserId}`
        : uploaderSessionId

    const { isAdmin, isAuthenticated } = accessCheck

    // Resolve author information
    const { authorEmail: finalAuthorEmail, fallbackName } = await resolveCommentAuthor({
      projectId,
      authorEmail,
      recipientId
    })

    // Sanitize and validate content
    const contentValidation = await sanitizeAndValidateContent({
      content,
      authorName
    })

    if (!contentValidation.valid) {
      return NextResponse.json(
        { error: contentValidation.error },
        { status: contentValidation.errorStatus || 400 }
      )
    }

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, projectId: true, version: true }
    })

    if (!video || video.projectId !== projectId) {
      return NextResponse.json(
        { error: commentsMessages.videoDoesNotBelongToProject || 'Video does not belong to this project' },
        { status: 400 }
      )
    }

    // Keep API behavior: if version is omitted, infer from current video record.
    const finalVideoVersion = videoVersion || video.version

    // Create comment in database
    const comment = await prisma.comment.create({
      data: {
        projectId,
        videoId,
        videoVersion: finalVideoVersion || null,
        timecode,
        timecodeEnd: timecodeEnd || null,
        timestampMs: typeof timestampMs === 'number' ? timestampMs : null,
        content: contentValidation.sanitizedContent!,
        authorName: contentValidation.sanitizedAuthorName,
        authorEmail: finalAuthorEmail,
        isInternal: isInternal || false,
        parentId: parentId || null,
        userId: authContext.user?.id || null,
        annotations: annotations || undefined,
        // Track the share-token session id of the author so they can
        // edit their own comment from the same browser session later.
        // Admin-authored comments rely on userId for edit authorization.
        editorSessionId: authContext.user ? null : effectiveSessionId,
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
        replies: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
                email: true,
              }
            }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    })

    // 3.8.x: mark pasted comments as "copied" via a best-effort raw UPDATE.
    // Doing it as a separate raw statement (instead of in the create above)
    // keeps NORMAL comment creation bulletproof: it never depends on the
    // generated Prisma client knowing the `isCopied` column, so a stale
    // client / not-yet-run migration can't break posting comments.
    if (isCopied && comment?.id) {
      try {
        await prisma.$executeRawUnsafe(
          'UPDATE "Comment" SET "isCopied" = true WHERE id = $1',
          comment.id,
        )
        ;(comment as any).isCopied = true
      } catch {
        /* column absent on older DBs — non-fatal; comment is still created */
      }
    }

    // Link client assets to comment
    if (assetIds && assetIds.length > 0) {
      // Validate each asset exists, belongs to correct video, is client-uploaded, and unlinked
      const assets = await prisma.videoAsset.findMany({
        where: {
          id: { in: assetIds },
          videoId,
          uploadedBy: 'client',
          uploadedBySessionId: uploaderSessionId,
          commentId: null,
        },
      })

      if (assets.length !== assetIds.length) {
        return NextResponse.json(
          { error: commentsMessages.invalidAttachments || 'One or more attachments are invalid or no longer available. Please attach the file again.' },
          { status: 400 }
        )
      }

      await prisma.videoAsset.updateMany({
        where: { id: { in: assets.map(a => a.id) } },
        data: { commentId: comment.id },
      })
    }

    // Collect attachment file names for notifications
    let attachmentNames: string[] | undefined
    if (assetIds && assetIds.length > 0) {
      const linkedAssets = await prisma.videoAsset.findMany({
        where: { commentId: comment.id },
        select: { fileName: true },
      })
      attachmentNames = linkedAssets.map(a => a.fileName)
    }

    // Handle notifications asynchronously
    await handleCommentNotifications({
      comment,
      projectId,
      videoId,
      parentId,
      attachmentNames,
    })

    // Fetch all comments for the project (to keep UI in sync)
    const allComments = await fetchProjectComments(projectId)

    // 1.0.7+: same Client 1 / 2 / N numbering as the GET endpoint —
    // without this the response from POST would drop the index and
    // the UI flashes back to plain "Client" after every new post.
    const postGuestIndex = buildGuestSessionIndex(allComments as any[])

    // Sanitize the response data
    const sanitizedComments = allComments.map((comment: any) =>
      sanitizeComment(
        comment,
        isAdmin,
        isAuthenticated,
        fallbackName,
        postGuestIndex,
      )
    )

    return NextResponse.json(sanitizedComments)
  } catch (error) {
    console.error('[/api/comments] failed:', error)
    return NextResponse.json({ error: commentsMessages.operationFailed || 'Operation failed' }, { status: 500 })
  }
}
