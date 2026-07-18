/**
 * Trash cleanup helpers (1.0.8+).
 *
 * Centralises the "permanently destroy a soft-deleted item" logic
 * so the Empty Trash button, the per-item Permanent Delete, and the
 * daily cron job all go through the same code path. Hard delete
 * means: wipe every storage file we own, then drop the DB row.
 */

import { prisma } from './db'
import { deleteFile, deleteDirectory } from './storage'
import { legacyBackend, allFileLocations, type StorageBackend } from './storage-backends'
import { logError } from './logging'

/** How long a trashed item lingers before the cleanup job removes it. */
export const TRASH_RETENTION_DAYS = 30

// 4.2.0+ (Phase 2b): a file may live on more than one backend (kept after a
// transfer). Delete it from every location so nothing is orphaned.
async function deleteFileEverywhere(path: string, backends: StorageBackend[]): Promise<void> {
  for (const b of backends) {
    await deleteFile(path, b).catch(() => {})
  }
}
async function deleteDirectoryEverywhere(dir: string, backends: StorageBackend[]): Promise<void> {
  for (const b of backends) {
    await deleteDirectory(dir, b).catch(() => {})
  }
}

/**
 * Permanently delete a video by id. Mirrors the legacy DELETE
 * handler but standalone so it can be invoked from the cron and the
 * "Empty Trash" button without going through HTTP.
 */
export async function hardDeleteVideoById(id: string): Promise<void> {
  const video = await prisma.video.findUnique({
    where: { id },
    include: { assets: true },
  })
  if (!video) return

  // 4.2.0+: delete from EVERY backend the file lives on (NULL = legacy env;
  // 2b: storageLocations may list more than one after a keep-source transfer).
  const backends = allFileLocations((video as any).storageBackend, (video as any).storageLocations)

  try {
    for (const asset of video.assets) {
      const sharedCount = await prisma.videoAsset.count({
        where: {
          storagePath: asset.storagePath,
          id: { not: asset.id },
        },
      })
      if (sharedCount === 0) {
        await deleteFileEverywhere(
          asset.storagePath,
          allFileLocations((asset as any).storageBackend, (asset as any).storageLocations),
        )
      }
    }

    if (video.originalStoragePath) {
      await deleteFileEverywhere(video.originalStoragePath, backends)
    }
    if (video.preview1080Path) {
      await deleteFileEverywhere(video.preview1080Path, backends)
    }
    if (video.preview720Path) {
      await deleteFileEverywhere(video.preview720Path, backends)
    }
    if (video.preview2160Path) {
      await deleteFileEverywhere(video.preview2160Path, backends)
    }
    if (video.thumbnailPath) {
      const thumbnailSharedAssets = await prisma.videoAsset.count({
        where: {
          storagePath: video.thumbnailPath,
          videoId: { not: id },
        },
      })
      const thumbnailSharedVideos = await prisma.video.count({
        where: {
          thumbnailPath: video.thumbnailPath,
          id: { not: id },
        },
      })
      if (thumbnailSharedAssets === 0 && thumbnailSharedVideos === 0) {
        await deleteFileEverywhere(video.thumbnailPath, backends)
      }
    }
    if ((video as any).storyboardPath) {
      await deleteFileEverywhere((video as any).storyboardPath, backends)
    }

    // 4.1.4+: sweep the whole per-video asset directory. The field-by-field
    // deletes above miss the HLS segment folder (`hls/` — the bulk of the
    // footprint), the 480p tier, and the clean/watermark-free previews
    // (none of which have a dedicated column here), so those leaked as
    // orphaned GBs whenever a video was permanently deleted / emptied from
    // Trash. Everything for a version lives under
    // `projects/{projectId}/videos/{videoId}/` (previews + hls + storyboard
    // + thumbnail); the original mp4 is a sibling handled above. Removing
    // that directory reclaims all of it and is future-proof against new
    // tiers being added later.
    if ((video as any).projectId && video.id) {
      await deleteDirectoryEverywhere(`projects/${(video as any).projectId}/videos/${video.id}`, backends)
    }
  } catch (err) {
    logError(`[hardDeleteVideoById] file cleanup failed for ${id}:`, err)
  }

  await prisma.video.delete({ where: { id } })
}

/**
 * Permanently delete a folder (and all of its descendants by
 * cascade). The DB cascade in Prisma will drop child folders + set
 * videos' folderId to null per the schema; the videos themselves
 * stay around as orphans at the project root unless they were ALSO
 * soft-deleted (in which case the cron will pick them up on the
 * next pass).
 */
export async function hardDeleteFolderById(id: string): Promise<void> {
  const folder = await prisma.folder.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!folder) return
  await prisma.folder.delete({ where: { id } })
}

/**
 * Permanently delete a project, including every video file under it.
 * 1.2.0+: extracted from the legacy DELETE handler when projects
 * moved to a soft-delete + 30-day Trash flow. Mirrors the original
 * file-by-file teardown so we don't leak storage on long-term
 * libraries.
 */
export async function hardDeleteProjectById(id: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id },
    include: { videos: true },
  })
  if (!project) return

  for (const video of project.videos) {
    // 4.2.0+: each video may live on one or more backends (NULL = legacy env;
    // 2b: storageLocations after a keep-source transfer).
    const backends = allFileLocations((video as any).storageBackend, (video as any).storageLocations)
    try {
      if (video.originalStoragePath) {
        await deleteFileEverywhere(video.originalStoragePath, backends)
      }
      // Sweep the whole per-video directory on every backend — this covers the
      // HLS folder, the 480p tier, and any file without a dedicated column.
      await deleteDirectoryEverywhere(`projects/${id}/videos/${video.id}`, backends)
      if ((video as any).storyboardPath) {
        await deleteFileEverywhere((video as any).storyboardPath, backends)
      }
    } catch (err) {
      logError(`[hardDeleteProjectById] file cleanup for video ${video.id}:`, err)
    }
  }

  // Cover image + any other project-scoped files live under projects/{id}/ on
  // the legacy/default backend (covers are written via the legacy path). A
  // recursive removal sweeps them; the remote per-video files were already
  // removed above on each video's own backend.
  try {
    await deleteDirectory(`projects/${id}`, legacyBackend())
  } catch (err) {
    logError(`[hardDeleteProjectById] directory cleanup for ${id}:`, err)
  }

  // The DB cascade drops videos / folders / comments along with
  // the project row.
  await prisma.project.delete({ where: { id } })
}

/**
 * Cron entry point. Hard-deletes every soft-deleted item whose
 * `deletedAt` is older than `TRASH_RETENTION_DAYS` days. Safe to
 * call repeatedly; the cron schedules it daily.
 */
/**
 * 3.9.x: permanently delete a FolderDocument (transcript PDF) by id —
 * wipe its storage file, then drop the row. Used by Empty Trash, the
 * per-item permanent delete, and the retention cron.
 */
export async function hardDeleteFolderDocumentById(id: string): Promise<void> {
  const doc = await (prisma as any).folderDocument.findUnique({
    where: { id },
    select: { id: true, storagePath: true, storageBackend: true, storageLocations: true },
  })
  if (!doc) return
  if (doc.storagePath) {
    await deleteFileEverywhere(doc.storagePath, allFileLocations(doc.storageBackend, doc.storageLocations))
  }
  await (prisma as any).folderDocument.delete({ where: { id } })
}

export async function purgeExpiredTrash(): Promise<{
  videos: number
  folders: number
  projects: number
  documents: number
}> {
  const cutoff = new Date(
    Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  )
  const [expiredVideos, expiredFolders, expiredProjects, expiredDocuments] =
    await Promise.all([
      prisma.video.findMany({
        where: { deletedAt: { lt: cutoff } } as any,
        select: { id: true },
      }),
      prisma.folder.findMany({
        where: { deletedAt: { lt: cutoff } } as any,
        select: { id: true },
      }),
      prisma.project.findMany({
        where: { deletedAt: { lt: cutoff } } as any,
        select: { id: true } as any,
      }),
      (prisma as any).folderDocument.findMany({
        where: { deletedAt: { lt: cutoff } },
        select: { id: true },
      }),
    ])

  let videos = 0
  for (const v of expiredVideos) {
    try {
      await hardDeleteVideoById(v.id)
      videos += 1
    } catch (err) {
      logError('[purgeExpiredTrash] video failed:', err)
    }
  }
  let folders = 0
  for (const f of expiredFolders) {
    try {
      await hardDeleteFolderById(f.id)
      folders += 1
    } catch (err) {
      logError('[purgeExpiredTrash] folder failed:', err)
    }
  }
  let projects = 0
  for (const p of expiredProjects as any[]) {
    try {
      await hardDeleteProjectById(p.id)
      projects += 1
    } catch (err) {
      logError('[purgeExpiredTrash] project failed:', err)
    }
  }
  let documents = 0
  for (const d of expiredDocuments as any[]) {
    try {
      await hardDeleteFolderDocumentById(d.id)
      documents += 1
    } catch (err) {
      logError('[purgeExpiredTrash] document failed:', err)
    }
  }
  return { videos, folders, projects, documents }
}
