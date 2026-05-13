/**
 * GET /api/trash
 *
 * Returns every soft-deleted folder and video across the admin's
 * scope, ordered by `deletedAt` desc so the most recently trashed
 * items sit at the top of the Trash page (1.0.8+).
 *
 * The response carries enough metadata for the Trash UI to render a
 * compact list — name, original parent (folder or "Project root"),
 * project title, thumbnail when available, the deletion timestamp,
 * and a precomputed `expiresAt` so the page can show a "Permanently
 * deletes in X days" badge without doing date math in the browser.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { generateVideoAccessToken } from '@/lib/video-access'
import { TRASH_RETENTION_DAYS } from '@/lib/trash-cleanup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult
  const admin = authResult

  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many requests. Please slow down.',
  }, 'admin-trash-list')
  if (rl) return rl

  try {
    const sessionId = `admin:${admin.id}`

    // Fetch trashed folders + videos in parallel. We only surface
    // items whose `deletedAt` is set; the rest of the listing
    // endpoints stay filtered out, so the Trash page is the single
    // place these rows appear.
    const [trashedFolders, trashedVideos] = await Promise.all([
      prisma.folder.findMany({
        where: { deletedAt: { not: null } } as any,
        orderBy: { deletedAt: 'desc' } as any,
        include: {
          project: { select: { id: true, title: true, slug: true } },
          parentFolder: { select: { id: true, name: true } },
        },
      }),
      prisma.video.findMany({
        where: { deletedAt: { not: null } } as any,
        orderBy: { deletedAt: 'desc' } as any,
        include: {
          project: { select: { id: true, title: true, slug: true } },
          folder: { select: { id: true, name: true } },
        },
      }),
    ])

    // Group videos by `(projectId, name)` so each video group shows
    // as a single Trash entry (matches the grid UX). The latest
    // version drives the thumbnail + metadata.
    type VideoRow = (typeof trashedVideos)[number]
    const groups = new Map<string, VideoRow[]>()
    for (const v of trashedVideos) {
      const key = `${v.projectId}:${v.name}`
      const bucket = groups.get(key) ?? []
      bucket.push(v)
      groups.set(key, bucket)
    }

    const videoItems = await Promise.all(
      Array.from(groups.values()).map(async (rows) => {
        const sorted = [...rows].sort((a, b) => b.version - a.version)
        const latest = sorted[0]
        let thumbnailUrl: string | null = null
        if (latest.thumbnailPath) {
          try {
            const token = await generateVideoAccessToken(
              latest.id,
              latest.projectId,
              'thumbnail',
              request,
              sessionId,
            )
            thumbnailUrl = `/api/content/${token}`
          } catch (err) {
            logError('[GET /api/trash] thumbnail token failed:', err)
          }
        }
        return {
          kind: 'video' as const,
          // The latest version's id drives Restore + Permanent
          // delete; the route handlers fan out to siblings via
          // `name`/`projectId` if needed.
          id: latest.id,
          allIds: sorted.map((v) => v.id),
          name: latest.name,
          versionCount: sorted.length,
          thumbnailUrl,
          duration: latest.duration ?? null,
          projectId: latest.projectId,
          projectTitle: latest.project?.title ?? '—',
          projectSlug: latest.project?.slug ?? null,
          parent: latest.folder
            ? { kind: 'folder', id: latest.folder.id, name: latest.folder.name }
            : { kind: 'root', id: null, name: 'Project root' },
          deletedAt: (latest as any).deletedAt,
          expiresAt: new Date(
            new Date((latest as any).deletedAt).getTime() +
              TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
          ),
        }
      }),
    )

    const folderItems = trashedFolders.map((f) => ({
      kind: 'folder' as const,
      id: f.id,
      name: f.name,
      projectId: f.projectId,
      projectTitle: f.project?.title ?? '—',
      projectSlug: f.project?.slug ?? null,
      parent: f.parentFolder
        ? { kind: 'folder', id: f.parentFolder.id, name: f.parentFolder.name }
        : { kind: 'root', id: null, name: 'Project root' },
      deletedAt: (f as any).deletedAt,
      expiresAt: new Date(
        new Date((f as any).deletedAt).getTime() +
          TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ),
    }))

    const items = [...folderItems, ...videoItems].sort((a, b) => {
      const da = new Date(a.deletedAt).getTime()
      const db = new Date(b.deletedAt).getTime()
      return db - da
    })

    return NextResponse.json({
      items,
      retentionDays: TRASH_RETENTION_DAYS,
    })
  } catch (error) {
    logError('[GET /api/trash] failed:', error)
    return NextResponse.json({ error: 'Failed to load trash' }, { status: 500 })
  }
}
