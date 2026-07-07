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
import { hardDeleteVideoById, hardDeleteFolderById, hardDeleteProjectById, hardDeleteFolderDocumentById } from '@/lib/trash-cleanup'

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
    // Pull every trashed video + folder + project, then permanently
    // delete each one. Done one at a time so a single storage
    // failure doesn't roll back the rest.
    const [videos, folders, projects, documents] = await Promise.all([
      prisma.video.findMany({
        where: { deletedAt: { not: null } } as any,
        select: { id: true },
      }),
      prisma.folder.findMany({
        where: { deletedAt: { not: null } } as any,
        select: { id: true },
      }),
      prisma.project.findMany({
        where: { deletedAt: { not: null } } as any,
        select: { id: true } as any,
      }),
      (prisma as any).folderDocument.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true },
      }),
    ])

    let removed = 0
    // Process projects first — purging a project also drops its
    // videos/folders by cascade, so we skip duplicate work below.
    const skipVideoIds = new Set<string>()
    const skipFolderIds = new Set<string>()
    for (const p of projects as any[]) {
      try {
        // Track child rows so the later loops don't try to hard-delete
        // something the cascade just removed.
        const childVideos = await prisma.video.findMany({
          where: { projectId: p.id },
          select: { id: true },
        })
        const childFolders = await prisma.folder.findMany({
          where: { projectId: p.id },
          select: { id: true },
        })
        childVideos.forEach((v) => skipVideoIds.add(v.id))
        childFolders.forEach((f) => skipFolderIds.add(f.id))
        await hardDeleteProjectById(p.id)
        removed += 1
      } catch (err) {
        logError('[POST /api/trash/empty] project cleanup failed:', err)
      }
    }
    for (const v of videos) {
      if (skipVideoIds.has(v.id)) continue
      try {
        await hardDeleteVideoById(v.id)
        removed += 1
      } catch (err) {
        logError('[POST /api/trash/empty] video cleanup failed:', err)
      }
    }
    for (const f of folders) {
      if (skipFolderIds.has(f.id)) continue
      try {
        await hardDeleteFolderById(f.id)
        removed += 1
      } catch (err) {
        logError('[POST /api/trash/empty] folder cleanup failed:', err)
      }
    }
    // 3.9.x: documents. hardDeleteFolderDocumentById no-ops if the row was
    // already removed by a project cascade above, so no skip-set needed.
    for (const d of documents as any[]) {
      try {
        await hardDeleteFolderDocumentById(d.id)
        removed += 1
      } catch (err) {
        logError('[POST /api/trash/empty] document cleanup failed:', err)
      }
    }

    return NextResponse.json({ success: true, removed })
  } catch (error) {
    logError('[POST /api/trash/empty] failed:', error)
    return NextResponse.json({ error: 'Failed to empty trash' }, { status: 500 })
  }
}
