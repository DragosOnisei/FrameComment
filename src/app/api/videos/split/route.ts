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
        name: true,
        originalFileName: true,
      },
    })

    // Track each `(projectId, originalGroupName)` so we can renumber
    // the leftovers once we're done. Keys carry the projectId first
    // so we never collide across projects.
    const donorGroups = new Set<string>()
    for (const v of videos) {
      donorGroups.add(`${v.projectId}::${v.name}`)
    }

    for (const v of videos) {
      const base =
        stripExtension(v.originalFileName) || `Video ${v.id.slice(0, 6)}`
      // Unique suffix loop. We exclude the row we're about to rename
      // so a single split that happens to match its own filename
      // doesn't loop forever.
      let candidate = base
      let suffix = 2
      // Don't bother probing if the candidate matches the row's
      // CURRENT group name — that means the original filename and
      // the group name already agree, and renaming to itself is a
      // no-op (we still want a unique name, so we'd hit the loop and
      // bump to "(2)").
      // Probe up to 200 attempts so we don't spin endlessly on bad
      // data.
      for (let i = 0; i < 200; i++) {
        const clash = await prisma.video.findFirst({
          where: {
            projectId: v.projectId,
            name: candidate,
            id: { not: v.id },
          },
          select: { id: true },
        })
        if (!clash) break
        candidate = `${base} (${suffix})`
        suffix += 1
      }

      await prisma.video.update({
        where: { id: v.id },
        data: {
          name: candidate,
          version: 1,
          versionLabel: 'v1',
        },
      })
    }

    // Renumber the donor groups so their remaining rows go v1..vN.
    for (const key of donorGroups) {
      const sep = key.indexOf('::')
      if (sep < 0) continue
      const projectId = key.slice(0, sep)
      const originalName = key.slice(sep + 2)
      const remaining = await prisma.video.findMany({
        where: { projectId, name: originalName },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      for (let i = 0; i < remaining.length; i++) {
        await prisma.video.update({
          where: { id: remaining[i].id },
          data: {
            version: i + 1,
            versionLabel: `v${i + 1}`,
          },
        })
      }
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
