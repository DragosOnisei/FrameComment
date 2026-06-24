import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import {
  createOrBumpNotification,
  publishNotification,
} from '@/lib/inapp-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 3.5.0+ POST /api/videos/[id]/notify-editor
 *
 * "Send to editor" — a reviewer (admin in the review view OR a client
 * on the share page) signals that they've left feedback on this video
 * and the editor should take a look. We create / bump one in-app
 * notification for the video's uploader (`createdById`) and publish it
 * so their bell updates live over SSE.
 *
 * Dual auth, mirroring the comments route:
 *   - Admins are always allowed.
 *   - Share-token clients are allowed if the token grants access to
 *     this video's project.
 *
 * Soft outcomes (HTTP 200 with `delivered:false`) instead of errors so
 * the UI can show a gentle toast rather than a failure:
 *   - `reason:'no_editor'` — the video has no uploader on record
 *     (legacy upload / deleted user). Per product decision we skip.
 *   - `reason:'self'`      — the uploader is the one clicking; don't
 *     notify yourself.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Light rate limit — this is a button a human taps, not a loop.
  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many requests. Please slow down.',
    },
    'notify-editor',
  )
  if (rl) return rl

  try {
    const { id } = await params

    const video = await prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        projectId: true,
        folderId: true,
        createdById: true,
        deletedAt: true,
      },
    })
    if (!video || video.deletedAt) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    // Dual auth: admin OR a share token scoped to this project.
    const { user, isAdmin, shareContext } = await getAuthContext(request)
    const shareAuthorized =
      !!shareContext && shareContext.projectId === video.projectId
    if (!isAdmin && !shareAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // No uploader on record → nothing to notify. Soft skip.
    if (!video.createdById) {
      return NextResponse.json({ delivered: false, reason: 'no_editor' })
    }

    // Don't notify yourself when an admin reviews their own upload.
    if (isAdmin && user?.id === video.createdById) {
      return NextResponse.json({ delivered: false, reason: 'self' })
    }

    // Resolve the actor's display name for the bell row. Body is
    // optional; admins fall back to their account name.
    let actorName: string | null = null
    try {
      const body = await request.json().catch(() => null)
      if (body && typeof body.actorName === 'string') {
        actorName = body.actorName.trim().slice(0, 120) || null
      }
    } catch {
      /* no body — fine */
    }
    if (!actorName && isAdmin) actorName = user?.name ?? null

    const notification = await createOrBumpNotification({
      recipientId: video.createdById,
      projectId: video.projectId,
      videoId: video.id,
      videoName: video.name,
      folderId: video.folderId,
      actorName,
    })

    await publishNotification(video.createdById, notification)

    return NextResponse.json({ delivered: true })
  } catch (error) {
    logError('[POST /api/videos/[id]/notify-editor] failed:', error)
    return NextResponse.json(
      { error: 'Failed to notify editor' },
      { status: 500 },
    )
  }
}
