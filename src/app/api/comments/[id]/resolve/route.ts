import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { getAuthContext } from '@/lib/auth'
import { verifyProjectAccess } from '@/lib/project-access'
import { sanitizeComment } from '@/lib/comment-sanitization'
import { getPrimaryRecipient } from '@/lib/recipients'
import { safeParseBody } from '@/lib/validation'
import { z } from 'zod'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 1.2.0: Frame.io-style "Mark as done" toggle.
//
// Authorization is broader than edit/delete because reviewers commonly
// resolve each other's comments as a workflow step. Anyone with the
// `comment` permission on the project's share link (i.e. they can post
// comments) can flip the resolved bit; admins can always do it. This
// mirrors Frame.io where any collaborator can mark a note complete.
const resolveBodySchema = z.object({
  isResolved: z.boolean(),
  resolvedBy: z.string().max(120).optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: shareMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.',
    },
    'comments-resolve',
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params

    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const validation = resolveBodySchema.safeParse(parsed.data)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error.format() },
        { status: 400 },
      )
    }
    const { isResolved, resolvedBy } = validation.data

    const existing = await prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        project: {
          select: { id: true, sharePassword: true, authMode: true, companyName: true },
        },
      },
    })

    if (!existing) {
      return NextResponse.json(
        { error: commentsMessages.commentNotFound || 'Comment not found' },
        { status: 404 },
      )
    }

    // Authorization: admin OR any viewer with `comment` permission on the
    // owning project's share link.
    const auth = await getAuthContext(request)
    const isAdmin = !!auth.user
    let authorized = isAdmin
    if (!authorized) {
      const accessCheck = await verifyProjectAccess(
        request,
        existing.projectId,
        existing.project.sharePassword,
        existing.project.authMode,
        { allowGuest: false, requiredPermission: 'comment' },
      )
      authorized = !!accessCheck.authorized
    }

    if (!authorized) {
      return NextResponse.json(
        { error: shareMessages.accessDenied || 'Access denied' },
        { status: 403 },
      )
    }

    const updated = await prisma.comment.update({
      where: { id },
      data: {
        isResolved,
        resolvedAt: isResolved ? new Date() : null,
        resolvedBy: isResolved ? (resolvedBy?.trim() || (isAdmin ? 'Admin' : 'Client')) : null,
      } as any,
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
          },
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

    const primaryRecipient = await getPrimaryRecipient(existing.projectId)
    const fallbackName =
      (existing.project as any).companyName || primaryRecipient?.name || 'Client'
    const sanitized = sanitizeComment(updated as any, isAdmin, isAdmin, fallbackName)
    return NextResponse.json(sanitized)
  } catch (error) {
    return NextResponse.json(
      { error: commentsMessages.operationFailed || 'Operation failed' },
      { status: 500 },
    )
  }
}
