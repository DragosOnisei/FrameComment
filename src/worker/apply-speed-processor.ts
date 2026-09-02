import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import {
  ApplySpeedJob,
  VIDEO_JOB_PRIORITY,
  getVideoQueue,
  cancelPendingVideoJobs,
} from '../lib/queue'
import { prisma, prismaPrivileged } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { TEMP_DIR } from './cleanup'
import { getVideoBackend } from '../lib/storage-backends'
import { uploadFile, deleteFile, deleteDirectory } from '../lib/storage'
import { applySpeedToVideo, getVideoMetadata } from '../lib/ffmpeg'
import {
  atempoChainForFactor,
  isSaveableSpeedFactor,
  rescaleMsForSpeed,
  rescaleTimecodeForSpeed,
} from '../lib/video-speed'
import { isEncodeStopped, clearEncodeStopped } from '../lib/encode-cancel'
import { invalidateVideoAccessTokenCache } from '../lib/video-access'
import {
  TempFiles,
  downloadAndValidateVideo,
  cleanupTempFiles,
  handleProcessingError,
} from './video-processor-helpers'

/**
 * 7.5.0: the permanent speed rewrite — what the "Save" button next to the
 * player's speed pill actually does.
 *
 * An admin watched the video at, say, 1.15x and decided the file itself
 * should BE that fast. This job makes it true end to end:
 *
 *   1. re-encode the ORIGINAL at the factor (setpts for the picture, a
 *      pitch-preserving atempo chain for the sound) into a new master,
 *   2. swap it in — new originalStoragePath/size/duration — and, in the
 *      SAME transaction, reposition every existing comment and marker to
 *      oldTime / factor, so a note left on a frame stays on that frame
 *      (the frame now just arrives earlier),
 *   3. wipe the derived state (tiers, HLS, storyboard) and re-enter the
 *      normal prepare → encode-tier → finalize pipeline, which rebuilds
 *      every quality, the HLS rungs, the thumbnail and the sprite from the
 *      new master.
 *
 * From then on there is no trace of the old timing anywhere: the player at
 * 1x, every share link, and every download — original or any quality — is
 * the faster cut. That is exactly what the warning dialog promised.
 *
 * IDEMPOTENCY across BullMQ retries: the job carries the master path as it
 * was AT ENQUEUE TIME. The swap transaction is atomic, so a retry finds
 * either (a) the row still pointing at that path — nothing happened yet, do
 * the whole thing — or (b) a different path — the swap AND the one-shot
 * comment rescale already committed, so only the (idempotent) pipeline
 * re-enqueue can be missing. Rescaling comments twice would compound the
 * division, which is why the guard is the path and not a status flag.
 */
export async function processApplySpeed(job: Job<ApplySpeedJob>) {
  const { videoId, projectId, originalStoragePath: pathAtEnqueue, factor } = job.data
  const start = Date.now()
  logMessage(`[WORKER] apply-speed ${factor}x for ${videoId}`)

  if (!isSaveableSpeedFactor(factor)) {
    // The API validates too — this catches a hand-crafted or corrupted job.
    // Returning (not throwing) so BullMQ doesn't retry a job that can never
    // become valid; the row is put back to READY untouched.
    logError(`[WORKER] apply-speed ${videoId}: refusing unknown factor ${factor}`)
    await prisma.video
      .update({ where: { id: videoId }, data: { status: 'READY' } })
      .catch(() => {})
    return
  }

  const tempFiles: TempFiles = {}
  const speedOutPath = path.join(TEMP_DIR, `${videoId}-speed.mp4`)

  try {
    const video = (await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        projectId: true,
        originalStoragePath: true,
        originalFileName: true,
        storageBackend: true,
        mediaType: true,
        fps: true,
        duration: true,
        deletedAt: true,
        thumbnailPath: true,
      } as any,
    })) as any
    if (!video || video.deletedAt) {
      logMessage(`[WORKER] apply-speed ${videoId}: row gone/trashed — skipping`)
      return
    }
    if (video.mediaType !== 'VIDEO') {
      logMessage(`[WORKER] apply-speed ${videoId}: not a VIDEO — skipping`)
      await prisma.video
        .update({ where: { id: videoId }, data: { status: 'READY' } })
        .catch(() => {})
      return
    }

    const queue = getVideoQueue()
    const backend = await getVideoBackend(videoId)

    // ─── Retry guard ─────────────────────────────────────────────────
    // A previous attempt already swapped the master (and rescaled the
    // comments — atomically, same transaction). All that can be missing
    // is the pipeline re-entry, which is idempotent. The /tmp cache may
    // still hold the OLD master's bytes, and prepare-video would happily
    // reuse... nothing: it re-downloads unconditionally. The unlink is
    // pure belt-and-suspenders for anything else that trusts the cache.
    if (video.originalStoragePath !== pathAtEnqueue) {
      logMessage(
        `[WORKER] apply-speed ${videoId}: master already swapped by an earlier attempt — re-entering the pipeline only`,
      )
      fs.promises.unlink(path.join(TEMP_DIR, `${videoId}-original`)).catch(() => {})
      await cancelPendingVideoJobs(videoId)
      await clearEncodeStopped(videoId)
      await queue.add(
        'prepare-video',
        { videoId, originalStoragePath: video.originalStoragePath, projectId },
        { priority: VIDEO_JOB_PRIORITY.PREPARE, jobId: `prepare-${videoId}` },
      )
      return
    }

    // ─── 1. Transform the master ─────────────────────────────────────
    // downloadAndValidateVideo re-validates magic bytes + probes — the
    // same trust boundary every other ffmpeg entry point goes through.
    const videoInfo = await downloadAndValidateVideo(videoId, pathAtEnqueue, tempFiles, backend)
    // The fps the stored timecodes were WRITTEN against. The rewrite pins
    // the same rate, so this is also the new file's frame language.
    const fps: number = video.fps || videoInfo.metadata.fps || 24

    tempFiles.preview = speedOutPath // registered so cleanup sweeps it
    const abort = new AbortController()
    let lastPoll = 0
    await applySpeedToVideo({
      inputPath: videoInfo.path,
      outputPath: speedOutPath,
      factor,
      fps: videoInfo.metadata.fps ?? video.fps,
      atempoChain: atempoChainForFactor(factor),
      signal: abort.signal,
      onProgress: async (p) => {
        const now = Date.now()
        if (now - lastPoll < 3000 || abort.signal.aborted) return
        lastPoll = now
        try {
          // Stop button + deleted-row detection on the same throttled tick
          // (the update throws TranscodeAborted on P2025), mirroring the
          // tier pipeline. Progress maps to 0–90: the remaining tail
          // belongs to upload + the re-encode pipeline that follows.
          if (await isEncodeStopped(videoId)) {
            abort.abort()
            return
          }
          await prisma.video.update({
            where: { id: videoId },
            data: { processingProgress: Math.min(90, Math.round(p * 90)) },
          })
        } catch (err: any) {
          if (err?.code === 'P2025') abort.abort()
        }
      },
    })

    // ─── Sanity gate ─────────────────────────────────────────────────
    // The new master must be `factor` times shorter, within half a second
    // or 2%. If it is not, something in the filter graph lied — refuse to
    // swap; the video keeps playing at its old speed and the row says why.
    const newMeta = await getVideoMetadata(speedOutPath)
    const expectedDuration = videoInfo.metadata.duration / factor
    const tolerance = Math.max(0.5, expectedDuration * 0.02)
    if (
      !(newMeta.duration > 0) ||
      Math.abs(newMeta.duration - expectedDuration) > tolerance
    ) {
      throw new Error(
        `speed rewrite produced ${newMeta.duration.toFixed(2)}s, expected ~${expectedDuration.toFixed(2)}s (source ${videoInfo.metadata.duration.toFixed(2)}s ÷ ${factor})`,
      )
    }
    const newSize = (await fs.promises.stat(speedOutPath)).size

    // ─── 2. Upload the new master, then swap + rescale atomically ────
    // Same naming convention the upload route uses; the container is now
    // mp4, so the user-visible filename keeps its stem and changes only
    // its extension.
    const stem = (video.originalFileName as string).replace(/\.[^.]+$/, '') || 'video'
    const newFileName = `${stem}.mp4`
    const newStoragePath = `projects/${projectId}/videos/original-${Date.now()}-${newFileName}`
    await uploadFile(newStoragePath, fs.createReadStream(speedOutPath), newSize, 'video/mp4', backend)

    const comments: Array<{
      id: string
      timecode: string
      timecodeEnd: string | null
      timestampMs: number | null
    }> = await (prisma as any).comment.findMany({
      where: { videoId },
      select: { id: true, timecode: true, timecodeEnd: true, timestampMs: true },
    })
    const markers: Array<{ id: string; timestampMs: number }> = await (
      prisma as any
    ).marker.findMany({ where: { videoId }, select: { id: true, timestampMs: true } })

    await prisma.$transaction([
      prisma.video.update({
        where: { id: videoId },
        data: {
          originalStoragePath: newStoragePath,
          originalFileName: newFileName,
          originalFileSize: BigInt(newSize),
          // The new file was written to the video's ACTIVE backend only —
          // any keep-source copies of the OLD master on other backends are
          // stale bytes now, not locations of this file.
          storageLocations: null,
          duration: newMeta.duration,
          fps: newMeta.fps ?? video.fps,
          codec: newMeta.codec ?? 'h264',
          status: 'PROCESSING',
          processingProgress: 90,
          processingError: null,
          // Derived state is all old-speed: reset it the way a full
          // reprocess does and let the pipeline rebuild. hlsQualities must
          // empty out HERE — a share page mid-play would otherwise keep
          // streaming old-speed HLS rungs that claim to be current.
          preview480Path: null,
          preview720Path: null,
          preview1080Path: null,
          preview2160Path: null,
          preview480Size: null,
          preview720Size: null,
          preview1080Size: null,
          preview2160Size: null,
          cleanPreview720Path: null,
          cleanPreview1080Path: null,
          cleanPreview2160Path: null,
          hlsBasePath: null,
          hlsQualities: [],
          transcodeProgressByTier: {},
          plannedTiers: [],
          completedTiers: [],
          thumbnailPath: null,
        } as any,
      }),
      // Every note and marker keeps pointing at the same CONTENT: the
      // moment it marked now happens at oldTime / factor. Replies ride
      // along too — they carry their parent's timecode. Rescaling runs in
      // the SAME transaction as the path swap, which is what makes the
      // retry guard sound: either both happened or neither did.
      ...comments.map((c) =>
        (prisma as any).comment.update({
          where: { id: c.id },
          data: {
            timecode: rescaleTimecodeForSpeed(c.timecode, factor, fps),
            ...(c.timecodeEnd
              ? { timecodeEnd: rescaleTimecodeForSpeed(c.timecodeEnd, factor, fps) }
              : {}),
            ...(c.timestampMs != null
              ? { timestampMs: rescaleMsForSpeed(c.timestampMs, factor) }
              : {}),
          },
        }),
      ),
      ...markers.map((m) =>
        (prisma as any).marker.update({
          where: { id: m.id },
          data: { timestampMs: rescaleMsForSpeed(m.timestampMs, factor) },
        }),
      ),
    ])

    logMessage(
      `[WORKER] apply-speed ${videoId}: master swapped (${factor}x, ${videoInfo.metadata.duration.toFixed(1)}s → ${newMeta.duration.toFixed(1)}s), ` +
        `${comments.length} comments + ${markers.length} markers repositioned`,
    )

    // ─── 3. Old files + pipeline re-entry ────────────────────────────
    // The old master goes only when no other row references it (Duplicate
    // copies bytes since it exists, but a pre-4.x row pair is cheap to
    // rule out). Privileged count on purpose: a path collision across
    // tenants must also block the delete.
    const othersOnOldPath = await (prismaPrivileged as any).video.count({
      where: { originalStoragePath: pathAtEnqueue },
    })
    if (othersOnOldPath === 0) {
      await deleteFile(pathAtEnqueue, backend).catch((err) =>
        logError(`[WORKER] apply-speed ${videoId}: old master delete failed:`, err),
      )
    } else {
      logMessage(
        `[WORKER] apply-speed ${videoId}: old master kept — ${othersOnOldPath} other row(s) reference it`,
      )
    }
    // The old tier files' paths travel in the job — the API nulled them on
    // the row at request time so nothing old-speed could play mid-rewrite.
    const oldDerived = [
      ...(job.data.oldPreviewPaths ?? []),
      video.thumbnailPath,
    ].filter(Boolean) as string[]
    await Promise.allSettled(oldDerived.map((f) => deleteFile(f, backend)))
    if (job.data.oldHlsBasePath) {
      await deleteDirectory(job.data.oldHlsBasePath, backend).catch(() => {})
    }

    // Stale-cache hygiene: prepare-video re-downloads unconditionally, so
    // this unlink is defensive; see the retry-guard note above.
    await fs.promises.unlink(path.join(TEMP_DIR, `${videoId}-original`)).catch(() => {})

    // The OTHER stale cache — the decisive one. Minted access tokens are
    // reused per (session, video, quality), so without this the page would
    // re-tokenize after the rewrite, get the SAME token, hit the SAME URLs,
    // and the browser would replay the old-speed bytes from HTTP cache
    // (segments are served immutable). Wiping the mint-cache makes every
    // client mint fresh tokens → fresh URLs → the new bytes, everywhere.
    try {
      const dropped = await invalidateVideoAccessTokenCache(videoId)
      logMessage(`[WORKER] apply-speed ${videoId}: invalidated ${dropped} cached access token(s)`)
    } catch (err) {
      // Non-fatal for the rewrite itself, but it WILL resurface as "plays
      // at the old speed" for anyone with warm caches — say so loudly.
      logError(`[WORKER] apply-speed ${videoId}: token cache invalidation FAILED — viewers may replay stale bytes until tokens expire:`, err)
    }

    // Clear any completed jobs still holding the deterministic jobIds
    // (BullMQ keeps them an hour and silently swallows a re-add with the
    // same id — a video sped up right after uploading would otherwise
    // never re-encode), then re-enter the pipeline.
    await cancelPendingVideoJobs(videoId)
    await clearEncodeStopped(videoId)
    await queue.add(
      'prepare-video',
      { videoId, originalStoragePath: newStoragePath, projectId },
      { priority: VIDEO_JOB_PRIORITY.PREPARE, jobId: `prepare-${videoId}` },
    )

    await cleanupTempFiles(tempFiles)
    logMessage(
      `[WORKER] apply-speed for ${videoId} done in ${((Date.now() - start) / 1000).toFixed(2)}s — pipeline re-entered`,
    )
  } catch (error: any) {
    if (error?.message === 'TranscodeAborted') {
      logMessage(`[WORKER] apply-speed ${videoId} aborted (row deleted or encode stopped)`)
      await cleanupTempFiles(tempFiles).catch(() => {})
      await fs.promises.unlink(speedOutPath).catch(() => {})
      return
    }
    if (error?.code === 'P2025') {
      logMessage(`[WORKER] apply-speed ${videoId} row not found — skipping`)
      await cleanupTempFiles(tempFiles).catch(() => {})
      return
    }
    // Sets status ERROR + processingError so the UI says what happened.
    await handleProcessingError(videoId, error)
    await cleanupTempFiles(tempFiles).catch(() => {})
    await fs.promises.unlink(speedOutPath).catch(() => {})
    // The master was NOT swapped on any throwing path before the
    // transaction — but the API already unhooked the old tiers so nothing
    // stale could play. Rebuild them from the untouched old master, so a
    // failed rewrite leaves the video exactly as it was (at its old speed)
    // instead of unplayable. attempts:1 on this job means no concurrent
    // retry can race the rebuild.
    try {
      const row = (await prisma.video.findUnique({
        where: { id: videoId },
        select: { originalStoragePath: true, deletedAt: true } as any,
      })) as any
      if (row && !row.deletedAt) {
        await cancelPendingVideoJobs(videoId)
        await clearEncodeStopped(videoId)
        await getVideoQueue().add(
          'prepare-video',
          { videoId, originalStoragePath: row.originalStoragePath, projectId },
          { priority: VIDEO_JOB_PRIORITY.PREPARE, jobId: `prepare-${videoId}` },
        )
        logMessage(
          `[WORKER] apply-speed ${videoId}: rewrite failed — rebuilding tiers from the untouched master so the video stays usable`,
        )
      }
    } catch (restoreErr) {
      logError(`[WORKER] apply-speed ${videoId}: restore enqueue failed:`, restoreErr)
    }
    throw error
  }
}
