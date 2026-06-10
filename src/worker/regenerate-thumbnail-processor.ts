import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { RegenerateThumbnailJob } from '../lib/queue'
import { prisma } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { downloadFile, getLocalSourcePath } from '../lib/storage'
import { getVideoMetadata } from '../lib/ffmpeg'
import { TEMP_DIR } from './cleanup'
import {
  TempFiles,
  processThumbnail,
  cleanupTempFiles,
} from './video-processor-helpers'

/**
 * 2.2.4+ Maintenance job: regenerate the thumbnail for one video.
 *
 * Triggered by the "Re-generate Thumbnails" button (project Settings
 * → Video Processing, and global Settings → Video Processing). The
 * common case is fixing rows whose `thumbnailPath` got cleared by a
 * pre-2.2.4 reprocess flow (which nulled the column but never wrote
 * the regenerated file path back). Also useful when an admin
 * un-checks a custom thumbnail and wants the auto-generated frame
 * back, or when the thumbnail file simply went missing in storage.
 *
 * This job is INTENTIONALLY narrow:
 *   - It does NOT touch `status`, `plannedTiers`, `completedTiers`,
 *     `processingProgress`, or any preview paths.
 *   - It runs at priority 700 — behind FINALIZE (500) — so a bulk
 *     maintenance sweep across hundreds of videos never delays the
 *     tier-encoding pipeline for a freshly uploaded clip.
 *
 * Source-file caching mirrors encode-tier-processor: if prepare-video
 * or an earlier maintenance job already left
 * `<TEMP_DIR>/<videoId>-original` on disk we reuse it; otherwise we
 * pull it down once and leave it for any later maintenance jobs to
 * piggyback on. We don't sweep the original ourselves — that's the
 * temp sweeper's responsibility.
 */
export async function processRegenerateThumbnail(job: Job<RegenerateThumbnailJob>) {
  const { videoId, projectId, originalStoragePath } = job.data
  const start = Date.now()
  logMessage(`[WORKER] regenerate-thumbnail for ${videoId}`)

  const tempFiles: TempFiles = {}

  try {
    // Verify the row still exists. If it was hard-deleted between
    // enqueue and processing (eg admin emptied the project trash)
    // we silently bail rather than write a phantom path.
    const existing = await prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true },
    })
    if (!existing) {
      logMessage(`[WORKER] regenerate-thumbnail ${videoId}: row gone, skipping`)
      return
    }

    // 3.1.0+: Prefer reading the source DIRECTLY from STORAGE_ROOT
    // (local mode) — same fix applied to encode-tier. Falls back to
    // the legacy download-into-/tmp behaviour for S3 mode.
    let sourcePath: string
    const localSource = getLocalSourcePath(originalStoragePath)
    if (localSource) {
      sourcePath = localSource
    } else {
      const cachedOriginal = path.join(TEMP_DIR, `${videoId}-original`)
      if (!fs.existsSync(cachedOriginal)) {
        logMessage(`[WORKER] regenerate-thumbnail ${videoId}: cached original missing, re-downloading`)
        const stream = await downloadFile(originalStoragePath)
        await pipeline(stream, fs.createWriteStream(cachedOriginal))
      }
      // We DON'T set tempFiles.input — the temp sweeper / a later
      // tier job may need the cached original to stick around.
      sourcePath = cachedOriginal
    }

    // Probe just for duration (cheap; processThumbnail needs it to
    // pick the timestamp inside the clip).
    const metadata = await getVideoMetadata(sourcePath)

    const newThumbnailPath = await processThumbnail(
      videoId,
      projectId,
      sourcePath,
      metadata.duration,
      tempFiles,
    )

    try {
      await prisma.video.update({
        where: { id: videoId },
        data: { thumbnailPath: newThumbnailPath },
      })
    } catch (err: any) {
      if (err?.code === 'P2025') {
        logMessage(`[WORKER] regenerate-thumbnail ${videoId}: row deleted before persist, skipping`)
        return
      }
      throw err
    }

    logMessage(
      `[WORKER] regenerate-thumbnail for ${videoId} done in ${((Date.now() - start) / 1000).toFixed(2)}s`,
    )
  } catch (err) {
    logError(`[WORKER] regenerate-thumbnail for ${videoId} failed:`, err)
    throw err
  } finally {
    // Drop the only temp ref we tracked (`tempFiles.thumbnail`) so
    // we don't leave per-job /tmp files lying around.
    await cleanupTempFiles(tempFiles)
  }
}
