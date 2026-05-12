import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/videos/[id]/stack — Frame.io-style versioning (1.0.6+).
 *
 * Reparent the SOURCE video (and the rest of its version group) into
 * the TARGET video's group. After the call:
 *
 *   - Every Video row in the source group is renamed to `target.name`
 *   - Their `version` numbers are shifted to start at `target.maxVersion + 1`
 *   - `versionLabel` is regenerated as "vN" to match
 *
 * The whole operation runs in a transaction so a partial failure
 * doesn't leave the table in a mixed state.
 *
 *   Body: { targetVideoId: string }
 *
 * Validation:
 *   - Source and target must exist
 *   - Same project, same folder (a video can't jump folders by stacking)
 *   - Source !== target (can't stack onto self)
 *   - Source is NOT already a version of target (no-op)
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

    if (sourceId === targetId) {
      return NextResponse.json(
        { error: 'Cannot stack a video onto itself' },
        { status: 400 },
      )
    }

    const [source, target] = await Promise.all([
      prisma.video.findUnique({
        where: { id: sourceId },
        select: {
          id: true,
          projectId: true,
          folderId: true,
          name: true,
          version: true,
        },
      }),
      prisma.video.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          projectId: true,
          folderId: true,
          name: true,
          version: true,
        },
      }),
    ])

    if (!source || !target) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }
    if (source.projectId !== target.projectId) {
      return NextResponse.json(
        { error: 'Videos belong to different projects' },
        { status: 400 },
      )
    }
    if ((source.folderId ?? null) !== (target.folderId ?? null)) {
      return NextResponse.json(
        { error: 'Videos must be in the same folder to be stacked' },
        { status: 400 },
      )
    }
    if (source.name === target.name) {
      // Already in the same group — nothing to do.
      return NextResponse.json({ ok: true, alreadyStacked: true })
    }

    // Snapshot the two groups so we can re-version them atomically.
    const folderFilter =
      target.folderId === null
        ? { folderId: null }
        : { folderId: target.folderId }

    const [targetGroup, sourceGroup] = await Promise.all([
      prisma.video.findMany({
        where: { projectId: target.projectId, name: target.name, ...folderFilter },
        orderBy: { version: 'asc' },
        select: { id: true, version: true },
      }),
      prisma.video.findMany({
        where: { projectId: source.projectId, name: source.name, ...folderFilter },
        orderBy: { version: 'asc' },
        select: { id: true, version: true },
      }),
    ])

    const targetMaxVersion =
      targetGroup.length > 0 ? targetGroup[targetGroup.length - 1].version : 0

    // Frame.io convention: the freshly-added video drives the
    // displayed name of the whole stack. So when "Episode 2" is
    // dragged onto "Episode 1", the whole group becomes "Episode 2"
    // — Episode 2 is what you see on the card now.
    const newName = source.name

    // Step 1: rename the existing target rows (keep their version
    // numbers intact — they stay as v1..N).
    const targetUpdates = targetGroup.map((v) =>
      prisma.video.update({
        where: { id: v.id },
        data: { name: newName },
      }),
    )

    // Step 2: append the source rows after the target — they take
    // versions targetMax+1, +2, … (their name already equals newName
    // since `newName === source.name`, but we set it explicitly to
    // keep the SQL self-consistent if anything else changes later).
    const sourceUpdates = sourceGroup.map((v, i) => {
      const newVersion = targetMaxVersion + i + 1
      return prisma.video.update({
        where: { id: v.id },
        data: {
          name: newName,
          version: newVersion,
          versionLabel: `v${newVersion}`,
        },
      })
    })

    await prisma.$transaction([...targetUpdates, ...sourceUpdates])

    return NextResponse.json({
      ok: true,
      movedCount: sourceGroup.length,
      newName,
      newVersionRange: [
        targetMaxVersion + 1,
        targetMaxVersion + sourceGroup.length,
      ],
    })
  } catch (error) {
    logError('[POST /api/videos/[id]/stack] failed:', error)
    return NextResponse.json(
      { error: 'Failed to stack videos' },
      { status: 500 },
    )
  }
}
