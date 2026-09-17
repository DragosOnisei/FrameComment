import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { RegenerateThumbnailJob } from '../lib/queue'
import { prisma } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { downloadFile, getLocalSourcePath, getStorageFileSize } from '../lib/storage'
import { getVideoBackend } from '../lib/storage-backends'
import { getVideoMetadata } from '../lib/ffmpeg'
import { pickThumbnailSource } from '../lib/thumbnail-source'
import { TEMP_DIR } from './cleanup'
import {
  TempFiles,
  processThumbnail,
  processStoryboard,
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
      select: {
        id: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        preview2160Path: true,
      },
    })
    if (!existing) {
      logMessage(`[WORKER] regenerate-thumbnail ${videoId}: row gone, skipping`)
      return
    }

    // 3.1.0+: Prefer reading the source DIRECTLY from STORAGE_ROOT
    // (local mode) — same fix applied to encode-tier. Falls back to
    // the legacy download-into-/tmp behaviour for S3 mode.
    // 4.2.0+: resolve the video's storage backend for the source read.
    const backend = await getVideoBackend(videoId)

    // 7.12.0: when the master is not on local disk, read an encoded TIER
    // instead of downloading the whole original — see
    // src/lib/thumbnail-source.ts for why (a 4K master is tens of GB; /tmp
    // is a memory disk; the job died and the video kept no cover). The
    // cached original from the encode run is still used when it is there.
    const localSource = getLocalSourcePath(originalStoragePath, backend)
    const cachedOriginal = path.join(TEMP_DIR, `${videoId}-original`)
    const source = pickThumbnailSource({
      localOriginal: !!localSource || fs.existsSync(cachedOriginal),
      tiers: {
        '480p': existing.preview480Path,
        '720p': existing.preview720Path,
        '1080p': existing.preview1080Path,
        '2160p': existing.preview2160Path,
      },
    })

    let sourcePath: string
    if (source.kind === 'original' && localSource) {
      sourcePath = localSource
      logMessage(`[WORKER] regenerate-thumbnail ${videoId}: reading the original from local disk`)
    } else if (source.kind === 'original' && fs.existsSync(cachedOriginal)) {
      sourcePath = cachedOriginal
      logMessage(`[WORKER] regenerate-thumbnail ${videoId}: reusing the cached original`)
    } else if (source.kind === 'tier') {
      const localTier = getLocalSourcePath(source.path, backend)
      if (localTier) {
        sourcePath = localTier
        logMessage(`[WORKER] regenerate-thumbnail ${videoId}: reading the ${source.tier} tier from local disk`)
      } else {
        const tierTemp = path.join(TEMP_DIR, `${videoId}-thumbsrc-${source.tier}.mp4`)
        const size = await getStorageFileSize(source.path, backend).catch(() => null)
        logMessage(
          `[WORKER] regenerate-thumbnail ${videoId}: downloading the ${source.tier} tier` +
            (size !== null ? ` (${(size / 1024 / 1024).toFixed(1)} MB)` : '') +
            ` instead of the original`,
        )
        const stream = await downloadFile(source.path, backend)
        await pipeline(stream, fs.createWriteStream(tierTemp))
        // Ours alone — nothing else reads this copy, so it is swept with the
        // other temp files at the end of the job.
        tempFiles.input = tierTemp
        sourcePath = tierTemp
      }
    } else {
      // No tier at all (never encoded, or encoding stopped before 480p):
      // the original is the only picture there is. Say how big it is, so
      // a log reader knows what the next minutes are being spent on.
      const size = await getStorageFileSize(originalStoragePath, backend).catch(() => null)
      logMessage(
        `[WORKER] regenerate-thumbnail ${videoId}: no encoded tier yet, downloading the original` +
          (size !== null ? ` (${(size / 1024 / 1024 / 1024).toFixed(2)} GB)` : ''),
      )
      const stream = await downloadFile(originalStoragePath, backend)
      await pipeline(stream, fs.createWriteStream(cachedOriginal))
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
      backend,
    )

    // 6.9.3: rebuild the hover-scrub sprite too, at the new density.
    //
    // Sprites made before 6.9.3 are a fixed 10x10 no matter how long the clip
    // is — on a 7-minute video that's one frame every 4.2 seconds, and the
    // preview under your cursor can be seconds away from where a click lands.
    // Re-encoding isn't needed; the sprite is a cheap second pass over the
    // source we already have open. Soft failure: a thumbnail refresh must not
    // fail because the sprite didn't.
    const newStoryboardPath = await processStoryboard(
      videoId,
      projectId,
      sourcePath,
      metadata.duration,
      tempFiles,
      backend,
    )

    try {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          thumbnailPath: newThumbnailPath,
          ...(newStoryboardPath ? { storyboardPath: newStoryboardPath } : {}),
        },
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
