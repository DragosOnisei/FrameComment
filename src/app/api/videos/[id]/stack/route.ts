import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { stackVideoIntoGroup } from '@/lib/video-versions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/videos/[id]/stack — Frame.io-style versioning (1.0.6+).
 *
 * Reparent the SOURCE video (and the rest of its version group) into the
 * TARGET video's group. After the call:
 *
 *   - Every row in the resulting stack is renamed to the SOURCE's name
 *     (newest delivery drives the card title)
 *   - The stack is renumbered 1..N with the source rows appended last, so
 *     the newest upload is always the highest version
 *
 * 6.0.4: the version arithmetic moved into `stackVideoIntoGroup` and is now
 * a full renumber instead of `max + 1`. The old code returned early when the
 * source already carried the group's name, which left a freshly uploaded row
 * at v1 — the "4th version shows up as V1" bug. Renumbering is idempotent
 * and repairs groups that were already damaged.
 *
 *   Body: { targetVideoId: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many video stack requests. Please slow down.',
    },
    'video-stack',
  )
  if (rl) return rl

  const { id: sourceId } = await params

  try {
    const body = await request.json().catch(() => ({}))
    const targetId = typeof body?.targetVideoId === 'string' ? body.targetVideoId : null
    if (!targetId) {
      return NextResponse.json(
        { error: 'targetVideoId is required' },
        { status: 400 },
      )
    }

    const result = await stackVideoIntoGroup(sourceId, targetId)

    if (typeof result === 'string') {
      switch (result) {
        case 'SOURCE_NOT_FOUND':
        case 'TARGET_NOT_FOUND':
          return NextResponse.json({ error: 'Video not found' }, { status: 404 })
        case 'SAME_VIDEO':
          return NextResponse.json(
            { error: 'Cannot stack a video onto itself' },
            { status: 400 },
          )
        case 'DIFFERENT_PROJECT':
          return NextResponse.json(
            { error: 'Videos belong to different projects' },
            { status: 400 },
          )
        case 'DIFFERENT_FOLDER':
          return NextResponse.json(
            { error: 'Videos must be in the same folder to be stacked' },
            { status: 400 },
          )
        default:
          return NextResponse.json({ error: 'Failed to stack videos' }, { status: 400 })
      }
    }

    return NextResponse.json({
      ok: true,
      movedCount: result.movedCount,
      newName: result.newName,
      versions: result.order,
    })
  } catch (error) {
    logError('[POST /api/videos/[id]/stack] failed:', error)
    return NextResponse.json(
      { error: 'Failed to stack videos' },
      { status: 500 },
    )
  }
}
