import { NextRequest, NextResponse } from 'next/server'
import { prisma, orgSettingsWhere, rawArmed } from '@/lib/db'
import { armOrgForProjectId } from '@/lib/share-org'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { validateRequest, createCommentSchema, safeParseBody } from '@/lib/validation'
import { getPrimaryRecipient } from '@/lib/recipients'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment, buildGuestSessionIndex } from '@/lib/comment-sanitization'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { maybeNotifyEditorForComment, notifyCommentReply } from '@/lib/inapp-notifications'
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
    // 5.8: RLS — arm the owning org BEFORE this pre-auth lookup (post-flip
    // the un-armed query was blanked by the policies; see lib/share-org.ts).
    await armOrgForProjectId(projectId)
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
      sourceVideoId,
      sourceVersionLabel,
      assetIds,
      annotations,
    } = validation.data

    // Enforce configurable max comment attachments
    if (assetIds && assetIds.length > 0) {
      const globalSettings = await prisma.settings.findUnique({
        where: orgSettingsWhere(),
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
    // 5.8: RLS — arm the owning org BEFORE this pre-auth lookup (post-flip
    // the un-armed query was blanked by the policies; see lib/share-org.ts).
    await armOrgForProjectId(projectId)
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
    //
    // 6.16.0 carries the provenance in the same statement, for the same
    // reason and with the same guarantee: if the columns are not there yet,
    // the comment is still created and simply loses its version tag.
    //
    // 6.21.0: both statements go through `rawArmed`. A bare raw statement is
    // not seen by the RLS extension (it arms model operations only), so
    // post-flip this UPDATE ran without an org context, matched zero rows
    // under the org_isolation policy and reported success — pasted comments
    // silently lost both the "Copied" flag and the version tag on production
    // while working perfectly on a superuser dev database.
    if (isCopied && comment?.id) {
      try {
        await rawArmed(prisma.$executeRawUnsafe(
          'UPDATE "Comment" SET "isCopied" = true, "sourceVideoId" = $2, "sourceVersionLabel" = $3 WHERE id = $1',
          comment.id,
          sourceVideoId ?? null,
          sourceVersionLabel ?? null,
        ))
        ;(comment as any).isCopied = true
        ;(comment as any).sourceVideoId = sourceVideoId ?? null
        ;(comment as any).sourceVersionLabel = sourceVersionLabel ?? null
      } catch {
        // Columns absent on an older DB — non-fatal. Fall back to the 3.8.x
        // behaviour so a pre-migration instance still gets the "Copied" tag.
        try {
          await rawArmed(prisma.$executeRawUnsafe(
            'UPDATE "Comment" SET "isCopied" = true WHERE id = $1',
            comment.id,
          ))
          ;(comment as any).isCopied = true
        } catch {
          /* nothing left to try; the comment itself is safe */
        }
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
          // Clients may only link assets from their own session; admins
          // (who own the project) can link any unlinked asset on the video.
          ...(isAdmin ? {} : { uploadedBySessionId: uploaderSessionId }),
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

    // 4.3.x: auto "send to editor" bell — replaces the manual button. Fires on
    // the FIRST comment of a review round only (dedup lives in the helper), so a
    // reviewer leaving 100 comments produces one bell ping, not 100.
    //
    // NB: we intentionally DO NOT filter on `isInternal`. In this app
    // `isInternal` is set to `!!isAdminView` — i.e. it just means "authored by
    // an internal user (admin/editor) in the review view", NOT "private note".
    // Those reviewers absolutely should notify the video's uploader (that's the
    // exact case the old "Send to editor" button covered). Notifying yourself is
    // already prevented inside the helper (actor === uploader is skipped).
    if (videoId) {
      await maybeNotifyEditorForComment({
        videoId,
        actorUserId: authContext.user?.id ?? null,
        actorName:
          contentValidation.sanitizedAuthorName ?? authContext.user?.name ?? null,
      })
    }

    // 6.9.0: a reply pings the person it answers, every time.
    // The helper above fires once per version and targets the uploader + the
    // Project Managers — it is about the video having feedback. This is about
    // a specific person being answered, which is a different event and should
    // not be swallowed by the once-per-version rule.
    if (parentId) {
      await notifyCommentReply({
        parentCommentId: parentId,
        replyCommentId: comment.id,
        actorUserId: authContext.user?.id ?? null,
        actorName:
          contentValidation.sanitizedAuthorName ?? authContext.user?.name ?? null,
      })
    }

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

    // 6.16.0: the id of the row we just created, in a header.
    //
    // The body stays what every existing caller expects — the whole project's
    // comments, so the UI can re-render without a second round-trip. But
    // pasting a thread needs the parent's id to hang its replies off, and
    // digging it out of that array by matching content + timestamp would be a
    // guess. A header adds the one fact the body cannot express without
    // changing its shape.
    return NextResponse.json(sanitizedComments, {
      headers: { 'X-Comment-Id': comment.id },
    })
  } catch (error) {
    console.error('[/api/comments] failed:', error)
    return NextResponse.json({ error: commentsMessages.operationFailed || 'Operation failed' }, { status: 500 })
  }
}
