import { Job } from 'bullmq'
import path from 'path'
import { VideoProcessingJob } from '../lib/queue'
import { logMessage } from '../lib/logging'
import { getMaxParallelTranscodes } from '../lib/ffmpeg'
import { TEMP_DIR } from './cleanup'
import {
  TempFiles,
  downloadAndValidateVideo,
  fetchProcessingSettings,
  calculateOutputDimensions,
  processPreview,
  processThumbnail,
  processStoryboard,
  processHlsTier,
  finalizeVideo,
  finalizeFirstTier,
  finalizeAdditionalTier,
  computeProgressiveTiers,
  updateVideoStatus,
  cleanupTempFiles,
  handleProcessingError,
  debugLog
} from './video-processor-helpers'

/**
 * Main video processing orchestrator
 *
 * Stages:
 * 1. Download and validate video file
 * 2. Fetch processing settings from database
 * 3. Calculate output dimensions
 * 4. Process preview with watermark
 * 5. Generate thumbnail
 * 6. Finalize and update database
 * 7. Cleanup temporary files
 */
export async function processVideo(job: Job<VideoProcessingJob>) {
  const { videoId, originalStoragePath, projectId } = job.data

  logMessage(`[WORKER] Processing video ${videoId}`)

  debugLog('Job data:', job.data)
  debugLog('Job ID:', job.id)
  debugLog('Job timestamp:', new Date(job.timestamp).toISOString())

  const tempFiles: TempFiles = {}
  const processingStart = Date.now()

  try {
    // Stage 1: Update status to processing (may already be PROCESSING from TUS handler)
    logMessage(`[WORKER] Setting video ${videoId} to PROCESSING status (if not already)`)
    await updateVideoStatus(videoId, 'PROCESSING', 0)

    // Stage 2: Download and validate video
    const videoInfo = await downloadAndValidateVideo(videoId, originalStoragePath, tempFiles)

    // Stage 3: Fetch processing settings
    const settings = await fetchProcessingSettings(projectId, videoId)

    if (settings.skipTranscoding) {
      // Skip transcoding — only extract metadata and generate thumbnail
      logMessage(`[WORKER] Skip transcoding enabled for video ${videoId}, generating thumbnail only`)

      const thumbnailPath = await processThumbnail(
        videoId,
        projectId,
        videoInfo.path,
        videoInfo.metadata.duration,
        tempFiles
      )

      // Storyboard sprite-sheet (1.0.6+) — used by the folder grid
      // for instant hover-scrub. Best-effort; null if it fails.
      const storyboardPath = await processStoryboard(
        videoId,
        projectId,
        videoInfo.path,
        videoInfo.metadata.duration,
        tempFiles
      )

      // Finalize without preview path — original file is served directly
      await finalizeVideo(
        videoId,
        '', // No preview path
        thumbnailPath,
        videoInfo.metadata,
        settings.resolution,
        storyboardPath
      )
    } else {
      // Phase A 1.9.4+: progressive multi-tier transcoding.
      //
      // 720p ships first → status flips to READY → user can watch
      // immediately. 1080p (and 2160p if applicable) keep cooking
      // in the same job; their preview*Path columns + progress are
      // bumped as they finish. Player picks the highest-quality
      // column present at watch time.
      const tiers = computeProgressiveTiers(videoInfo.metadata, settings.resolution)
      logMessage(
        `[WORKER] Video ${videoId} progressive tiers: ${tiers.map(t => t.tier).join(' → ')}`,
      )

      // 1.9.4+ Phase A: progressive preset ladder. LUT is OFF
      // for every tier (the color-calibration filter ran at
      // INPUT resolution before the downscale — major CPU sink
      // for benefit the typical reviewer never asked for; the
      // per-project flag can still override).
      //
      //   - 480p (first tier): `ultrafast` x264 preset — pure
      //     speed, lands in ~1-2 minutes so the user can start
      //     watching.
      //   - Intermediate tiers (everything except the last):
      //     `superfast` preset — fast iteration so the Quality
      //     menu fills in quickly.
      //   - LAST tier (the user's target quality cap): default
      //     preset (auto-selected from the CPU config) for
      //     better compression on the archival deliverable.

      // ────────────────────────────────────────────────────────
      // FIRST TIER — synchronous, drives status=READY.
      // ────────────────────────────────────────────────────────
      const firstTier = tiers[0]
      let firstPreviewPath: string
      try {
        firstPreviewPath = await processPreview(
          videoId,
          projectId,
          videoInfo.path,
          firstTier.dimensions,
          { ...settings, resolution: firstTier.tier, applyLut: settings.applyLut },
          tempFiles,
          videoInfo.metadata.duration,
          'ultrafast',
        )
      } catch (err: any) {
        if (err?.message === 'TranscodeAborted') {
          logMessage(
            `[WORKER] Video ${videoId} processing aborted at ${firstTier.tier} (row deleted)`,
          )
          return
        }
        throw err
      }

      // Thumbnail in critical path so the folder grid + player
      // are fully populated the moment status flips to READY.
      // Instant-thumbnail in the upload route already wrote one
      // to this path; this refresh just rewrites it (both pick
      // the first frame so visually identical).
      const thumbnailPath = await processThumbnail(
        videoId,
        projectId,
        videoInfo.path,
        videoInfo.metadata.duration,
        tempFiles,
      )

      await finalizeFirstTier(
        videoId,
        firstTier.tier,
        firstPreviewPath,
        thumbnailPath,
        videoInfo.metadata,
        null, // storyboard patched in below
        tiers.length,
      )

      logMessage(
        `[WORKER] Video ${videoId} READY at ${firstTier.tier} (1/${tiers.length})`,
      )

      // 1.9.4+ Phase B: kick off HLS remux for the first tier as
      // soon as MP4 is ready. Fire-and-forget so it can't block
      // the higher MP4 tiers below — HLS is additive, the MP4
      // path keeps working if HLS lags or fails.
      const firstTierMp4 = path.join(TEMP_DIR, `${videoId}-preview-${firstTier.tier}.mp4`)
      const firstHlsWork = processHlsTier(
        videoId,
        projectId,
        firstTierMp4,
        firstTier.tier,
        tempFiles,
      ).catch((err) => logMessage(`[WORKER] HLS ${firstTier.tier} background failed: ${err}`))

      // ────────────────────────────────────────────────────────
      // STORYBOARD + HIGHER TIERS — fanned out in parallel after
      // READY. The storyboard runs from the just-finished tier-0
      // preview (~50-100 MB) instead of the multi-GB master so
      // it lands in seconds. Higher tiers run concurrently with
      // each other, each ffmpeg using `threadsPerJob` threads;
      // with 2 in flight on a 12-thread box (6+6) we hit ~100%
      // CPU and finish the whole ladder in roughly the wall-
      // time of the SLOWEST tier instead of their sum.
      const tier0TempPath = path.join(
        TEMP_DIR,
        `${videoId}-preview-${firstTier.tier}.mp4`,
      )

      const storyboardWork = (async () => {
        const storyboardPath = await processStoryboard(
          videoId,
          projectId,
          tier0TempPath,
          videoInfo.metadata.duration,
          tempFiles,
        )
        if (storyboardPath) {
          try {
            await (await import('@/lib/db')).prisma.video.update({
              where: { id: videoId },
              data: { storyboardPath } as any,
            })
          } catch (err) {
            logMessage(`[WORKER] Storyboard persist failed for ${videoId}: ${err}`)
          }
        }
      })()

      // 1.9.4+ Phase B (user-requested override): launch ALL
      // higher tiers IN PARALLEL — no queue, no encoder-aware
      // serialisation. The original `getMaxParallelTranscodes()`
      // gate (libx264=2, VT/VAAPI=1) optimises wall-time on a
      // single asset by avoiding self-contention, but the user
      // explicitly prefers all tiers starting at the same moment
      // so the Quality menu fills in at roughly equal speed
      // instead of "720p done → 1080p starts → 2160p later". For
      // a 1-tier ladder this is identical; for a 3-tier ladder
      // it means three concurrent ffmpegs from the moment READY
      // flips. The kernel scheduler arbitrates from there.
      const maxParallel = Math.max(
        getMaxParallelTranscodes(),
        Math.max(0, tiers.length - 1),
      )

      const runHigherTier = async (
        t: typeof tiers[number],
        ladderIndex: number,
      ): Promise<void> => {
        const isLastTier = ladderIndex === tiers.length - 1
        const tierPreset: 'superfast' | undefined = !isLastTier ? 'superfast' : undefined
        try {
          const previewPath = await processPreview(
            videoId,
            projectId,
            videoInfo.path,
            t.dimensions,
            { ...settings, resolution: t.tier, applyLut: settings.applyLut },
            tempFiles,
            videoInfo.metadata.duration,
            tierPreset,
          )
          await finalizeAdditionalTier(
            videoId,
            t.tier,
            previewPath,
            ladderIndex,
            tiers.length,
          )
          logMessage(
            `[WORKER] Video ${videoId} ${t.tier} tier added (${ladderIndex + 1}/${tiers.length})`,
          )

          // 1.9.4+ Phase B: remux to HLS as a follow-up. Sequential
          // after this tier's MP4 (not parallel with it) so we
          // don't fight the encoder for resources; and we await
          // here so the tier "isn't done" until both MP4 and HLS
          // have landed — keeps the higher-tier pool sized
          // correctly. Soft-fail if remux blows up — the MP4 is
          // still served.
          const tierMp4Local = path.join(TEMP_DIR, `${videoId}-preview-${t.tier}.mp4`)
          try {
            await processHlsTier(videoId, projectId, tierMp4Local, t.tier, tempFiles)
          } catch (err) {
            logMessage(`[WORKER] HLS ${t.tier} background failed: ${err}`)
          }
        } catch (err: any) {
          if (err?.message === 'TranscodeAborted') {
            logMessage(`[WORKER] Video ${videoId} ${t.tier} aborted (row deleted)`)
            return
          }
          logMessage(
            `[WORKER] Video ${videoId} ${t.tier} failed: ${err?.message || err}`,
          )
        }
      }

      // Simple bounded-parallelism worker pool: spawn up to
      // `maxParallel` tier jobs, refill as each finishes. The
      // storyboard runs alongside in its own slot — it's cheap
      // and uses different code paths so it never contends with
      // the transcode pool for the same encoder.
      const higherTiers = tiers.slice(1)
      const tierJobs: Promise<void>[] = []
      const tierQueue = higherTiers.map((t, i) => ({ t, ladderIndex: i + 1 }))

      const launchNext = (): Promise<void> | null => {
        const next = tierQueue.shift()
        if (!next) return null
        return runHigherTier(next.t, next.ladderIndex).then(() => {
          const more = launchNext()
          if (more) return more
        })
      }

      for (let i = 0; i < maxParallel; i++) {
        const job = launchNext()
        if (job) tierJobs.push(job)
      }

      await Promise.allSettled([storyboardWork, ...tierJobs])
    }

    // Success!
    const totalTime = Date.now() - processingStart
    logMessage(`[WORKER] Successfully processed video ${videoId} in ${(totalTime / 1000).toFixed(2)}s`)

  } catch (error: any) {
    // 1.9.4+: TranscodeAborted means the user deleted the video
    // mid-pipeline. Don't try to mark a tombstoned row as ERROR
    // and don't rethrow — BullMQ would retry the job, which would
    // immediately fail again and spam the queue.
    if (error?.message === 'TranscodeAborted') {
      logMessage(`[WORKER] Video ${videoId} processing aborted (row deleted)`)
      return
    }
    // Same idea for raw P2025 (record not found) — if it leaked
    // out of one of the helpers without being wrapped, treat it
    // identically to a clean abort instead of letting BullMQ
    // bounce it through 3 retries.
    if (error?.code === 'P2025') {
      logMessage(`[WORKER] Video ${videoId} row not found mid-processing — skipping`)
      return
    }
    // Handle error - update database and log
    await handleProcessingError(videoId, error)
    throw error

  } finally {
    // Always cleanup temp files (success or failure)
    await cleanupTempFiles(tempFiles)
  }
}
