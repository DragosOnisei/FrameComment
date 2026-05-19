import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { getAuthContext } from '@/lib/auth'
import { verifyProjectAccess } from '@/lib/project-access'
import { safeParseBody } from '@/lib/validation'
import { z } from 'zod'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 1.2.0: bulk-rename every comment authored by the current guest
// session on a given project. Used by the inline "Name" field in the
// comments sidebar so a reviewer can replace their auto-assigned
// `Client N` label with their real name. Authentication mirrors the
// edit/delete flow:
//   - Admin: always allowed, but rename targets guest comments by
//     `editorSessionId`, so admins use this only for testing/support
//     scenarios.
//   - Guest: must own the rows being renamed — i.e. the comment's
//     `editorSessionId` matches the request's session id (per-browser
//     id when present, otherwise the share-token session id).
const renameBodySchema = z.object({
  projectId: z.string().min(1),
  newName: z
    .string()
    .min(1)
    .max(120)
    .refine((v) => v.trim().length > 0, 'Name is required'),
})

export async function PATCH(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const commentsMessages = messages?.comments || {}
  const shareMessages = messages?.share || {}

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 10,
      message: shareMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.',
    },
    'comments-rename',
  )
  if (rl) return rl

  try {
    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const validation = renameBodySchema.safeParse(parsed.data)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error.format() },
        { status: 400 },
      )
    }
    const projectId = validation.data.projectId
    const newName = validation.data.newName.trim().slice(0, 120)

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, sharePassword: true, authMode: true },
    })
    if (!project) {
      return NextResponse.json(
        { error: shareMessages.accessDenied || 'Access denied' },
        { status: 403 },
      )
    }

    const auth = await getAuthContext(request)
    const isAdmin = !!auth.user

    // Resolve the session id whose comments we'll rename.
    let targetSessionId: string | null = null
    if (isAdmin) {
      // Admins can pass a session id explicitly if they ever need to
      // — for now we keep it simple and just no-op without one.
      const url = new URL(request.url)
      targetSessionId = (url.searchParams.get('sessionId') || '').trim() || null
    } else {
      const accessCheck = await verifyProjectAccess(
        request,
        project.id,
        project.sharePassword,
        project.authMode,
        { allowGuest: false, requiredPermission: 'comment' },
      )
      if (!accessCheck.authorized) {
        return NextResponse.json(
          { error: shareMessages.accessDenied || 'Access denied' },
          { status: 403 },
        )
      }
      // Prefer the per-browser id (1.0.7+) so two devices on the same
      // share link rename independently.
      const browserId = (request.headers.get('x-framecomment-client-id') || '').trim()
      targetSessionId = browserId
        ? `client:${browserId}`
        : accessCheck.shareTokenSessionId || null
    }

    if (!targetSessionId) {
      return NextResponse.json(
        { error: commentsMessages.operationFailed || 'No session to rename' },
        { status: 400 },
      )
    }

    // Bulk update every comment for this project with the matching
    // editorSessionId. Admin-authored / internal rows are skipped via
    // the editorSessionId filter (admin comments store userId, not
    // editorSessionId).
    const result = await prisma.comment.updateMany({
      where: {
        projectId,
        editorSessionId: targetSessionId,
      },
      data: { authorName: newName },
    })

    return NextResponse.json({ updated: result.count, name: newName })
  } catch (error) {
    return NextResponse.json(
      { error: commentsMessages.operationFailed || 'Operation failed' },
      { status: 500 },
    )
  }
}
