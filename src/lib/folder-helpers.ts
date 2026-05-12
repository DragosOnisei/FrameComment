/**
 * Shared helpers for the Folder model introduced in 1.0.6. Kept in
 * its own module so the CRUD route handlers, the share-page server
 * code and the future drag-and-drop logic all reach for the same
 * implementation.
 */

import { prisma } from '@/lib/db'
import crypto from 'node:crypto'

/**
 * Generate a URL-safe, collision-checked slug for a folder share
 * link. We use 12 bytes of randomness (~16 chars base64url) and
 * retry on the off chance two folders are created at the same
 * millisecond and land on the same string.
 */
export async function generateUniqueFolderSlug(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = crypto.randomBytes(9).toString('base64url')
    const existing = await prisma.folder.findUnique({
      where: { slug },
      select: { id: true },
    })
    if (!existing) return slug
  }
  // Falling out of the loop is exceptionally unlikely (8 collisions
  // in a row across a 2^72 keyspace), but if it does we widen the key.
  return crypto.randomBytes(18).toString('base64url')
}

/**
 * Walk up the folder tree from `newParentId` and check whether
 * `folderId` appears as an ancestor. Used when moving a folder so we
 * never let the user create a cycle (folder pointing back into its
 * own descendant). A null `newParentId` means "move to project root"
 * — safe by definition.
 *
 * Bounded by `maxDepth` (default 256) so a corrupt tree can never
 * trap us in an infinite walk.
 */
export async function wouldCreateFolderCycle(
  folderId: string,
  newParentId: string | null,
  maxDepth = 256,
): Promise<boolean> {
  if (!newParentId) return false
  if (newParentId === folderId) return true

  let cursor: { id: string; parentFolderId: string | null } | null = await prisma.folder.findUnique({
    where: { id: newParentId },
    select: { id: true, parentFolderId: true },
  })

  let depth = 0
  while (cursor && depth < maxDepth) {
    if (cursor.id === folderId) return true
    if (!cursor.parentFolderId) return false
    cursor = await prisma.folder.findUnique({
      where: { id: cursor.parentFolderId },
      select: { id: true, parentFolderId: true },
    })
    depth += 1
  }
  return false
}

/**
 * Returns the set of folder ids that live strictly underneath
 * `rootFolderId` (including itself). Used to authorise content
 * requests that arrive via a folder-share token: the requested
 * video's folderId must be in this set (or null, if we also want to
 * include the root folder's own loose videos — see callers).
 *
 * Walks the tree with a BFS using `findMany` per level. For a small
 * folder tree this is fine; if folders ever grow to thousands of
 * children at one level we'd want to switch to a recursive CTE.
 */
export async function collectDescendantFolderIds(
  rootFolderId: string,
  maxDepth = 64,
): Promise<Set<string>> {
  const result = new Set<string>([rootFolderId])
  let frontier: string[] = [rootFolderId]
  let depth = 0
  while (frontier.length > 0 && depth < maxDepth) {
    const children = await prisma.folder.findMany({
      where: { parentFolderId: { in: frontier } },
      select: { id: true },
    })
    frontier = []
    for (const c of children) {
      if (!result.has(c.id)) {
        result.add(c.id)
        frontier.push(c.id)
      }
    }
    depth += 1
  }
  return result
}

/**
 * True iff the video sits somewhere under `rootFolderId` — either
 * directly inside it or inside one of its descendants.
 *
 * Folder-share tokens are scoped to a folder subtree; this is the
 * gate that prevents a token issued for "Folder A" from accessing a
 * video that's actually in "Folder B" of the same project.
 */
export async function isVideoUnderFolder(
  videoId: string,
  rootFolderId: string,
): Promise<boolean> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { folderId: true },
  })
  if (!video || !video.folderId) return false
  if (video.folderId === rootFolderId) return true
  const ids = await collectDescendantFolderIds(rootFolderId)
  return ids.has(video.folderId)
}

/**
 * Resolve the full breadcrumb path (root → ... → folder) for the
 * given folder id. Used by the admin UI and the public share page so
 * the user can see where they are in the tree.
 *
 * Returns an array ordered from the topmost folder to the target
 * folder; the project itself is NOT included (callers prepend the
 * project name themselves).
 */
export async function loadFolderAncestry(
  folderId: string,
  maxDepth = 256,
): Promise<Array<{ id: string; name: string; slug: string }>> {
  const path: Array<{ id: string; name: string; slug: string }> = []
  let cursor: { id: string; name: string; slug: string; parentFolderId: string | null } | null = await prisma.folder.findUnique({
    where: { id: folderId },
    select: { id: true, name: true, slug: true, parentFolderId: true },
  })
  let depth = 0
  while (cursor && depth < maxDepth) {
    path.unshift({ id: cursor.id, name: cursor.name, slug: cursor.slug })
    if (!cursor.parentFolderId) break
    cursor = await prisma.folder.findUnique({
      where: { id: cursor.parentFolderId },
      select: { id: true, name: true, slug: true, parentFolderId: true },
    })
    depth += 1
  }
  return path
}
