/**
 * Folder preview thumbnails (1.0.7+).
 *
 * Frame.io-style folder cards show a small mosaic of what's inside
 * the folder instead of a plain folder icon. We surface up to four
 * preview thumbnails per folder: the latest version of the four most
 * recent READY videos that have a thumbnailPath. When a folder
 * contains only sub-folders (or its videos haven't generated
 * thumbnails yet), the array comes back empty and the UI falls back
 * to the plain folder glyph.
 *
 * This module is server-only — it imports Prisma and the video access
 * token minter. Callers (folder list + folder detail routes) pass in
 * the request and a stable sessionId so the resulting `/api/content`
 * URLs share a Redis cache window.
 */

import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateVideoAccessToken } from '@/lib/video-access'
import { logError } from '@/lib/logging'

export type FolderPreviewItem =
  | { kind: 'video'; videoId: string; thumbnailUrl: string }
  | { kind: 'folder'; folderId: string }

/** Maximum preview tiles we render on a single folder cover. */
const MAX_PREVIEW = 4

/**
 * Aggregate preview tiles + the corrected item count for every folder
 * id in `folderIds`. Returned in a single shape so the API routes can
 * stay in one place: previews drive the Frame.io-style mosaic cover,
 * itemCounts drive the "N items" label under the folder name.
 *
 * Item count rule (1.0.7+) — count *distinct* video groups (one entry
 * per `name`, regardless of how many versions exist) plus the number
 * of sub-folders. So a folder holding `1 sub-folder + 1 video with 3
 * versions` reads as "2 items", not "4".
 *
 * Mosaic rule (1.0.7+) — sub-folder tiles get reserved first (up to
 * MAX_PREVIEW = 4), then the remaining slots fill with the most
 * recent video thumbnails. With `1 sub-folder + 6 videos` you get
 * `[folder, v1, v2, v3]`.
 */
export async function fetchFolderPreviewData(
  folderIds: string[],
  request: NextRequest,
  sessionId: string,
): Promise<{
  previews: Map<string, FolderPreviewItem[]>
  itemCounts: Map<string, number>
}> {
  const previews = new Map<string, FolderPreviewItem[]>()
  const itemCounts = new Map<string, number>()
  if (folderIds.length === 0) return { previews, itemCounts }

  // 1. Pull every sub-folder so we know both how many there are and
  // which ones to reserve preview slots for. 1.0.8+: drop trashed
  // rows so the mosaic never previews items that the user just sent
  // to Trash.
  const subfolders = await prisma.folder.findMany({
    where: { parentFolderId: { in: folderIds }, deletedAt: null } as any,
    orderBy: [{ name: 'asc' }],
    select: { id: true, parentFolderId: true },
  })
  const subfoldersByParent = new Map<string, typeof subfolders>()
  for (const sub of subfolders) {
    if (!sub.parentFolderId) continue
    const bucket = subfoldersByParent.get(sub.parentFolderId) ?? []
    bucket.push(sub)
    subfoldersByParent.set(sub.parentFolderId, bucket)
  }

  // 2. Count *distinct* video groups per folder by `name` — versions
  // share a name so the groupBy collapses them into one row each.
  // This drives the "N items" label so it never inflates with
  // versions the user already views as a single asset. Trashed rows
  // are skipped (1.0.8+).
  const grouped = await prisma.video.groupBy({
    by: ['folderId', 'name'],
    where: { folderId: { in: folderIds }, deletedAt: null } as any,
  })
  const distinctVideoGroups = new Map<string, number>()
  for (const g of grouped) {
    if (!g.folderId) continue
    distinctVideoGroups.set(
      g.folderId,
      (distinctVideoGroups.get(g.folderId) ?? 0) + 1,
    )
  }

  // 3. Pull READY+thumbnailed videos for the preview tiles. We
  // over-fetch slightly so dedup by `name` (latest version per group)
  // still leaves room for MAX_PREVIEW distinct rows.
  const cap = Math.max(MAX_PREVIEW * 4, MAX_PREVIEW * folderIds.length * 2)
  const videos = await prisma.video.findMany({
    where: {
      folderId: { in: folderIds },
      status: 'READY',
      thumbnailPath: { not: null },
      deletedAt: null,
    } as any,
    orderBy: [{ createdAt: 'desc' }],
    take: cap,
    select: {
      id: true,
      folderId: true,
      projectId: true,
      name: true,
      thumbnailPath: true,
    },
  })
  const videosByFolder = new Map<string, typeof videos>()
  for (const v of videos) {
    if (!v.folderId) continue
    const bucket = videosByFolder.get(v.folderId) ?? []
    if (bucket.some((existing) => existing.name === v.name)) continue
    bucket.push(v)
    videosByFolder.set(v.folderId, bucket)
  }

  // 4. Build per-folder tiles. Sub-folder tiles come first (they're
  // free — no token needed), then video tiles in upload order until
  // we hit MAX_PREVIEW.
  await Promise.all(
    folderIds.map(async (folderId) => {
      const subs = subfoldersByParent.get(folderId) ?? []
      const vids = videosByFolder.get(folderId) ?? []

      const tiles: FolderPreviewItem[] = []
      for (const sub of subs) {
        if (tiles.length >= MAX_PREVIEW) break
        tiles.push({ kind: 'folder', folderId: sub.id })
      }
      for (const v of vids) {
        if (tiles.length >= MAX_PREVIEW) break
        try {
          const token = await generateVideoAccessToken(
            v.id,
            v.projectId,
            'thumbnail',
            request,
            sessionId,
          )
          tiles.push({
            kind: 'video',
            videoId: v.id,
            thumbnailUrl: `/api/content/${token}`,
          })
        } catch (err) {
          logError('[fetchFolderPreviewData] thumbnail token failed:', err)
        }
      }
      if (tiles.length > 0) previews.set(folderId, tiles)

      const itemCount =
        subs.length + (distinctVideoGroups.get(folderId) ?? 0)
      itemCounts.set(folderId, itemCount)
    }),
  )

  return { previews, itemCounts }
}

/**
 * @deprecated Use `fetchFolderPreviewData` — it also returns the
 * corrected item counts. This wrapper is kept for call sites that
 * only need the preview map.
 */
export async function fetchFolderPreviews(
  folderIds: string[],
  request: NextRequest,
  sessionId: string,
): Promise<Map<string, FolderPreviewItem[]>> {
  const { previews } = await fetchFolderPreviewData(
    folderIds,
    request,
    sessionId,
  )
  return previews
}
