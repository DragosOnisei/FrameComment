import { prisma } from '@/lib/db'
import { logError, logMessage } from '@/lib/logging'
import { canManageUsers } from '@/lib/permissions'
import { projectPurgeAllowed } from '@/lib/danger-zone'
import {
  hardDeleteFolderById,
  hardDeleteFolderDocumentById,
  hardDeleteProjectById,
  hardDeleteVideoById,
} from '@/lib/trash-cleanup'

/**
 * 7.21.0: the Trash is personal.
 *
 * Until 7.21.0 a company had ONE Trash: anything anyone deleted, everyone
 * saw, restored or emptied. Every trashed row now carries `deletedById`
 * (set by the five places that move something to the Trash — the video,
 * folder, project and document DELETE routes), and:
 *
 *   - a person sees what THEY deleted, plus rows with no recorded deleter
 *     (trashed before 7.21.0, or by an account that no longer exists) —
 *     those were everyone's and stay everyone's until they expire;
 *   - Owner and Admin can switch to the whole team's Trash ("All team"),
 *     because an editor who deletes a client's final cut by mistake and
 *     then leaves must not take the only way back with them — Dragos's
 *     call on the recommendation;
 *   - restore and per-item permanent delete check the same rule, so an id
 *     typed into a URL cannot reach someone else's deletion;
 *   - "Empty Trash" empties the caller's own view only;
 *   - deleting a user account purges that user's Trash first
 *     (`purgeUserTrash`), so nothing stays behind with no owner. A PROJECT
 *     still inside its 24-hour anti-mass-wipe window is not purged early —
 *     it is handed back to everyone (deletedById = NULL) and expires on
 *     the normal schedule.
 */

export type TrashScope = 'mine' | 'all'

export interface TrashViewer {
  id: string
  role?: string | null
}

/** Owner and Admin may look at the whole team's Trash. */
export function canSeeAllTrash(viewer: TrashViewer): boolean {
  return canManageUsers(viewer.role)
}

/** The scope actually applied: 'all' only for those allowed to ask for it. */
export function effectiveTrashScope(viewer: TrashViewer, requested: string | null | undefined): TrashScope {
  return requested === 'all' && canSeeAllTrash(viewer) ? 'all' : 'mine'
}

/** The `where` addition for trashed rows of any kind under a scope. */
export function trashOwnerWhere(viewer: TrashViewer, scope: TrashScope): Record<string, unknown> {
  if (scope === 'all') return {}
  return { OR: [{ deletedById: viewer.id }, { deletedById: null }] }
}

/**
 * May this viewer restore or permanently delete this row? A row that is
 * not in the Trash is not a Trash question (upload cancel, hard delete of
 * a live item) and is left to the route's own rules.
 */
export function canTouchTrashedRow(
  viewer: TrashViewer,
  row: { deletedAt?: Date | string | null; deletedById?: string | null } | null | undefined,
): boolean {
  if (!row || !row.deletedAt) return true
  if (!row.deletedById || row.deletedById === viewer.id) return true
  return canSeeAllTrash(viewer)
}

export interface PurgeResult {
  removed: number
  keptProjects: number
}

/**
 * Permanently deletes every trashed video, folder, project and document
 * matching `ownerWhere` (files included, through the same hard-delete
 * helpers the 30-day cleanup uses). Projects inside their 24-hour safety
 * window are skipped and counted. Shared by "Empty Trash" and the
 * user-deletion fail-safe.
 */
export async function purgeTrash(ownerWhere: Record<string, unknown>, label: string): Promise<PurgeResult> {
  const trashed = { deletedAt: { not: null }, ...ownerWhere } as any
  const [videos, folders, projects, documents] = await Promise.all([
    prisma.video.findMany({ where: trashed, select: { id: true } }),
    prisma.folder.findMany({ where: trashed, select: { id: true } }),
    prisma.project.findMany({ where: trashed, select: { id: true, deletedAt: true } as any }),
    prisma.folderDocument.findMany({ where: trashed, select: { id: true } }),
  ])

  let removed = 0
  const purgeable = (projects as any[]).filter((p) => projectPurgeAllowed(p.deletedAt))
  const keptProjects = projects.length - purgeable.length
  if (keptProjects > 0) {
    logMessage(`[trash ${label}] ${keptProjects} project(s) kept — still inside the 24h safety window`)
  }

  // A purged project takes its folders and videos with it; do not try to
  // delete them a second time.
  const skipVideoIds = new Set<string>()
  const skipFolderIds = new Set<string>()
  for (const p of purgeable) {
    try {
      const [childVideos, childFolders] = await Promise.all([
        prisma.video.findMany({ where: { projectId: p.id }, select: { id: true } }),
        prisma.folder.findMany({ where: { projectId: p.id }, select: { id: true } }),
      ])
      childVideos.forEach((v) => skipVideoIds.add(v.id))
      childFolders.forEach((f) => skipFolderIds.add(f.id))
      await hardDeleteProjectById(p.id)
      removed += 1
    } catch (err) {
      logError(`[trash ${label}] project cleanup failed:`, err)
    }
  }
  for (const v of videos) {
    if (skipVideoIds.has(v.id)) continue
    try {
      await hardDeleteVideoById(v.id)
      removed += 1
    } catch (err) {
      logError(`[trash ${label}] video cleanup failed:`, err)
    }
  }
  for (const f of folders) {
    if (skipFolderIds.has(f.id)) continue
    try {
      await hardDeleteFolderById(f.id)
      removed += 1
    } catch (err) {
      logError(`[trash ${label}] folder cleanup failed:`, err)
    }
  }
  for (const d of documents) {
    try {
      await hardDeleteFolderDocumentById(d.id)
      removed += 1
    } catch (err) {
      logError(`[trash ${label}] document cleanup failed:`, err)
    }
  }
  return { removed, keptProjects }
}

/**
 * The fail-safe Dragos asked for: before a user account is deleted, its
 * Trash goes too — nothing stays behind redundant, with nobody to see it.
 * Whatever could not be purged (a project inside its safety window, a
 * failed file delete) is handed back to everyone (deletedById = NULL), so
 * it is never invisible and still expires on the normal schedule.
 */
export async function purgeUserTrash(userId: string): Promise<PurgeResult> {
  const result = await purgeTrash({ deletedById: userId }, `user ${userId}`)
  const handBack = { where: { deletedById: userId }, data: { deletedById: null } } as any
  await Promise.all([
    prisma.video.updateMany(handBack),
    prisma.folder.updateMany(handBack),
    prisma.project.updateMany(handBack),
    prisma.folderDocument.updateMany(handBack),
  ])
  logMessage(
    `[trash] user ${userId} deleted: ${result.removed} trashed item(s) purged, ` +
      `${result.keptProjects} project(s) inside the safety window handed back to the team Trash`,
  )
  return result
}
