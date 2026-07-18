import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { EncodeTierJob, getVideoQueue } from '../lib/queue'
import { prisma } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { downloadFile, getLocalSourcePath } from '../lib/storage'
import { getVideoBackend } from '../lib/storage-backends'
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

  // 2.2.9+: 480p EXCLUSIVE GATE.
  //
  // The user's mental model is: "give me the 480p preview as fast
  // as possible, then go wild on the higher tiers in parallel."
  // The breadth-first priority gap (10 vs 50 vs 100 vs 200) only
  // helps when BullMQ has to PICK between waiting jobs; it does
  // NOT prevent a non-480p from starting while a 480p is mid-
  // encode in a sibling worker slot.
  //
  // 2.2.10 (this fix): replace the "defer-by-re-enqueue-with-1s-delay"
  // version of the gate with a clean intra-processor await loop.
  // The old shape produced multi-second log spam (a deferred 720p
  // would wake, defer itself again, wake, defer again, …) and
  // every wake-up still occupied a worker slot for the duration of
  // the BullMQ pick-and-process cycle. The new shape is:
  //
  //   - When a non-480p job runs and sees ANY 480p still pending
  //     (active OR waiting), it `await`s a 250ms sleep loop right
  //     here in the processor.
  //   - The worker slot stays on this single Job for the entire
  //     wait — it doesn't get spammed back into the queue.
  //   - When the last 480p finishes, the next loop iteration sees
  //     no 480p remaining and falls through, and the encode starts
  //     within ~250ms.
  //
  // The slot IS occupied while we wait, but in this codebase
  // BullMQ priority puts 480p (priority 10) ahead of every
  // non-480p (50/100/200), so if there's something more useful to
  // run, BullMQ never picks the non-480p tier in the first place.
  // The only time we reach this gate is when BullMQ already chose
  // to give the slot to a non-480p job — i.e. there's literally
  // no other 480p work to assign to it, and waiting is exactly
  // what we want.
  if (tier !== '480p') {
    let waited = 0
    while (true) {
      let has480pPending = false
      try {
        const queue = getVideoQueue()
        const [active, waiting] = await Promise.all([
          queue.getActive(0, 200),
          queue.getWaiting(0, 200),
        ])
        has480pPending = [...active, ...waiting].some((j) => {
          if (j.name !== 'encode-tier') return false
          if (j.id === job.id) return false
          return (j.data as any)?.tier === '480p'
        })
      } catch (err) {
        // Transient Redis blip — don't block the encode forever.
        // Bail out of the wait loop and proceed; worst case we get
        // a brief race with a sibling 480p, which is the pre-2.2.9
        // behaviour, not a regression.
        logError(
          `[WORKER] 480p drain check failed for ${videoId} ${tier} — proceeding`,
          err,
        )
        break
      }
      if (!has480pPending) break
      // First time we notice we have to wait, log it ONCE. Don't
      // log every tick (the old code logged every 1s and made the
      // worker output unreadable on a single multi-tier upload).
      if (waited === 0) {
        logMessage(
          `[WORKER] holding ${tier} for ${videoId} — waiting for 480p to drain`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      waited += 250
    }
    if (waited > 0) {
      logMessage(
        `[WORKER] resuming ${tier} for ${videoId} after ${(waited / 1000).toFixed(2)}s 480p wait`,
      )
    }
  }

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

    // 3.1.0+: Resolve the SOURCE FILE PATH that ffmpeg will read from.
    //
    // Local mode (TrueNAS / single-host Docker): read DIRECTLY from
    // STORAGE_ROOT — getLocalSourcePath() validates and returns the
    // absolute on-disk path. Zero copy, zero /tmp pressure, instant
    // job start. A 16 GB 4K master used to be copied into /tmp once
    // per tier (480p/720p/1080p/2160p = 64 GB of I/O); we now read
    // it in place.
    //
    // S3 mode: we still have to land it on disk first because ffmpeg
    // can't seek inside an HTTP response body. The legacy
    // download-to-/tmp path is preserved as the fallback, with the
    // same "is it already cached?" check it had before.
    // 4.2.0+: resolve the video's storage backend so local files are read in
    // place and remote (fc/r2/aws) originals are streamed down / tiers pushed
    // to the same backend.
    const backend = await getVideoBackend(videoId)

    let sourcePath: string
    const localSource = getLocalSourcePath(originalStoragePath, backend)
    if (localSource) {
      sourcePath = localSource
      // Intentionally NOT setting tempFiles.input — we don't own the
      // file and we sure don't want the temp sweeper unlinking the
      // upload volume's original.
    } else {
      const cachedOriginal = path.join(TEMP_DIR, `${videoId}-original`)
      if (!fs.existsSync(cachedOriginal)) {
        logMessage(`[WORKER] encode-tier ${tier} for ${videoId}: cached original missing, re-downloading`)
        const stream = await downloadFile(originalStoragePath, backend)
        await pipeline(stream, fs.createWriteStream(cachedOriginal))
      }
      sourcePath = cachedOriginal
      tempFiles.input = cachedOriginal // tracked for sweeper but not unlinked here
    }

    // We need source metadata to compute output dimensions. Probing
    // here adds a few hundred ms — acceptable for the per-tier job,
    // and keeps each encode-tier job stateless w.r.t. metadata so it
    // can run in any order on any worker.
    const metadata: VideoMetadata = await getVideoMetadata(sourcePath)
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
        sourcePath,
        dimensions,
        { ...settings, resolution: tier, applyLut: settings.applyLut },
        tempFiles,
        metadata.duration,
        tierPreset,
        backend,
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
      await processHlsTier(videoId, projectId, tierMp4Local, tier, tempFiles, backend)
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

    // 2.2.10+ (note): we used to promote delayed non-480p jobs at
    // the end of every 480p run, because the gate's defer model
    // left them sleeping in BullMQ's `delayed` set. The gate now
    // uses an in-processor await loop instead (see top of file),
    // so non-480p jobs never go into `delayed` in the first place
    // — they just await right where they were picked. The wait
    // breaks out of its own accord the next time this 480p
    // finishes and the queue check returns false. No promote
    // sweep needed.
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
