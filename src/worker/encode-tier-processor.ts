import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { EncodeTierJob } from '../lib/queue'
import { prisma } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { downloadFile } from '../lib/storage'
import { rewriteHlsMaster } from '../lib/ffmpeg'
import { TEMP_DIR } from './cleanup'
import {
  TempFiles,
  ProcessingSettings,
  fetchProcessingSettings,
  calculateOutputDimensions,
  processPreview,
  processHlsTier,
  handleProcessingError,
  debugLog,
} from './video-processor-helpers'
import { getVideoMetadata, VideoMetadata } from '../lib/ffmpeg'

/**
 * 2.2.0+ Stage 2: encode ONE quality tier for ONE video.
 *
 * Each invocation runs at its tier's priority:
 *   480p → 10, 720p → 50, 1080p → 100, 2160p → 200
 *
 * The breadth-first invariant relies on the priority gap: a single
 * 1080p (100) will never run before any pending 480p (10), so on a
 * bulk upload the queue strictly walks the ladder from the bottom
 * up across ALL videos before climbing.
 *
 * Source-file caching: prepare-video left the original at
 * `/tmp/framecomment/<videoId>-original`. We expect it to be there
 * on the happy path. If it isn't (worker restarted between prepare
 * and encode, or /tmp got nuked by an aggressive sweeper), we
 * re-download — slower but correct.
 *
 * On success this job:
 *   1. Encodes the requested tier (calls transcodeVideo via
 *      processPreview — auto-fallback to libx264 if the HW encoder
 *      blows up at runtime is preserved from 2.1.9).
 *   2. Writes preview<tier>Path on the Video row.
 *   3. Appends `tier` to `completedTiers`.
 *   4. If this is the FIRST completed tier (lowest), flips
 *      status=READY so the player can start serving the file.
 *   5. Remuxes to HLS + atomically updates the master manifest
 *      via `rewriteHlsMaster` (which holds a per-videoId in-process
 *      mutex so two parallel tiers don't lose a write).
 *
 * Cancel semantics (deletion mid-encode):
 *   - The processPreview helper aborts the ffmpeg if its DB write
 *     hits P2025, then throws TranscodeAborted (preserved from 2.1.x).
 *   - This handler treats TranscodeAborted as a clean return; the
 *     OTHER pending encode-tier jobs for the same videoId are
 *     cleaned up by the video delete endpoint, which uses
 *     `Queue.removeJobs()` keyed on the jobId pattern
 *     `encode-<videoId>-*` (see callers).
 */
export async function processEncodeTier(job: Job<EncodeTierJob>) {
  const { videoId, projectId, originalStoragePath, tier } = job.data

  logMessage(`[WORKER] encode-tier ${tier} for ${videoId}`)
  debugLog('Encode-tier job data:', job.data)

  const tempFiles: TempFiles = {}
  const start = Date.now()

  try {
    // Cheap early-exit: if the row is already gone, skip out before
    // re-downloading or transcoding anything.
    const existing = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        plannedTiers: true,
        completedTiers: true,
      } as any,
    }) as any
    if (!existing) {
      logMessage(`[WORKER] encode-tier ${tier} for ${videoId}: row gone, skipping`)
      return
    }

    // Idempotency: if the tier already shows up in completedTiers
    // (job retried after a transient post-encode DB error, say), no
    // need to re-encode.
    const alreadyDone: string[] = Array.isArray(existing.completedTiers)
      ? existing.completedTiers
      : []
    if (alreadyDone.includes(tier)) {
      logMessage(`[WORKER] encode-tier ${tier} for ${videoId} already completed, skipping`)
      return
    }

    // Ensure the cached original is on /tmp; re-download if not.
    const cachedOriginal = path.join(TEMP_DIR, `${videoId}-original`)
    if (!fs.existsSync(cachedOriginal)) {
      logMessage(`[WORKER] encode-tier ${tier} for ${videoId}: cached original missing, re-downloading`)
      const stream = await downloadFile(originalStoragePath)
      await pipeline(stream, fs.createWriteStream(cachedOriginal))
    }
    tempFiles.input = cachedOriginal // tracked for sweeper but not unlinked here

    // We need source metadata to compute output dimensions. Probing
    // here adds a few hundred ms — acceptable for the per-tier job,
    // and keeps each encode-tier job stateless w.r.t. metadata so it
    // can run in any order on any worker.
    const metadata: VideoMetadata = await getVideoMetadata(cachedOriginal)
    const dimensions = calculateOutputDimensions(metadata, tier)

    const settings: ProcessingSettings = await fetchProcessingSettings(projectId, videoId)

    // Preset per tier — matches 2.1.x ladder behaviour:
    //   - 480p → ultrafast (time-to-first-playable)
    //   - intermediate tiers → superfast (fast iteration)
    //   - top tier → default (auto from CPU config)
    const plannedTiers: string[] = Array.isArray(existing.plannedTiers)
      ? existing.plannedTiers
      : []
    const isFirstTier = plannedTiers.length > 0 && plannedTiers[0] === tier
    const isLastTier = plannedTiers.length > 0 && plannedTiers[plannedTiers.length - 1] === tier
    const tierPreset: 'ultrafast' | 'superfast' | undefined = isFirstTier
      ? 'ultrafast'
      : isLastTier
        ? undefined
        : 'superfast'

    let previewPath: string
    try {
      previewPath = await processPreview(
        videoId,
        projectId,
        cachedOriginal,
        dimensions,
        { ...settings, resolution: tier, applyLut: settings.applyLut },
        tempFiles,
        metadata.duration,
        tierPreset,
      )
    } catch (err: any) {
      if (err?.message === 'TranscodeAborted') {
        logMessage(`[WORKER] encode-tier ${tier} for ${videoId} aborted (row deleted mid-encode)`)
        return
      }
      throw err
    }

    // ─── DB write: append tier + maybe flip READY ──────────────────
    // Read-modify-write with a fresh fetch (we may have raced with
    // another tier's append). Postgres serialises at the row level
    // so two concurrent UPDATEs on the same row can't lose data, but
    // we still need to base our new array on the CURRENT value, not
    // the snapshot we read at job-start.
    const refreshed = (await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        status: true,
        completedTiers: true,
        plannedTiers: true,
      } as any,
    })) as any
    if (!refreshed) {
      logMessage(`[WORKER] encode-tier ${tier} for ${videoId}: row deleted during encode, skipping DB write`)
      return
    }
    const completedSet = new Set<string>(
      Array.isArray(refreshed.completedTiers) ? refreshed.completedTiers : [],
    )
    completedSet.add(tier)
    const completedArr = Array.from(completedSet)

    // Coarse processingProgress for the dashboard chip — fraction of
    // tiers landed out of the planned total. Capped at 99 unless
    // finalize-video runs (which only happens once every tier is in).
    const refreshedPlanned: string[] = Array.isArray(refreshed.plannedTiers)
      ? refreshed.plannedTiers
      : plannedTiers
    const progressPct = refreshedPlanned.length > 0
      ? Math.min(99, Math.round((completedArr.length / refreshedPlanned.length) * 100))
      : 99

    // First tier landing = the row should flip to READY so the
    // player can start serving the file. We compute "first" as
    // "completedTiers transitioned from empty → 1 entry" because
    // that's the safest semantic — strict equality with
    // plannedTiers[0] could miss the flip if 480p somehow failed
    // and 720p landed first.
    const shouldFlipReady =
      refreshed.status !== 'READY' && completedArr.length === 1

    const updateData: any = {
      processingProgress: progressPct,
      completedTiers: completedArr,
    }
    if (tier === '480p') updateData.preview480Path = previewPath
    else if (tier === '720p') updateData.preview720Path = previewPath
    else if (tier === '1080p') updateData.preview1080Path = previewPath
    else if (tier === '2160p') updateData.preview2160Path = previewPath

    if (shouldFlipReady) {
      updateData.status = 'READY'
      logMessage(`[WORKER] encode-tier ${tier} for ${videoId}: first tier — flipping to READY`)
    }

    try {
      await prisma.video.update({ where: { id: videoId }, data: updateData })
    } catch (err: any) {
      if (err?.code === 'P2025') {
        logMessage(`[WORKER] encode-tier ${tier} for ${videoId}: row deleted before persist`)
        return
      }
      throw err
    }

    // Nail this tier's per-tier progress to 100 so the Quality menu
    // stops showing a frozen mid-percentage. Same pattern as the
    // old finalizeAdditionalTier helper.
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Video" SET "transcodeProgressByTier" = jsonb_set(COALESCE("transcodeProgressByTier", '{}'::jsonb), $1::text[], to_jsonb(100::int), true) WHERE "id" = $2`,
        `{${tier}}`,
        videoId,
      )
    } catch (err) {
      logError(`[WORKER] transcodeProgressByTier finalize failed for ${videoId} ${tier}:`, err)
    }

    // ─── HLS remux + atomic master rewrite ─────────────────────────
    // We remux to HLS so the streaming player can pick up the new
    // tier. The helper handles uploads + DB writes for hlsBasePath
    // / hlsQualities; we follow up with `rewriteHlsMaster` which
    // guarantees the in-process per-videoId mutex catches concurrent
    // tier finishes. (processHlsTier itself already touches the same
    // columns; the second call is idempotent — both add the tier to
    // a Set before writing.)
    const tierMp4Local = path.join(TEMP_DIR, `${videoId}-preview-${tier}.mp4`)
    try {
      await processHlsTier(videoId, projectId, tierMp4Local, tier, tempFiles)
      await rewriteHlsMaster(
        videoId,
        tier,
        `projects/${projectId}/videos/${videoId}/hls`,
      )
    } catch (err) {
      // Soft fail — MP4 path still works without HLS, the next tier
      // (or a reprocess) can refresh the manifest.
      logError(`[WORKER] HLS ${tier} for ${videoId} failed (non-fatal):`, err)
    }

    // Cleanup the tier preview's local temp file. Leave the cached
    // original alone — other tiers still need it; finalize-video
    // will unlink it once the ladder is complete.
    try {
      if (fs.existsSync(tierMp4Local)) fs.unlinkSync(tierMp4Local)
    } catch (err) {
      logError(`[WORKER] Failed to unlink ${tierMp4Local}:`, err)
    }

    logMessage(
      `[WORKER] encode-tier ${tier} for ${videoId} done in ${((Date.now() - start) / 1000).toFixed(2)}s ` +
        `(${completedArr.length}/${refreshedPlanned.length} tiers)`,
    )
  } catch (error: any) {
    if (error?.message === 'TranscodeAborted') {
      logMessage(`[WORKER] encode-tier ${tier} for ${videoId} aborted (row deleted)`)
      return
    }
    if (error?.code === 'P2025') {
      logMessage(`[WORKER] encode-tier ${tier} for ${videoId} row not found — skipping`)
      return
    }
    await handleProcessingError(videoId, error)
    throw error
  }
}
