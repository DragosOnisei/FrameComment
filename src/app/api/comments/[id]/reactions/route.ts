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

// 1.2.0: Emoji reactions on comments.
//
// Single endpoint for both add and remove with a `toggle: true` shape —
// keeps the client-side picker simple: tap an emoji to add it; tap it
// again to remove. Authorization mirrors `resolve`: admins always, and
// any viewer with `comment` permission can drop reactions.
const reactionBodySchema = z.object({
  emoji: z
    .string()
    .min(1)
    .max(16)
    .refine((v) => v.trim().length > 0, 'Emoji is required'),
  toggle: z.boolean().optional().default(true),
  authorName: z.string().max(120).optional(),
})

function getViewerSessionId(
  request: NextRequest,
  isAdmin: boolean,
  adminUserId: string | null,
  shareTokenSessionId: string | null,
): string | null {
  // Per-browser id (1.0.7+): prefer the explicit header so two devices
  // sharing one share-token still get distinct identities.
  const browserId = (request.headers.get('x-framecomment-client-id') || '').trim()
  if (isAdmin && adminUserId) return `admin:${adminUserId}`
  if (browserId.length > 0) return `client:${browserId}`
  if (shareTokenSessionId) return shareTokenSessionId
  return null
}

async function authorizeAndIdentify(request: NextRequest, commentId: string) {
  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      projectId: true,
      project: {
        select: { id: true, sharePassword: true, authMode: true, companyName: true },
      },
    },
  })
  if (!existing) return { ok: false as const, status: 404, error: 'Comment not found' }

  const auth = await getAuthContext(request)
  const isAdmin = !!auth.user
  let sessionId: string | null = null
  if (isAdmin) {
    sessionId = getViewerSessionId(request, true, auth.user?.id ?? null, null)
  } else {
    const accessCheck = await verifyProjectAccess(
      request,
      existing.projectId,
      existing.project.sharePassword,
      existing.project.authMode,
      { allowGuest: false, requiredPermission: 'comment' },
    )
    if (!accessCheck.authorized) {
      return { ok: false as const, status: 403, error: 'Access denied' }
    }
    sessionId = getViewerSessionId(
      request,
      false,
      null,
      accessCheck.shareTokenSessionId ?? null,
    )
  }

  if (!sessionId) {
    return { ok: false as const, status: 403, error: 'Access denied' }
  }

  return { ok: true as const, existing, isAdmin, sessionId }
}

async function loadAndReturn(commentId: string, isAdmin: boolean, viewerSessionId: string) {
  const updated = await prisma.comment.findUnique({
    where: { id: commentId },
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
      project: { select: { companyName: true } },
    } as any,
  })
  if (!updated) {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }
  const primaryRecipient = await getPrimaryRecipient(updated.projectId)
  const fallbackName =
    (updated as any).project?.companyName || primaryRecipient?.name || 'Client'
  const sanitized = sanitizeComment(
    updated as any,
    isAdmin,
    isAdmin,
    fallbackName,
    undefined,
    viewerSessionId,
  )
  return NextResponse.json(sanitized)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: shareMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.',
    },
    'comments-reactions',
  )
  if (rl) return rl

  try {
    const { id } = await params
    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const validation = reactionBodySchema.safeParse(parsed.data)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error.format() },
        { status: 400 },
      )
    }
    const { emoji, toggle, authorName } = validation.data
    const emojiTrim = emoji.trim()

    const authz = await authorizeAndIdentify(request, id)
    if (!authz.ok) {
      const msg =
        authz.status === 404
          ? commentsMessages.commentNotFound || authz.error
          : shareMessages.accessDenied || authz.error
      return NextResponse.json({ error: msg }, { status: authz.status })
    }
    const { isAdmin, sessionId } = authz

    const existingReaction = await (prisma as any).commentReaction.findUnique({
      where: {
        commentId_sessionId_emoji: {
          commentId: id,
          sessionId,
          emoji: emojiTrim,
        },
      },
    })

    if (existingReaction) {
      if (toggle) {
        await (prisma as any).commentReaction.delete({ where: { id: existingReaction.id } })
      }
    } else {
      await (prisma as any).commentReaction.create({
        data: {
          commentId: id,
          sessionId,
          emoji: emojiTrim,
          authorName: authorName?.trim() || (isAdmin ? 'Admin' : null),
        },
      })
    }

    return loadAndReturn(id, isAdmin, sessionId)
  } catch (error) {
    return NextResponse.json(
      { error: commentsMessages.operationFailed || 'Operation failed' },
      { status: 500 },
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: shareMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.',
    },
    'comments-reactions-del',
  )
  if (rl) return rl

  try {
    const { id } = await params
    const url = new URL(request.url)
    const emoji = (url.searchParams.get('emoji') || '').trim()
    if (!emoji) {
      return NextResponse.json({ error: 'emoji query param required' }, { status: 400 })
    }

    const authz = await authorizeAndIdentify(request, id)
    if (!authz.ok) {
      const msg =
        authz.status === 404
          ? commentsMessages.commentNotFound || authz.error
          : shareMessages.accessDenied || authz.error
      return NextResponse.json({ error: msg }, { status: authz.status })
    }
    const { isAdmin, sessionId } = authz

    await (prisma as any).commentReaction
      .delete({
        where: {
          commentId_sessionId_emoji: {
            commentId: id,
            sessionId,
            emoji,
          },
        },
      })
      .catch(() => {
        // Not found is fine — the user's reaction is already gone.
      })

    return loadAndReturn(id, isAdmin, sessionId)
  } catch (error) {
    return NextResponse.json(
      { error: commentsMessages.operationFailed || 'Operation failed' },
      { status: 500 },
    )
  }
}
