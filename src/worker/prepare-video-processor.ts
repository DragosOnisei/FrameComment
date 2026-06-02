import { Job } from 'bullmq'
import path from 'path'
import {
  PrepareVideoJob,
  EncodeTierJob,
  FinalizeVideoJob,
  VIDEO_JOB_PRIORITY,
  priorityForTier,
  getVideoQueue,
} from '../lib/queue'
import { prisma } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { TEMP_DIR } from './cleanup'
import {
  TempFiles,
  downloadAndValidateVideo,
  fetchProcessingSettings,
  processThumbnail,
  computeProgressiveTiers,
  updateVideoStatus,
  cleanupTempFiles,
  handleProcessingError,
  debugLog,
  finalizeVideo,
} from './video-processor-helpers'

/**
 * 2.2.0+ Stage 1 of the breadth-first pipeline.
 *
 * The work split is the key insight: under the old single-job
 * orchestrator a 100-file bulk upload made file #100 wait for files
 * #1-#99 to encode EVERY tier (480→720→1080→2160) before it even got
 * a 480p. The new pipeline puts every cheap, instant-feedback action
 * (download + probe + thumbnail + tier-plan) into THIS job at the
 * highest priority — so on a 100-file blast, all 100 prepare jobs
 * race through first, every video has a thumbnail + a planned tier
 * list + a row of `encode-tier` jobs sitting in the queue with the
 * right priorities, and THEN the encoders chew through 480p × 100
 * before climbing to 720p × 100, etc.
 *
 * Side effects we MUST preserve from 2.1.x:
 *   - Magic-byte validation (security — refuses non-video uploads)
 *   - Thumbnail extraction (UX — folder grid shows still frame
 *     immediately even before any tier finishes)
 *   - skipTranscoding short-circuit (admin setting)
 *   - DB row updates that the spinner / banner polls
 *
 * Deliberately deferred to encode-tier jobs:
 *   - Any preview transcoding (these split out into individual
 *     `encode-tier` jobs).
 *   - HLS remux (happens as a sub-step inside encode-tier so the
 *     master manifest grows tier-by-tier).
 *   - Storyboard sprite generation (lives in finalize-video; runs
 *     against the cheap 480p output, not the source).
 *
 * IMPORTANT: the source file gets cached at
 * `/tmp/framecomment/<videoId>-original`. This file is intentionally
 * NOT cleaned up here — encode-tier jobs reuse it, and finalize-video
 * is the one that unlinks it after the last tier lands. The temp dir
 * sweeper has a >24h floor so a stuck job won't get its cache
 * yanked mid-run.
 */
export async function processPrepareVideo(job: Job<PrepareVideoJob>) {
  const { videoId, originalStoragePath, projectId } = job.data

  logMessage(`[WORKER] prepare-video for ${videoId}`)
  debugLog('Prepare job data:', job.data)

  // We retain `tempFiles` so the helpers can register paths for
  // sweep cleanup — but we deliberately skip `cleanupTempFiles` at
  // the end of THIS job because we WANT the downloaded original to
  // persist for the encode-tier jobs that will pick it up next.
  // Only the thumbnail temp file is cleaned here.
  const tempFiles: TempFiles = {}
  const start = Date.now()

  try {
    // Mark as PROCESSING (idempotent — upload route may have done
    // this already). Throws TranscodeAborted if the row was deleted
    // before we got here, which we swallow at the bottom.
    await updateVideoStatus(videoId, 'PROCESSING', 0)

    // Stage 1: download + validate + probe. This populates tempFiles.input
    // with `/tmp/framecomment/<videoId>-original`. We leave that file in
    // place for the encode-tier jobs.
    const videoInfo = await downloadAndValidateVideo(videoId, originalStoragePath, tempFiles)

    // Stage 2: load project settings to know previewResolution +
    // skipTranscoding + watermark settings (used by encode-tier).
    const settings = await fetchProcessingSettings(projectId, videoId)

    // ─── skipTranscoding shortcut ────────────────────────────────────
    // The admin turned off transcoding for this project. We never
    // need encode-tier or finalize jobs in this mode — just generate
    // a thumbnail and flip the row to READY, exactly as 2.1.x did.
    if (settings.skipTranscoding) {
      logMessage(`[WORKER] Skip transcoding for ${videoId}, fast-path finalize`)
      const thumbnailPath = await processThumbnail(
        videoId,
        projectId,
        videoInfo.path,
        videoInfo.metadata.duration,
        tempFiles,
      )
      await finalizeVideo(
        videoId,
        '', // No preview path
        thumbnailPath,
        videoInfo.metadata,
        settings.resolution,
        null,
      )
      // We keep the original around so the existing reprocess flow
      // can find it cached on disk; the regular temp sweeper will
      // mop it up later. We DO clean up the thumbnail temp file.
      delete tempFiles.input
      await cleanupTempFiles(tempFiles)
      logMessage(
        `[WORKER] prepare-video (skipTranscoding) for ${videoId} done in ${((Date.now() - start) / 1000).toFixed(2)}s`,
      )
      return
    }

    // ─── Tier planning ───────────────────────────────────────────────
    // Same `computeProgressiveTiers` we used in 2.1.x — respects
    // both project.previewResolution and the source's actual short
    // side (no upscaling). Result is something like
    // [480p, 720p, 1080p] for an HD upload to a 1080p project, or
    // [480p, 720p, 1080p, 2160p] for a 4K project.
    const tiers = computeProgressiveTiers(videoInfo.metadata, settings.resolution)
    const tierSlugs = tiers.map((t) => t.tier)
    logMessage(`[WORKER] ${videoId} plannedTiers = ${tierSlugs.join(', ')}`)

    // Persist plannedTiers + reset completedTiers so a reprocess
    // starts from a clean slate. We also persist the just-probed
    // metadata so the UI can show duration / resolution before the
    // first tier even starts — the old single job only wrote these
    // alongside the first finalize update.
    try {
      await prisma.video.update({
        where: { id: videoId },
        data: {
          plannedTiers: tierSlugs,
          completedTiers: [],
          duration: videoInfo.metadata.duration,
          width: videoInfo.metadata.width,
          height: videoInfo.metadata.height,
          fps: videoInfo.metadata.fps,
          codec: videoInfo.metadata.codec,
        } as any,
      })
    } catch (err: any) {
      if (err?.code === 'P2025') {
        logMessage(`[WORKER] ${videoId} row deleted before plannedTiers write — skipping`)
        return
      }
      throw err
    }

    // ─── Eager thumbnail ─────────────────────────────────────────────
    // We generate the thumbnail HERE rather than in encode-tier so
    // the folder grid has a still frame as soon as prepare finishes
    // — well before the first 480p lands. The upload route already
    // produced an instant thumbnail in local-mode; this is a
    // refresh (same path) so the result is identical.
    //
    // 2.2.4+: capture the path and persist it to `Video.thumbnailPath`.
    // Without this write the upload-route path holds for new uploads
    // (because the row already points at the right file) but the
    // reprocess flow — which nulls `thumbnailPath` before re-enqueue
    // — left the row pointing at NULL even though the file was
    // re-generated successfully. The grid then showed the empty
    // placeholder until the next manual re-upload.
    try {
      const newThumbnailPath = await processThumbnail(
        videoId,
        projectId,
        videoInfo.path,
        videoInfo.metadata.duration,
        tempFiles,
      )
      try {
        await prisma.video.update({
          where: { id: videoId },
          data: { thumbnailPath: newThumbnailPath },
        })
      } catch (writeErr: any) {
        // P2025 means the row was deleted between our metadata
        // update above and now — silently drop the write; the
        // tier processors will hit the same P2025 and exit.
        if (writeErr?.code !== 'P2025') {
          logError(`[WORKER] Persist thumbnailPath for ${videoId} failed:`, writeErr)
        }
      }
    } catch (err) {
      // Best-effort — a failed thumbnail doesn't block encoding.
      logError(`[WORKER] Eager thumbnail failed for ${videoId}:`, err)
    }

    // ─── Enqueue tier + finalize jobs ───────────────────────────────
    // Each tier gets its own job with a fixed priority. BullMQ pops
    // lower numbers first; with PREPARE=1 + ENCODE_480P=10 + 720P=50
    // + 1080P=100 + 2160P=200 + FINALIZE=500, on a 100-file bulk
    // upload all 100 prepares finish first, then 480p × 100 before
    // any 720p, etc. Finalize sits at the bottom so it never
    // outranks an encode of a different video.
    const queue = getVideoQueue()
    for (const tier of tierSlugs) {
      const tierJob: EncodeTierJob = {
        videoId,
        projectId,
        originalStoragePath,
        tier: tier as EncodeTierJob['tier'],
      }
      await queue.add('encode-tier', tierJob, {
        priority: priorityForTier(tier as EncodeTierJob['tier']),
        // Per-job dedupe key so a duplicate enqueue (from retry of
        // prepare-video) doesn't double-schedule the same tier.
        jobId: `encode-${videoId}-${tier}`,
      })
    }

    const finalizeJob: FinalizeVideoJob = {
      videoId,
      projectId,
      originalStoragePath,
    }
    await queue.add('finalize-video', finalizeJob, {
      priority: VIDEO_JOB_PRIORITY.FINALIZE,
      jobId: `finalize-${videoId}`,
    })

    // Drop tempFiles.input so cleanupTempFiles() doesn't unlink the
    // cached original — encode-tier jobs need it on disk.
    delete tempFiles.input
    await cleanupTempFiles(tempFiles)

    logMessage(
      `[WORKER] prepare-video for ${videoId} done in ${((Date.now() - start) / 1000).toFixed(2)}s (enqueued ${tierSlugs.length} encode-tier + 1 finalize)`,
    )
  } catch (error: any) {
    if (error?.message === 'TranscodeAborted') {
      logMessage(`[WORKER] prepare-video ${videoId} aborted (row deleted)`)
      // Cleanup the cached original so we don't leak the byte stream
      // for a video that no longer exists.
      await cleanupTempFiles(tempFiles)
      return
    }
    if (error?.code === 'P2025') {
      logMessage(`[WORKER] prepare-video ${videoId} row not found — skipping`)
      await cleanupTempFiles(tempFiles)
      return
    }
    await handleProcessingError(videoId, error)
    // Still try cleanup on hard failure.
    await cleanupTempFiles(tempFiles).catch(() => {})
    throw error
  }
}
