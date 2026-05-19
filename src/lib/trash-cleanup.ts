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
import { logError } from './logging'

/** How long a trashed item lingers before the cleanup job removes it. */
export const TRASH_RETENTION_DAYS = 30

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

  try {
    for (const asset of video.assets) {
      const sharedCount = await prisma.videoAsset.count({
        where: {
          storagePath: asset.storagePath,
          id: { not: asset.id },
        },
      })
      if (sharedCount === 0) {
        try {
          await deleteFile(asset.storagePath)
        } catch (err) {
          logError(`[hardDeleteVideoById] asset file failed:`, err)
        }
      }
    }

    if (video.originalStoragePath) {
      try {
        await deleteFile(video.originalStoragePath)
      } catch (err) {
        logError(`[hardDeleteVideoById] original failed:`, err)
      }
    }
    if (video.preview1080Path) {
      try {
        await deleteFile(video.preview1080Path)
      } catch {}
    }
    if (video.preview720Path) {
      try {
        await deleteFile(video.preview720Path)
      } catch {}
    }
    if (video.preview2160Path) {
      try {
        await deleteFile(video.preview2160Path)
      } catch {}
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
        try {
          await deleteFile(video.thumbnailPath)
        } catch {}
      }
    }
    if ((video as any).storyboardPath) {
      try {
        await deleteFile((video as any).storyboardPath)
      } catch {}
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
    try {
      if (video.originalStoragePath) {
        await deleteFile(video.originalStoragePath).catch(() => {})
      }
      if ((video as any).preview2160Path) {
        await deleteFile((video as any).preview2160Path).catch(() => {})
      }
      if (video.preview1080Path) {
        await deleteFile(video.preview1080Path).catch(() => {})
      }
      if (video.preview720Path) {
        await deleteFile(video.preview720Path).catch(() => {})
      }
      if ((video as any).cleanPreview2160Path) {
        await deleteFile((video as any).cleanPreview2160Path).catch(() => {})
      }
      if (video.cleanPreview1080Path) {
        await deleteFile(video.cleanPreview1080Path).catch(() => {})
      }
      if (video.cleanPreview720Path) {
        await deleteFile(video.cleanPreview720Path).catch(() => {})
      }
      if (video.thumbnailPath) {
        await deleteFile(video.thumbnailPath).catch(() => {})
      }
      if ((video as any).storyboardPath) {
        await deleteFile((video as any).storyboardPath).catch(() => {})
      }
    } catch (err) {
      logError(`[hardDeleteProjectById] file cleanup for video ${video.id}:`, err)
    }
  }

  // Cover image + any other project-scoped files live under
  // projects/{id}/, so a recursive directory removal sweeps them.
  try {
    await deleteDirectory(`projects/${id}`)
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
export async function purgeExpiredTrash(): Promise<{
  videos: number
  folders: number
  projects: number
}> {
  const cutoff = new Date(
    Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  )
  const [expiredVideos, expiredFolders, expiredProjects] = await Promise.all([
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
  return { videos, folders, projects }
}
