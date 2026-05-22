/**
 * GET /api/trash/count
 *
 * Lightweight companion to `GET /api/trash` (1.2.1+). Returns the
 * total number of items currently in the Trash so the admin
 * header can render a small badge next to the Trash icon without
 * having to fetch the full listing (which pulls thumbnails,
 * generates per-video signed tokens, etc.).
 *
 * The count mirrors what the Trash page displays:
 *   - one entry per trashed folder
 *   - one entry per trashed project
 *   - one entry per UNIQUE `(projectId, name)` group of trashed
 *     videos (matches the Frame.io-style versioning grouping)
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  // Polling-friendly limit — the header refetches periodically and
  // on focus, so allow a generous burst.
  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 240,
    message: 'Too many requests. Please slow down.',
  }, 'admin-trash-count')
  if (rl) return rl

  try {
    const [folderCount, projectCount, trashedVideos] = await Promise.all([
      prisma.folder.count({ where: { deletedAt: { not: null } } as any }),
      prisma.project.count({ where: { deletedAt: { not: null } } as any }),
      prisma.video.findMany({
        where: { deletedAt: { not: null } } as any,
        select: { projectId: true, name: true },
      }),
    ])

    // Collapse versions of the same video into a single trash entry.
    const videoGroupKeys = new Set<string>()
    for (const v of trashedVideos) {
      videoGroupKeys.add(`${v.projectId}:${v.name}`)
    }

    const count = folderCount + projectCount + videoGroupKeys.size
    return NextResponse.json({ count })
  } catch (error) {
    logError('[GET /api/trash/count] failed:', error)
    // Soft-fail with 0 so a transient DB hiccup never breaks the
    // header. The admin will still see the real count on the next
    // refetch.
    return NextResponse.json({ count: 0 })
  }
}
