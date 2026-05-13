/**
 * POST /api/trash/empty
 *
 * Permanently delete every soft-deleted item right now (1.0.8+).
 * Used by the "Empty Trash" button on the Trash page. Routes through
 * the same DELETE handlers with `?permanent=1` so the underlying
 * storage files get cleaned up alongside the DB rows.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { hardDeleteVideoById, hardDeleteFolderById } from '@/lib/trash-cleanup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 6,
    message: 'Too many requests. Please slow down.',
  }, 'admin-trash-empty')
  if (rl) return rl

  try {
    // Pull every trashed video + folder, then permanently delete
    // each one. Done one at a time so a single storage failure
    // doesn't roll back the rest.
    const [videos, folders] = await Promise.all([
      prisma.video.findMany({
        where: { deletedAt: { not: null } } as any,
        select: { id: true },
      }),
      prisma.folder.findMany({
        where: { deletedAt: { not: null } } as any,
        select: { id: true },
      }),
    ])

    let removed = 0
    for (const v of videos) {
      try {
        await hardDeleteVideoById(v.id)
        removed += 1
      } catch (err) {
        logError('[POST /api/trash/empty] video cleanup failed:', err)
      }
    }
    for (const f of folders) {
      try {
        await hardDeleteFolderById(f.id)
        removed += 1
      } catch (err) {
        logError('[POST /api/trash/empty] folder cleanup failed:', err)
      }
    }

    return NextResponse.json({ success: true, removed })
  } catch (error) {
    logError('[POST /api/trash/empty] failed:', error)
    return NextResponse.json({ error: 'Failed to empty trash' }, { status: 500 })
  }
}
