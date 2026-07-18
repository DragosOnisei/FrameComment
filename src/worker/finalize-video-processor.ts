import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { FinalizeVideoJob, VIDEO_JOB_PRIORITY, getVideoQueue } from '../lib/queue'
import { prisma } from '../lib/db'
import { downloadFile } from '../lib/storage'
import { getVideoBackend } from '../lib/storage-backends'
import { logMessage, logError } from '../lib/logging'
import { TEMP_DIR } from './cleanup'
import {
  TempFiles,
  processStoryboard,
  debugLog,
  handleProcessingError,
} from './video-processor-helpers'

// 2.2.0+: after how many minutes a finalize job that keeps waiting
// for tiers gives up trying. The job re-queues itself with a delay
// up to this many minutes total; on hitting the cap it logs and
// returns successfully so BullMQ doesn't retry the whole pipeline.
const FINALIZE_TIMEOUT_MIN = 30
const FINALIZE_RETRY_DELAY_MS = 30_000 // 30s — polls 60 times in 30 min

/**
 * 2.2.0+ Stage 3: post-encode cleanup + storyboard.
 *
 * Runs at the lowest priority (500) on the queue so it never
 * starves an encode-tier of a different video. Responsibilities:
 *
 *   1. Wait until completedTiers.length === plannedTiers.length.
 *      If not, re-queue ourselves with a 30s delay (the worker
 *      slot is released back to the pool — we are NOT busy-waiting).
 *      Soft timeout at 30 min: we log and return so BullMQ doesn't
 *      retry the whole pipeline.
 *
 *   2. Generate the hover-scrub storyboard sprite from the cheapest
 *      available preview (480p — already on disk OR re-downloadable
 *      from storage). Cheaper than running it on the multi-GB
 *      master.
 *
 *   3. Cleanup the cached original at /tmp/framecomment/<videoId>-original
 *      and any leftover tier MP4s.
 *
 *   4. Final processingProgress = 100. We do NOT touch `status`
 *      here — encode-tier already flipped READY when the first
 *      tier landed; READY is the terminal status for the user.
 *
 * Idempotency: this job is safe to retry — storyboard generation
 * is overwrite-OK, the cleanup unlinks only what exists, and the
 * final UPDATE is just a progress bump.
 */
export async function processFinalizeVideo(job: Job<FinalizeVideoJob>) {
  const { videoId, projectId, originalStoragePath } = job.data

  logMessage(`[WORKER] finalize-video for ${videoId}`)
  debugLog('Finalize job data:', job.data)

  const tempFiles: TempFiles = {}

  try {
    const row = (await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        status: true,
        plannedTiers: true,
        completedTiers: true,
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        preview2160Path: true,
        duration: true,
        storyboardPath: true,
      } as any,
    })) as any

    if (!row) {
      logMessage(`[WORKER] finalize-video for ${videoId}: row gone, skipping`)
      // Best-effort cache cleanup even though the row is gone, so
      // we don't leak the cached original.
      await tryUnlinkOriginal(videoId)
      return
    }

    const planned: string[] = Array.isArray(row.plannedTiers) ? row.plannedTiers : []
    const completed: string[] = Array.isArray(row.completedTiers) ? row.completedTiers : []

    // ─── Wait for all tiers ──────────────────────────────────────
    if (planned.length === 0) {
      // Legacy / skipTranscoding row that somehow ended up with a
      // finalize job. Treat as already done and exit clean.
      logMessage(`[WORKER] finalize-video for ${videoId}: no plannedTiers, treating as no-op`)
      return
    }

    if (completed.length < planned.length) {
      // Compute how many times we've already re-queued via opts.delay
      // and the job's age. BullMQ doesn't surface "delayed count"
      // directly, so we infer from job.timestamp — if total elapsed
      // exceeds FINALIZE_TIMEOUT_MIN, give up.
      const ageMin = (Date.now() - job.timestamp) / 60_000
      if (ageMin > FINALIZE_TIMEOUT_MIN) {
        logMessage(
          `[WORKER] finalize-video for ${videoId} timed out after ${ageMin.toFixed(1)}min ` +
            `(completed ${completed.length}/${planned.length}). Giving up — encode-tier jobs may have failed silently.`,
        )
        // Mark progress at the fraction we got so the UI doesn't
        // sit at the partial number forever — and don't throw,
        // because retrying the finalize from scratch won't make
        // missing tiers appear.
        try {
          const pct = Math.round((completed.length / planned.length) * 100)
          await prisma.video.update({
            where: { id: videoId },
            data: { processingProgress: pct },
          })
        } catch (err) {
          logError(`[WORKER] finalize timeout progress update failed for ${videoId}:`, err)
        }
        return
      }

      logMessage(
        `[WORKER] finalize-video for ${videoId}: ${completed.length}/${planned.length} tiers in — re-queueing with ${FINALIZE_RETRY_DELAY_MS}ms delay`,
      )
      const queue = getVideoQueue()
      // Use a NEW jobId so BullMQ doesn't reject the re-enqueue as a
      // duplicate of the in-flight one we're currently processing.
      // We append the current attempt count so each re-queue is
      // distinct but still grouped by videoId for the delete cleanup.
      await queue.add('finalize-video', { videoId, projectId, originalStoragePath }, {
        priority: VIDEO_JOB_PRIORITY.FINALIZE,
        delay: FINALIZE_RETRY_DELAY_MS,
        jobId: `finalize-${videoId}-retry-${Date.now()}`,
      })
      return
    }

    // ─── Storyboard sprite ───────────────────────────────────────
    // Generate from the cheapest preview we have. The 480p MP4 is
    // typically <100MB so the sprite extraction lands in seconds.
    // Falls back through the tiers if 480p was skipped.
    if (!row.storyboardPath) {
      const tierPathByPriority: Array<[string, string | null]> = [
        ['480p', row.preview480Path],
        ['720p', row.preview720Path],
        ['1080p', row.preview1080Path],
        ['2160p', row.preview2160Path],
      ]
      const sourceCandidate = tierPathByPriority.find(([, p]) => !!p)
      if (sourceCandidate && Number.isFinite(row.duration) && row.duration > 0) {
        const [tier, storagePath] = sourceCandidate
        // 4.2.0+: the preview + storyboard live on the video's own backend.
        const backend = await getVideoBackend(videoId)
        // Try the cached local preview first; if it's not there
        // (cleaned up by encode-tier) we re-download from storage.
        const localCandidate = path.join(TEMP_DIR, `${videoId}-preview-${tier}.mp4`)
        let storyboardSource = localCandidate
        if (!fs.existsSync(localCandidate) && storagePath) {
          try {
            const stream = await downloadFile(storagePath, backend)
            await pipeline(stream, fs.createWriteStream(localCandidate))
            storyboardSource = localCandidate
            tempFiles.input = localCandidate
          } catch (err) {
            logError(`[WORKER] finalize-video for ${videoId}: storyboard source download failed:`, err)
            storyboardSource = ''
          }
        }
        if (storyboardSource) {
          try {
            const sbPath = await processStoryboard(
              videoId,
              projectId,
              storyboardSource,
              row.duration,
              tempFiles,
              backend,
            )
            if (sbPath) {
              try {
                await prisma.video.update({
                  where: { id: videoId },
                  data: { storyboardPath: sbPath } as any,
                })
              } catch (err: any) {
                if (err?.code !== 'P2025') {
                  logError(`[WORKER] storyboard persist failed for ${videoId}:`, err)
                }
              }
            }
          } catch (err) {
            logError(`[WORKER] storyboard generation failed for ${videoId}:`, err)
          }
        }
      }
    }

    // ─── Cleanup cached original + leftover tier MP4s ────────────
    await tryUnlinkOriginal(videoId)
    for (const tier of ['480p', '720p', '1080p', '2160p']) {
      const tierFile = path.join(TEMP_DIR, `${videoId}-preview-${tier}.mp4`)
      try {
        if (fs.existsSync(tierFile)) fs.unlinkSync(tierFile)
      } catch (err) {
        logError(`[WORKER] Failed to unlink ${tierFile}:`, err)
      }
    }

    // ─── Final progress bump ─────────────────────────────────────
    try {
      await prisma.video.update({
        where: { id: videoId },
        data: { processingProgress: 100 },
      })
    } catch (err: any) {
      if (err?.code !== 'P2025') throw err
    }

    logMessage(`[WORKER] finalize-video for ${videoId} done (${completed.length}/${planned.length} tiers)`)
  } catch (error: any) {
    if (error?.code === 'P2025') {
      logMessage(`[WORKER] finalize-video for ${videoId}: row not found — skipping`)
      return
    }
    // Don't escalate to ERROR status here — the video is already
    // playable (encode-tier flipped READY), and a failed finalize is
    // basically just "didn't get a storyboard / didn't clean /tmp".
    // We DO let BullMQ retry, but cap behaviour through the
    // queue's default `attempts: 3` config.
    logError(`[WORKER] finalize-video for ${videoId} failed:`, error)
    throw error
  }
}

async function tryUnlinkOriginal(videoId: string): Promise<void> {
  const cachedOriginal = path.join(TEMP_DIR, `${videoId}-original`)
  try {
    if (fs.existsSync(cachedOriginal)) {
      fs.unlinkSync(cachedOriginal)
      logMessage(`[WORKER] Cleaned cached original for ${videoId}`)
    }
  } catch (err) {
    logError(`[WORKER] Failed to unlink ${cachedOriginal}:`, err)
  }
}
