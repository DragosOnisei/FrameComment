import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 3.5.x POST /api/videos/stack-batch
 *
 * Multi-source version of `/api/videos/[id]/stack`. Stacks SEVERAL
 * selected videos onto one TARGET video in a single atomic operation,
 * ordering them intelligently by the `_V<n>` suffix editors put at the
 * end of the filename.
 *
 * Example the feature is built around: target is `..._V1` and the user
 * drag-drops `..._V2`, `..._V3`, `..._V4` onto it. Result: one stack
 * whose versions are v1 (the old target) → v2 → v3 → v4, with the
 * `_V4` clip on top. The stack's name becomes the TOP clip's name
 * ("latest drives the name", same convention as the single-stack
 * endpoint).
 *
 *   Body: { targetVideoId: string, sourceVideoIds: string[] }
 *         (sourceVideoIds are the cards' representative ids, in the
 *          grid order the client sees them)
 *
 * Ordering of the appended versions:
 *   1. Sources WITH a trailing `_V<number>` → sorted by that number
 *      ascending (V2, V3, V4, …).
 *   2. Sources WITHOUT a suffix → kept in the order the client sent
 *      them (i.e. the grid/selection order), appended after.
 *   The LAST source in that order ends up as the top version and gives
 *   the whole stack its name.
 *
 * Same guards as the single endpoint: same project + same folder, and
 * a source already sharing the target's name is skipped (no-op).
 */

/** Parse a trailing `_V<number>` (case-insensitive) from a video name. */
function parseVersionSuffix(name: string): number | null {
  const m = name.match(/_v(\d+)\s*$/i)
  return m ? parseInt(m[1], 10) : null
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many video stack requests. Please slow down.',
    },
    'video-stack-batch',
  )
  if (rl) return rl

  try {
    const body = await request.json().catch(() => ({}))
    const targetId =
      typeof body?.targetVideoId === 'string' ? body.targetVideoId : null
    const sourceIds: string[] = Array.isArray(body?.sourceVideoIds)
      ? body.sourceVideoIds.filter((x: unknown) => typeof x === 'string')
      : []

    if (!targetId) {
      return NextResponse.json(
        { error: 'targetVideoId is required' },
        { status: 400 },
      )
    }
    if (sourceIds.length === 0) {
      return NextResponse.json(
        { error: 'sourceVideoIds is required' },
        { status: 400 },
      )
    }

    const target = await prisma.video.findUnique({
      where: { id: targetId },
      select: { id: true, projectId: true, folderId: true, name: true },
    })
    if (!target) {
      return NextResponse.json({ error: 'Target video not found' }, { status: 404 })
    }

    const folderFilter =
      target.folderId === null
        ? { folderId: null }
        : { folderId: target.folderId }

    // Resolve each source representative to its group name.
    const sources = await prisma.video.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, projectId: true, folderId: true, name: true },
    })

    for (const s of sources) {
      if (s.projectId !== target.projectId) {
        return NextResponse.json(
          { error: 'All videos must belong to the same project' },
          { status: 400 },
        )
      }
      if ((s.folderId ?? null) !== (target.folderId ?? null)) {
        return NextResponse.json(
          { error: 'All videos must be in the same folder to be stacked' },
          { status: 400 },
        )
      }
    }

    // Unique group names, preserving the client's order of first
    // appearance, excluding the target's own group.
    const idToName = new Map(sources.map((s) => [s.id, s.name]))
    const seen = new Set<string>()
    const orderedNames: string[] = []
    for (const id of sourceIds) {
      const nm = idToName.get(id)
      if (!nm) continue
      if (nm === target.name) continue
      if (seen.has(nm)) continue
      seen.add(nm)
      orderedNames.push(nm)
    }

    if (orderedNames.length === 0) {
      return NextResponse.json({ ok: true, alreadyStacked: true })
    }

    // Order: suffixed (by number asc) first, then non-suffixed in the
    // received order. Stable.
    const ordered = orderedNames
      .map((nm, idx) => ({ nm, idx, suffix: parseVersionSuffix(nm) }))
      .sort((a, b) => {
        const aHas = a.suffix !== null
        const bHas = b.suffix !== null
        if (aHas && bHas) return (a.suffix as number) - (b.suffix as number)
        if (aHas) return -1
        if (bHas) return 1
        return a.idx - b.idx
      })

    // The top (last) source drives the whole stack's name.
    const finalName = ordered[ordered.length - 1].nm

    // Snapshot the target group; it keeps its v1..N numbers.
    const targetGroup = await prisma.video.findMany({
      where: { projectId: target.projectId, name: target.name, ...folderFilter },
      orderBy: { version: 'asc' },
      select: { id: true, version: true },
    })
    let counter =
      targetGroup.length > 0
        ? targetGroup[targetGroup.length - 1].version
        : 0

    const updates: ReturnType<typeof prisma.video.update>[] = []

    // Rename the target rows to the final name (versions unchanged).
    for (const v of targetGroup) {
      updates.push(
        prisma.video.update({ where: { id: v.id }, data: { name: finalName } }),
      )
    }

    // Append each source group, continuing the version counter, in the
    // computed order.
    for (const { nm } of ordered) {
      const grp = await prisma.video.findMany({
        where: { projectId: target.projectId, name: nm, ...folderFilter },
        orderBy: { version: 'asc' },
        select: { id: true },
      })
      for (const v of grp) {
        counter += 1
        const newVersion = counter
        updates.push(
          prisma.video.update({
            where: { id: v.id },
            data: {
              name: finalName,
              version: newVersion,
              versionLabel: `v${newVersion}`,
            },
          }),
        )
      }
    }

    await prisma.$transaction(updates)

    return NextResponse.json({
      ok: true,
      stackedGroups: ordered.length,
      finalName,
      topVersion: counter,
    })
  } catch (error) {
    logError('[POST /api/videos/stack-batch] failed:', error)
    return NextResponse.json(
      { error: 'Failed to stack videos' },
      { status: 500 },
    )
  }
}
