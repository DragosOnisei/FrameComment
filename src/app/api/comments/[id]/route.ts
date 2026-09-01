import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { armOrgForCommentId } from '@/lib/share-org'
import { rateLimit } from '@/lib/rate-limit'
import { requireApiAdmin, getAuthContext } from '@/lib/auth'
import { cancelCommentNotification } from '@/lib/comment-helpers'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeAndValidateContent } from '@/lib/comment-helpers'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { getPrimaryRecipient } from '@/lib/recipients'
import { safeParseBody, annotationDataSchema } from '@/lib/validation'
import { z } from 'zod'
import { isValidTimecode } from '@/lib/timecode'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
export const runtime = 'nodejs'

// Prevent static generation for this route
export const dynamic = 'force-dynamic'

// Schema for PATCH body. `timecode` / `timecodeEnd` are optional — only
// sent when the user adjusts the range while editing the comment. We
// validate them as proper SMPTE-style timecode strings; null is allowed
// for `timecodeEnd` so the user can shrink a range back to a point.
//
// 6.16.0: an edit can also add attachments and an annotation. The trigger is
// the obvious one — you post the note, then realise you meant to attach the
// reference frame or circle the thing you were describing. Before this, the
// only route was delete-and-repost, which loses the replies (they cascade),
// the resolved state, the reactions and the position in the thread.
//
// So this is an UPDATE, not a delete-and-recreate. Same visible result — the
// comment ends up with everything it should have had — without detonating the
// conversation hanging off it.
const editCommentSchema = z.object({
  /**
   * 7.x: optional, so a comment can be MOVED without resending its text.
   *
   * Dragging a note's bead along the timeline changes when it applies, not what
   * it says. With content required, a move had to echo the whole body back —
   * which is a race against a concurrent edit and, worse, would have stamped the
   * comment as edited for a change nobody made to its words.
   *
   * Omitting it now leaves the text exactly as it was; sending it still
   * overwrites, so every existing caller behaves identically.
   */
  content: z.string().min(1).max(10000).optional(),
  /** Assets uploaded during the edit, to be linked to this comment. */
  assetIds: z.array(z.string()).max(50).optional(),
  /**
   * Drawing captured during the edit. `null` erases the existing annotation
   * (the "actually, remove that scribble" case); omitted leaves it alone.
   */
  annotations: annotationDataSchema.optional().nullable(),
  timecode: z
    .string()
    .refine(isValidTimecode, {
      message: 'Invalid timecode format. Expected HH:MM:SS:FF',
    })
    .optional(),
  timecodeEnd: z
    .string()
    .refine(isValidTimecode, {
      message: 'Invalid end timecode format. Expected HH:MM:SS:FF',
    })
    .nullable()
    .optional(),
  /**
   * 7.x: the millisecond-precise moment, which is what actually positions a
   * marker.
   *
   * `timecode` is frame-quantised, and since 1.0.3 the reader prefers
   * `timestampMs` when a comment carries one, falling back to the timecode only
   * when it does not. So updating the timecode alone would have moved nothing
   * visible on a comment created with precision — the bead would have sprung
   * straight back to the old frame, and the drag would have looked broken while
   * the database had in fact changed.
   */
  timestampMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
})

// DELETE /api/comments/[id]
// Authorization rules (mirrors PATCH):
//   - Admin (any logged-in user) can delete any comment.
//   - A client can delete their own comment if their share-token session id
//     matches the comment's stored editorSessionId.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  // Rate limiting to prevent abuse
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: shareMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.'
  }, 'comments-delete')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params

    // Look up the comment plus the fields we need for authorization.
    // 5.8: RLS — arm the owning org BEFORE this pre-auth lookup (post-flip
    // the un-armed query was blanked by the policies; see lib/share-org.ts).
    await armOrgForCommentId(id)
    const existingComment = await prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        editorSessionId: true,
        project: {
          select: {
            id: true,
            sharePassword: true,
            authMode: true,
          }
        }
      }
    })

    if (!existingComment) {
      return NextResponse.json(
        { error: commentsMessages.commentNotFound || 'Comment not found' },
        { status: 404 }
      )
    }

    // Authorization: admin OR matching share-token session id.
    const authContext = await getAuthContext(request)
    const isAdmin = !!authContext.user

    let authorized = false
    if (isAdmin) {
      authorized = true
    } else if (existingComment.editorSessionId) {
      const accessCheck = await verifyProjectAccess(
        request,
        existingComment.projectId,
        existingComment.project.sharePassword,
        existingComment.project.authMode,
        { allowGuest: false, requiredPermission: 'comment' }
      )
      // Per-browser id (1.0.7+): if the stored sessionId is in the
      // `client:<uuid>` form, match against the request's header
      // instead of the IP-derived one. Falls back to the legacy
      // shareTokenSessionId match for older comments.
      const clientBrowserId = (request.headers.get('x-framecomment-client-id') || '').trim()
      const stored = existingComment.editorSessionId
      const matchesClient =
        clientBrowserId.length > 0 && stored === `client:${clientBrowserId}`
      const matchesShare =
        accessCheck.authorized &&
        accessCheck.shareTokenSessionId === stored
      if (matchesClient || matchesShare) {
        authorized = true
      }
    }

    if (!authorized) {
      return NextResponse.json(
        { error: shareMessages.accessDenied || 'Access denied' },
        { status: 403 }
      )
    }

    // Cancel any pending notifications for this comment
    await cancelCommentNotification(id)

    // Delete the comment and its replies (cascade)
    await prisma.comment.delete({
      where: { id },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: commentsMessages.failedToDeleteComment || 'Failed to delete comment' }, { status: 500 })
  }
}

// PATCH /api/comments/[id] - Edit a comment.
// Authorization rules:
//   - Admin (any logged-in user) can edit any comment.
//   - A client can edit their own comment if their share-token session id
//     matches the comment's stored editorSessionId.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  // Rate limiting
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: shareMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.'
  }, 'comments-edit')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params

    // Parse and validate body
    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const validation = editCommentSchema.safeParse(parsed.data)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error.format() },
        { status: 400 }
      )
    }
    const { content, timecode, timecodeEnd, timestampMs, assetIds, annotations } =
      validation.data

    // Look up the existing comment
    // 5.8: RLS — arm the owning org BEFORE this pre-auth lookup (post-flip
    // the un-armed query was blanked by the policies; see lib/share-org.ts).
    await armOrgForCommentId(id)
    const existingComment = await prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        // 6.16.0: needed to validate attachments added during an edit — an
        // asset may only be linked to a comment on the video it was uploaded
        // against, same rule as POST.
        videoId: true,
        userId: true,
        editorSessionId: true,
        authorName: true,
        project: {
          select: {
            id: true,
            sharePassword: true,
            authMode: true,
            companyName: true,
          }
        }
      }
    })

    if (!existingComment) {
      return NextResponse.json(
        { error: commentsMessages.commentNotFound || 'Comment not found' },
        { status: 404 }
      )
    }

    // Authorization
    const authContext = await getAuthContext(request)
    const isAdmin = !!authContext.user

    let authorized = false
    if (isAdmin) {
      authorized = true
    } else if (existingComment.editorSessionId) {
      // Verify share-token access and check session id match
      const accessCheck = await verifyProjectAccess(
        request,
        existingComment.projectId,
        existingComment.project.sharePassword,
        existingComment.project.authMode,
        { allowGuest: false, requiredPermission: 'comment' }
      )
      const clientBrowserId = (request.headers.get('x-framecomment-client-id') || '').trim()
      const stored = existingComment.editorSessionId
      const matchesClient =
        clientBrowserId.length > 0 && stored === `client:${clientBrowserId}`
      const matchesShare =
        accessCheck.authorized &&
        accessCheck.shareTokenSessionId === stored
      if (matchesClient || matchesShare) {
        authorized = true
      }
    }

    if (!authorized) {
      return NextResponse.json(
        { error: shareMessages.accessDenied || 'Access denied' },
        { status: 403 }
      )
    }

    // Sanitize new content (reuse the same logic as POST). Skipped entirely for
    // a move-only PATCH: there is no text to sanitise, and running the profanity
    // / length checks against `undefined` would reject a request that never
    // claimed to touch the words.
    let sanitizedContent: string | null = null
    if (content !== undefined) {
      const contentValidation = await sanitizeAndValidateContent({
        content,
        authorName: existingComment.authorName,
      })
      if (!contentValidation.valid) {
        return NextResponse.json(
          { error: contentValidation.error },
          { status: contentValidation.errorStatus || 400 }
        )
      }
      sanitizedContent = contentValidation.sanitizedContent!
    }

    // Update — every field is included only when the client passed it, so a
    // move does not clobber the text and a text edit does not clobber the range.
    const updateData: any = {}
    if (sanitizedContent !== null) {
      updateData.content = sanitizedContent
    }
    if (typeof timecode === 'string') {
      updateData.timecode = timecode
    }
    if (timecodeEnd !== undefined) {
      // null clears the end (range → single point); a string sets it.
      updateData.timecodeEnd = timecodeEnd
    }
    if (typeof timestampMs === 'number') {
      updateData.timestampMs = timestampMs
    }
    // 6.16.0: an annotation drawn (or erased) during the edit. `undefined`
    // means the client never touched it, which must not wipe an existing
    // drawing — hence the explicit check rather than a truthiness test.
    if (annotations !== undefined) {
      updateData.annotations = annotations
    }

    // 6.16.0: attachments uploaded during the edit.
    //
    // Validated exactly like POST does, and for the same reason: an asset id
    // arriving from the browser is a claim, not a fact. It must exist, belong
    // to THIS comment's video, be client-uploaded, and not already be attached
    // to another comment. Non-admins additionally may only link assets from
    // their own upload session, so one reviewer cannot staple another's file
    // onto their note.
    if (assetIds && assetIds.length > 0) {
      const uploaderSessionId =
        (request.headers.get('x-framecomment-client-id') || '').trim().length > 0
          ? `client:${(request.headers.get('x-framecomment-client-id') || '').trim()}`
          : existingComment.editorSessionId
      const assets = await prisma.videoAsset.findMany({
        where: {
          id: { in: assetIds },
          videoId: existingComment.videoId,
          uploadedBy: 'client',
          ...(isAdmin ? {} : { uploadedBySessionId: uploaderSessionId ?? undefined }),
          commentId: null,
        },
        select: { id: true },
      })
      if (assets.length !== assetIds.length) {
        return NextResponse.json(
          {
            error:
              commentsMessages.invalidAttachments ||
              'One or more attachments are invalid or no longer available. Please attach the file again.',
          },
          { status: 400 },
        )
      }
      await prisma.videoAsset.updateMany({
        where: { id: { in: assets.map((a) => a.id) } },
        data: { commentId: id },
      })
    }
    const updated = await prisma.comment.update({
      where: { id },
      data: updateData,
      include: {
        user: { select: { id: true, name: true, username: true, email: true, avatarUrl: true } },
        assets: {
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            fileType: true,
            category: true,
            createdAt: true,
          }
        },
        reactions: {
          select: {
            id: true,
            emoji: true,
            authorName: true,
            sessionId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      } as any,
    })

    // Sanitize for response
    const primaryRecipient = await getPrimaryRecipient(existingComment.projectId)
    const fallbackName = existingComment.project.companyName || primaryRecipient?.name || 'Client'
    const sanitized = sanitizeComment(updated as any, isAdmin, isAdmin, fallbackName)

    return NextResponse.json(sanitized)
  } catch (error) {
    return NextResponse.json(
      { error: commentsMessages.operationFailed || 'Operation failed' },
      { status: 500 }
    )
  }
}
