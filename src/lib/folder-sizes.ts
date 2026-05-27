import { prisma } from '@/lib/db'

/**
 * 1.5.9+: compute the total bytes inside each folder of a project,
 * walking the folder tree so subfolder contents bubble up to every
 * ancestor. Mirrors the "3 folders · 3.4 GB" label that ProjectsList
 * shows for projects — operators wanted the same affordance one
 * level down so they can spot where a project's storage actually
 * lives.
 *
 * Returns a Map<folderId, bytes-as-BigInt>. Folders that contain
 * zero videos (and zero video-having descendants) come back as
 * `BigInt(0)` so the caller can stringify the BigInt without branching.
 *
 * Implementation notes:
 *  - One small query for the folder graph (id + parentFolderId)
 *  - One indexed query for video sizes grouped by folderId
 *  - In-memory parent-chain walk: O(videos × folder-depth), and
 *    folder-depth is essentially bounded by what an admin will
 *    ever create (single-digit nesting in practice).
 */
export async function computeFolderSizesByProject(
  projectId: string,
): Promise<Map<string, bigint>> {
  // Soft-deleted folders are excluded — Trash has its own listing
  // and we don't want their bytes counted toward a live folder's
  // total.
  const folders = await prisma.folder.findMany({
    where: { projectId, deletedAt: null } as any,
    select: { id: true, parentFolderId: true },
  })

  // folderId → its direct parentFolderId (or null when at the
  // project root). We use this to walk up the chain for each video.
  const parentByFolderId = new Map<string, string | null>()
  for (const f of folders) {
    parentByFolderId.set(f.id, f.parentFolderId)
  }

  // Sum of originalFileSize per leaf folderId. Videos whose folderId
  // is null live at the project root and aren't counted toward any
  // folder's total (the project dashboard tile already covers them).
  const videoSums = await prisma.video.groupBy({
    by: ['folderId'],
    where: {
      projectId,
      folderId: { not: null },
      deletedAt: null,
    } as any,
    _sum: { originalFileSize: true },
  })

  const totals = new Map<string, bigint>()
  for (const f of folders) totals.set(f.id, BigInt(0))

  for (const row of videoSums) {
    const folderId = row.folderId as string | null
    if (!folderId) continue
    const bytes = (row._sum?.originalFileSize ?? BigInt(0)) as bigint
    if (bytes === BigInt(0)) continue

    // Walk up the parent chain, adding bytes to each ancestor. The
    // visited Set guards against a corrupt cycle in the data — in
    // theory `wouldCreateFolderCycle()` prevents this on write, but
    // a stale row from before that guard shouldn't crash the page.
    let current: string | null = folderId
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      visited.add(current)
      totals.set(current, (totals.get(current) ?? BigInt(0)) + bytes)
      current = parentByFolderId.get(current) ?? null
    }
  }

  return totals
}
