/**
 * POST /api/trash/{kind}/{id}/restore
 *
 * Lift a soft-deleted item out of Trash (1.0.8+). For a folder we
 * unset `deletedAt` on the whole subtree (the original cascade is
 * reversed). For a video we unset it across every version in the
 * group so the card reappears intact.
 *
 * If a video's original parent folder is itself still in Trash, we
 * re-parent the video to the project root so the user actually sees
 * it on the grid after restore. Same for a folder whose parent was
 * trashed in a separate operation.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { renumberVersionGroup } from '@/lib/video-versions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'admin-trash-restore')
  if (rl) return rl

  const { kind, id } = await params

  try {
    if (kind === 'folder') {
      const folder = await prisma.folder.findUnique({
        where: { id },
        select: {
          id: true,
          parentFolderId: true,
          parentFolder: { select: { id: true, deletedAt: true } } as any,
        } as any,
      })
      if (!folder) {
        return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
      }

      // Walk descendants (the same way DELETE did) so we restore the
      // whole subtree at once.
      const descendantIds = new Set<string>([id])
      let frontier: string[] = [id]
      while (frontier.length > 0) {
        const children = await prisma.folder.findMany({
          where: { parentFolderId: { in: frontier } },
          select: { id: true },
        })
        frontier = []
        for (const c of children) {
          if (!descendantIds.has(c.id)) {
            descendantIds.add(c.id)
            frontier.push(c.id)
          }
        }
      }

      // If the original parent is also still in Trash, re-parent
      // this folder to the project root — otherwise the user
      // wouldn't see it anywhere until they restore the parent too.
      const parentStillTrashed =
        (folder as any).parentFolder &&
        (folder as any).parentFolder.deletedAt !== null
      await prisma.$transaction([
        prisma.folder.updateMany({
          where: { id: { in: Array.from(descendantIds) } },
          data: { deletedAt: null } as any,
        }),
        prisma.video.updateMany({
          where: { folderId: { in: Array.from(descendantIds) } },
          data: { deletedAt: null } as any,
        }),
        ...(parentStillTrashed
          ? [
              prisma.folder.update({
                where: { id },
                data: { parentFolderId: null },
              }),
            ]
          : []),
      ])
      return NextResponse.json({ success: true })
    }

    if (kind === 'project') {
      // 1.2.0+: bring a soft-deleted project back. The project row
      // alone is enough; videos / folders / comments were never
      // touched on delete (we just stamped `deletedAt` on the
      // project). Active share links resume working once the
      // listing endpoint stops filtering it out.
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, deletedAt: true } as any,
      })
      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
      await prisma.project.update({
        where: { id },
        data: { deletedAt: null } as any,
      })
      return NextResponse.json({ success: true })
    }

    if (kind === 'video') {
      const video = (await prisma.video.findUnique({
        where: { id },
        include: { folder: true },
      })) as any
      if (!video) {
        return NextResponse.json({ error: 'Video not found' }, { status: 404 })
      }
      // Restore the whole version group, not just this row.
      const folderStillTrashed =
        video.folder && video.folder.deletedAt !== null
      const projectId = video.projectId as string
      const name = video.name as string
      const targetFolderId = folderStillTrashed
        ? null
        : ((video.folderId as string | null) ?? null)

      // 5.13.0: collision-safe restore. If a LIVE video with this name
      // already exists at the destination (same project + folder), the
      // restored group would silently merge into that stack (two "v1"s).
      // Instead it comes back as "name (2)" / "name (3)" … — the exact
      // convention uploads use for duplicate filenames.
      let restoredName = name
      {
        const folderFilter =
          targetFolderId === null
            ? { folderId: null }
            : { folderId: targetFolderId }
        const conflicts = await prisma.video.findMany({
          where: {
            projectId,
            ...folderFilter,
            deletedAt: null,
            OR: [{ name }, { name: { startsWith: `${name} (` } }],
          } as any,
          select: { name: true },
        })
        if (conflicts.some((v: any) => v.name === name)) {
          let n = 2
          const taken = new Set(conflicts.map((v: any) => v.name))
          while (taken.has(`${name} (${n})`)) n++
          restoredName = `${name} (${n})`
        }
      }

      await prisma.$transaction([
        prisma.video.updateMany({
          // 5.13.0: ONLY trashed rows — now that a restore can rename, the
          // live same-named stack must never be touched by this update.
          where: { projectId, name, deletedAt: { not: null } } as any,
          data: {
            deletedAt: null,
            ...(restoredName !== name ? { name: restoredName } : {}),
            // Re-parent to the project root when the original
            // folder is also gone.
            ...(folderStillTrashed ? { folderId: null } : {}),
          } as any,
        }),
      ])

      // 6.0.4: the restored rows keep the version numbers they had when they
      // were trashed, which can collide with (or leave gaps against) whatever
      // the live stack looks like now. Renumber the resulting group 1..N so a
      // stack never shows two identical version badges. Best-effort — the
      // restore itself already succeeded.
      try {
        await renumberVersionGroup({
          projectId,
          folderId: targetFolderId,
          name: restoredName,
        })
      } catch (renumberErr) {
        logError('[restore] version renumber failed:', renumberErr)
      }

      return NextResponse.json({ success: true, restoredName })
    }

    if (kind === 'document') {
      // 3.9.x: restore a trashed folder document (transcript PDF).
      const doc = (await (prisma as any).folderDocument.findUnique({
        where: { id },
        select: {
          id: true,
          folderId: true,
          folder: { select: { id: true, deletedAt: true } },
        },
      })) as any
      if (!doc) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 })
      }
      // If the original folder is still trashed, drop the document to the
      // project root so it's actually visible after restore.
      const folderStillTrashed = doc.folder && doc.folder.deletedAt !== null
      await (prisma as any).folderDocument.update({
        where: { id },
        data: {
          deletedAt: null,
          ...(folderStillTrashed ? { folderId: null } : {}),
        },
      })
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Unknown kind' }, { status: 400 })
  } catch (error) {
    logError('[POST /api/trash/.../restore] failed:', error)
    return NextResponse.json({ error: 'Failed to restore' }, { status: 500 })
  }
}
