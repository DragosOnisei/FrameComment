import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { requireApiAdmin, getAuthContext } from '@/lib/auth'
import { cancelCommentNotification } from '@/lib/comment-helpers'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeAndValidateContent } from '@/lib/comment-helpers'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { getPrimaryRecipient } from '@/lib/recipients'
import { safeParseBody } from '@/lib/validation'
import { z } from 'zod'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
export const runtime = 'nodejs'

// Prevent static generation for this route
export const dynamic = 'force-dynamic'

// Schema for PATCH body
const editCommentSchema = z.object({
  content: z.string().min(1).max(10000),
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
      if (
        accessCheck.authorized &&
        accessCheck.shareTokenSessionId === existingComment.editorSessionId
      ) {
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
    const { content } = validation.data

    // Look up the existing comment
    const existingComment = await prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
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
      if (
        accessCheck.authorized &&
        accessCheck.shareTokenSessionId === existingComment.editorSessionId
      ) {
        authorized = true
      }
    }

    if (!authorized) {
      return NextResponse.json(
        { error: shareMessages.accessDenied || 'Access denied' },
        { status: 403 }
      )
    }

    // Sanitize new content (reuse the same logic as POST)
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

    // Update
    const updated = await prisma.comment.update({
      where: { id },
      data: { content: contentValidation.sanitizedContent! },
      include: {
        user: { select: { id: true, name: true, username: true, email: true } },
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
      }
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
