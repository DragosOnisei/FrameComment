/**
 * POST /api/videos/split
 *
 * Extracts the given version rows out of their current group so each
 * becomes a standalone video card (1.0.8+). Used as an undo for
 * accidental drag-to-stack — pick the wrongly-stacked versions and
 * lift them back out.
 *
 * Body: `{ videoIds: string[] }`
 *
 * For each row we:
 *   - Recompute a unique group `name` from its `originalFileName`
 *     (extension stripped). Collisions in the same project get the
 *     usual " (2)", " (3)" suffix.
 *   - Reset `version = 1` + `versionLabel = "v1"` since the extracted
 *     row now stands alone.
 *
 * After all the extracts, every donor group is renumbered so its
 * remaining versions go `v1..vN` contiguously, in `createdAt` order.
 *
 * Admin-only. The Trash and the public share flows are unaffected.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function stripExtension(name: string | null | undefined): string {
  if (!name) return ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.',
    },
    'admin-videos-split',
  )
  if (rl) return rl

  try {
    const body = await request.json()
    const videoIds: string[] = Array.isArray(body?.videoIds)
      ? body.videoIds.filter((x: unknown) => typeof x === 'string')
      : []
    if (videoIds.length === 0) {
      return NextResponse.json(
        { error: 'videoIds is required' },
        { status: 400 },
      )
    }
    // Hard upper bound to keep the loop honest.
    if (videoIds.length > 100) {
      return NextResponse.json(
        { error: 'Too many ids' },
        { status: 400 },
      )
    }

    const videos = await prisma.video.findMany({
      where: { id: { in: videoIds } },
      select: {
        id: true,
        projectId: true,
        folderId: true,
        name: true,
        originalFileName: true,
      },
    })

    const selectedIds = new Set(videos.map((v) => v.id))

    // Per-folder filter helper — stacks live inside ONE folder, so all
    // lookups must be scoped to the same (projectId, folderId).
    const folderWhere = (folderId: string | null) =>
      folderId === null ? { folderId: null } : { folderId }

    // Find a name that's free within (projectId, folderId), ignoring
    // the rows in `excludeIds` (the ones we're about to rename anyway).
    const uniqueName = async (
      base: string,
      projectId: string,
      folderId: string | null,
      excludeIds: Set<string>,
    ): Promise<string> => {
      const b = base || 'Video'
      let candidate = b
      let suffix = 2
      for (let i = 0; i < 200; i++) {
        const clash = await prisma.video.findFirst({
          where: {
            projectId,
            ...folderWhere(folderId),
            name: candidate,
            id: { notIn: Array.from(excludeIds) },
          },
          select: { id: true },
        })
        if (!clash) break
        candidate = `${b} (${suffix})`
        suffix += 1
      }
      return candidate
    }

    // Unique donor groups (project + folder + current stack name).
    const groupMap = new Map<
      string,
      { projectId: string; folderId: string | null; name: string }
    >()
    for (const v of videos) {
      const k = `${v.projectId}::${v.folderId ?? ''}::${v.name}`
      if (!groupMap.has(k)) {
        groupMap.set(k, {
          projectId: v.projectId,
          folderId: v.folderId ?? null,
          name: v.name,
        })
      }
    }

    // STEP 1 — rename the REMAINING rows of each donor group FIRST.
    //
    // When videos are stacked, EVERY row (including the base) is renamed
    // to the stack's name (the top version drives it). So after lifting
    // some versions out, the leftover base would otherwise keep that
    // stack name (e.g. "…_V4") instead of reverting to its own. We give
    // the remaining stack the LATEST remaining version's original
    // filename — and doing this first frees the old stack name so the
    // extracted rows below can reclaim their own (…_V4 etc.) cleanly.
    for (const grp of groupMap.values()) {
      const rows = await prisma.video.findMany({
        where: {
          projectId: grp.projectId,
          ...folderWhere(grp.folderId),
          name: grp.name,
        },
        orderBy: { version: 'asc' },
        select: { id: true, originalFileName: true },
      })
      const remaining = rows.filter((r) => !selectedIds.has(r.id))
      if (remaining.length === 0) continue
      const latest = remaining[remaining.length - 1] // highest version
      const remainingIds = new Set(remaining.map((r) => r.id))
      // Exclude both the remaining rows and the about-to-be-extracted
      // ones (which still bear the old stack name) from the clash probe.
      const exclude = new Set<string>([...remainingIds, ...selectedIds])
      const newName = await uniqueName(
        stripExtension(latest.originalFileName),
        grp.projectId,
        grp.folderId,
        exclude,
      )
      for (let i = 0; i < remaining.length; i++) {
        await prisma.video.update({
          where: { id: remaining[i].id },
          data: { name: newName, version: i + 1, versionLabel: `v${i + 1}` },
        })
      }
    }

    // STEP 2 — extract each selected row into its own standalone video,
    // named after ITS original filename, reset to v1. `pending` holds
    // the rows not yet renamed (still carrying the old stack name); we
    // exclude them from the clash probe so a row can reclaim its own
    // name (…_V4) without colliding with siblings that haven't been
    // processed yet. Already-renamed rows stay in the probe so two
    // uploads sharing a filename still get distinct " (2)" names.
    const pending = new Set(selectedIds)
    for (const v of videos) {
      const base =
        stripExtension(v.originalFileName) || `Video ${v.id.slice(0, 6)}`
      const newName = await uniqueName(
        base,
        v.projectId,
        v.folderId ?? null,
        pending,
      )
      await prisma.video.update({
        where: { id: v.id },
        data: { name: newName, version: 1, versionLabel: 'v1' },
      })
      pending.delete(v.id)
    }

    return NextResponse.json({ success: true, split: videos.length })
  } catch (error) {
    logError('[POST /api/videos/split] failed:', error)
    return NextResponse.json(
      { error: 'Failed to split versions' },
      { status: 500 },
    )
  }
}
