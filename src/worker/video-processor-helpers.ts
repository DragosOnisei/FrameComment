import { prisma } from '../lib/db'
import { downloadFile, uploadFile, getLocalSourcePath } from '../lib/storage'
import { transcodeVideo, generateThumbnail, generateStoryboard, getVideoMetadata, remuxToHls, VideoMetadata } from '../lib/ffmpeg'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { TEMP_DIR } from './cleanup'
import { logError, logMessage } from '../lib/logging'

const DEBUG = process.env.DEBUG_WORKER === 'true'

// Constants (no more magic numbers!)
// 1.9.4+ Phase A: added 480p as the fastest progressive tier.
// 854x480 horizontal (~16:9, half the pixels of 720p) means
// ~2-3× faster encode → much earlier time-to-first-playable.
export const RESOLUTION_PRESETS = {
  '480p': { horizontal: { width: 854, height: 480 }, verticalWidth: 480 },
  '720p': { horizontal: { width: 1280, height: 720 }, verticalWidth: 720 },
  '1080p': { horizontal: { width: 1920, height: 1080 }, verticalWidth: 1080 },
  '2160p': { horizontal: { width: 3840, height: 2160 }, verticalWidth: 2160 }
} as const

export const THUMBNAIL_CONFIG = {
  // 1.5.x+: always grab the very first frame of the clip
  // (`-ss 0`). The previous "10% into the video, clamped to 0.5–
  // 10 s" formula produced inconsistent results — short clips
  // (typical 9:16 phone exports) landed near 0.5 s and *looked*
  // like the first frame, while longer 16:9 clips ended up at
  // exactly 10 s, which for talking-head / b-roll content is
  // often a totally different scene than the opening shot. Users
  // expect "the thumbnail = the first frame they'd see if they
  // hit play", so we honour that literally for every clip.
  percentage: 0,    // 0% into video (first frame)
  min: 0,           // No floor — first frame is fine
  max: 0            // No ceiling — first frame is fine
} as const

export const PROGRESS_WEIGHTS = {
  transcode: 0.8,   // Transcoding is 80% of total progress
  thumbnail: 0.2    // Thumbnail is remaining 20%
} as const

export const VALID_VIDEO_TYPES = [
  'video/mp4',
  // 3.2.x: `video/x-m4v` is Apple's M4V — an MPEG-4 container that
  // `file-type` reports separately from `video/mp4`. Plenty of normal
  // exports (QuickTime, iTunes, some cameras/editors) land here even
  // when the file is named `.mp4`. ffmpeg treats it identically to
  // mp4, so it was being rejected at magic-byte validation for no
  // good reason — the upload succeeded but prepare-video threw
  // "File content does not match a valid video format. Detected:
  // video/x-m4v" and no tiers ever encoded.
  'video/x-m4v',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
  'video/avi',
  'video/x-ms-wmv',
  'video/mpeg'
] as const

// Types
export interface TempFiles {
  input?: string
  preview?: string
  thumbnail?: string
  storyboard?: string
}

export interface ProcessingSettings {
  resolution: string
  skipTranscoding: boolean
  watermarkText?: string
  watermarkPositions?: string
  watermarkOpacity?: number
  watermarkFontSize?: string
  applyLut: boolean
}

export interface VideoInfo {
  path: string
  metadata: VideoMetadata
  fileSize: number
}

export interface OutputDimensions {
  width: number
  height: number
}

// Debug logging helper
export function debugLog(message: string, data?: any) {
  if (!DEBUG) return

  if (data !== undefined) {
    logMessage(`[WORKER DEBUG] ${message}`, data)
  } else {
    logMessage(`[WORKER DEBUG] ${message}`)
  }
}

/**
 * Download video from storage and validate content
 */
export async function downloadAndValidateVideo(
  videoId: string,
  storagePath: string,
  tempFiles: TempFiles
): Promise<VideoInfo> {
  debugLog('Starting download and validation...')

  // 3.1.0+: Try to use the source file directly from STORAGE_ROOT
  // (local mode). For local storage this turns the entire "download
  // original to /tmp" step into a no-op — magic-byte validation and
  // ffprobe both work fine on the upload volume directly.
  //
  // If the resolver returns null (S3 mode, or file missing), we fall
  // through to the legacy download-to-/tmp path. In that case we
  // still set tempFiles.input so cleanupTempFiles() can unlink it.
  let tempInputPath: string
  const localSource = getLocalSourcePath(storagePath)
  if (localSource) {
    tempInputPath = localSource
    // Intentionally do NOT set tempFiles.input — this is the upload
    // volume's original, not ours to delete.
    debugLog('Using source directly from STORAGE_ROOT:', localSource)
    logMessage(`[WORKER] Source for video ${videoId} read directly from storage volume (no /tmp copy)`)
  } else {
    tempInputPath = path.join(TEMP_DIR, `${videoId}-original`)
    tempFiles.input = tempInputPath

    debugLog('Downloading from:', storagePath)
    debugLog('Temp path:', tempInputPath)

    const downloadStart = Date.now()
    const downloadStream = await downloadFile(storagePath)
    await pipeline(downloadStream, fs.createWriteStream(tempInputPath))
    const downloadTime = Date.now() - downloadStart

    logMessage(`[WORKER] Downloaded original file for video ${videoId} in ${(downloadTime / 1000).toFixed(2)}s`)

    // 3.1.1+: download-speed debug log MUST stay inside the else
    // branch — `downloadTime` is only meaningful when we actually
    // streamed bytes off storage. The local-source path doesn't
    // download at all, so this metric doesn't apply. The original
    // 3.1.0 refactor left this debugLog at the outer scope by
    // accident, which threw "downloadTime is not defined" on every
    // local-mode prepare-video job and bricked the queue with 1000+
    // failed jobs before anyone noticed.
    const fileSizeForSpeed = fs.statSync(tempInputPath).size
    debugLog('Download speed:', (fileSizeForSpeed / 1024 / 1024 / (downloadTime / 1000)).toFixed(2) + ' MB/s')
  }

  // Verify file exists and has content
  const stats = fs.statSync(tempInputPath)
  if (stats.size === 0) {
    throw new Error('Downloaded file is empty')
  }

  const fileSize = stats.size
  logMessage(`[WORKER] Downloaded file size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`)

  debugLog('File verification passed')

  // Validate file content (magic bytes)
  debugLog('Validating magic bytes...')

  const { fileTypeFromFile } = await import('file-type')
  const fileType = await fileTypeFromFile(tempInputPath)
  if (!fileType) {
    throw new Error('Could not determine file type from content')
  }

  if (!VALID_VIDEO_TYPES.includes(fileType.mime as any)) {
    throw new Error(`File content does not match a valid video format. Detected: ${fileType.mime}`)
  }

  logMessage(`[WORKER] Magic byte validation passed - detected type: ${fileType.mime}`)
  debugLog('File is a valid video format')

  // Get video metadata
  debugLog('Extracting video metadata...')

  const metadataStart = Date.now()
  const metadata = await getVideoMetadata(tempInputPath)
  const metadataTime = Date.now() - metadataStart

  logMessage(`[WORKER] Video metadata:`, metadata)
  debugLog('Metadata extraction took:', (metadataTime / 1000).toFixed(2) + ' s')

  return {
    path: tempInputPath,
    metadata,
    fileSize
  }
}

/**
 * Fetch project and video settings for processing
 */
export async function fetchProcessingSettings(
  projectId: string,
  videoId: string
): Promise<ProcessingSettings> {
  debugLog('Fetching processing settings...')

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      previewResolution: true,
      skipTranscoding: true,
      watermarkEnabled: true,
      watermarkText: true,
      watermarkPositions: true,
      watermarkOpacity: true,
      watermarkFontSize: true,
      applyPreviewLut: true,
    },
  })

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { versionLabel: true },
  })

  debugLog('Project settings:', {
    title: project?.title,
    resolution: project?.previewResolution,
    watermarkEnabled: project?.watermarkEnabled
  })

  // 1.0.8+: watermark feature removed app-wide. We always pass
  // `watermarkText: undefined` so the FFmpeg drawtext filter is
  // skipped. The legacy `project.watermarkEnabled` column stays in
  // the schema for backward compat but is no longer consulted.
  const watermarkText = undefined

  debugLog('Final watermark text:', '(disabled in 1.0.8+)')

  return {
    resolution: project?.previewResolution || '720p',
    skipTranscoding: project?.skipTranscoding ?? false,
    watermarkText,
    watermarkPositions: project?.watermarkPositions || 'center',
    watermarkOpacity: project?.watermarkOpacity ?? 30,
    watermarkFontSize: project?.watermarkFontSize || 'medium',
    // 1.9.4+ Phase A: default LUT to OFF when the project row
    // doesn't explicitly set it. The schema default flipped to
    // false (see migration 20260531000003); this brings the
    // worker's nullish-fallback in line so reprocess jobs on
    // older rows that came through before the migration still
    // get the new default behaviour.
    applyLut: project?.applyPreviewLut ?? false,
  }
}

/**
 * Calculate output dimensions based on input metadata and target resolution
 * Pure function - easy to test!
 */
export function calculateOutputDimensions(
  metadata: VideoMetadata,
  resolution: string
): OutputDimensions {
  const isVertical = metadata.height > metadata.width
  const isSquareOrNearSquare = Math.abs(metadata.width - metadata.height) / Math.max(metadata.width, metadata.height) < 0.2
  const aspectRatio = metadata.width / metadata.height

  logMessage(`[WORKER] Video orientation: ${isVertical ? 'vertical' : isSquareOrNearSquare ? 'square' : 'horizontal'} (${metadata.width}x${metadata.height}, ratio: ${aspectRatio.toFixed(2)})`)

  const preset = RESOLUTION_PRESETS[resolution as keyof typeof RESOLUTION_PRESETS] || RESOLUTION_PRESETS['720p']

  let dimensions: OutputDimensions

  if (isVertical) {
    // Vertical: constrain by width, calculate height from aspect ratio
    dimensions = {
      width: preset.verticalWidth,
      height: Math.round(preset.verticalWidth / aspectRatio / 2) * 2  // Ensure even number
    }
  } else {
    // Horizontal or square: constrain by height, calculate width from aspect ratio
    // This preserves aspect ratio for 4:3, 1:1, and other non-16:9 formats
    const targetHeight = preset.horizontal.height
    const calculatedWidth = Math.round(targetHeight * aspectRatio / 2) * 2  // Ensure even number

    // Cap width to preset max to avoid oversized outputs for ultra-wide videos
    const maxWidth = preset.horizontal.width
    if (calculatedWidth <= maxWidth) {
      dimensions = {
        width: calculatedWidth,
        height: targetHeight
      }
    } else {
      // Ultra-wide: constrain by width instead
      dimensions = {
        width: maxWidth,
        height: Math.round(maxWidth / aspectRatio / 2) * 2
      }
    }
  }

  logMessage(`[WORKER] Output resolution: ${dimensions.width}x${dimensions.height}`)

  debugLog('Resolution calculation:', {
    setting: resolution,
    isVertical,
    inputDimensions: `${metadata.width}x${metadata.height}`,
    outputDimensions: `${dimensions.width}x${dimensions.height}`,
    aspectRatio: aspectRatio.toFixed(2)
  })

  return dimensions
}

/**
 * Transcode video and upload preview
 */
export async function processPreview(
  videoId: string,
  projectId: string,
  inputPath: string,
  dimensions: OutputDimensions,
  settings: ProcessingSettings,
  tempFiles: TempFiles,
  duration: number,
  // 1.9.4+ Phase A: pin the x264 preset for this tier. Used by
  // the orchestrator to pass `ultrafast` for the 480p fast first
  // tier (we want time-to-ready, not file-size); higher tiers
  // get the auto-selected preset for better compression.
  presetOverride?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow',
): Promise<string> {
  // 1.9.4+: temp filename is resolution-keyed so progressive
  // multi-tier processing doesn't collide across passes (720p →
  // 1080p → 2160p each write their own temp file). Cleanup still
  // walks `tempFiles` and removes whatever the last pass wrote.
  const tempPreviewPath = path.join(TEMP_DIR, `${videoId}-preview-${settings.resolution}.mp4`)
  tempFiles.preview = tempPreviewPath

  debugLog('Starting video transcoding...')
  debugLog('Temp preview path:', tempPreviewPath)

  const transcodeStart = Date.now()

  // 1.9.4+: AbortController scoped to this single transcode pass.
  // If the video row disappears mid-flight (user hit Delete in the
  // dashboard) the next progress-write hits P2025 ("record not
  // found") — at that point we abort the AbortController, which
  // kills ffmpeg and propagates the `TranscodeAborted` error up
  // through `await transcodeVideo(...)`. Without this the worker
  // used to spam dozens of P2025 errors per second while ffmpeg
  // ran to completion against a tombstoned row.
  const abortController = new AbortController()

  try {
    await transcodeVideo({
      inputPath,
      outputPath: tempPreviewPath,
      width: dimensions.width,
      height: dimensions.height,
      watermarkText: settings.watermarkText,
      watermarkPositions: settings.watermarkPositions,
      watermarkOpacity: settings.watermarkOpacity,
      watermarkFontSize: settings.watermarkFontSize as any,
      applyLut: settings.applyLut,
      signal: abortController.signal,
      preset: presetOverride,
      onProgress: (() => {
        let lastWrite = 0
        let writing = false
        let consecutiveFailures = 0
        return async (progress: number) => {
          debugLog(`Transcode progress: ${(progress * 100).toFixed(1)}%`)
          // Once the abort fires, stop touching the DB — ffmpeg is
          // being torn down, no point fighting the row that's gone.
          if (abortController.signal.aborted) return
          const now = Date.now()
          // 1.9.4+ Phase A: write more often (every 1.5s instead
          // of every 3s) so the share-page spinner climbs visibly
          // — 3s felt frozen on the dashboard's 3.5s poll cadence.
          if (writing || now - lastWrite < 1500) return
          writing = true
          lastWrite = now
          try {
            // 1.9.4+ Phase A: scale the 0..1 ffmpeg progress to
            // 0..99 in the DB (capped just below 100 because the
            // worker calls finalizeFirstTier with progress=100 +
            // status=READY at the END, which is the right moment
            // for the UI to flip from spinner to player). The old
            // formula wrote `progress * 0.8` (i.e. 0..0.8 as a
            // float) which Math.round'd to 0 on the spinner —
            // that's the "stuck at 0%" bug.
            const scaledProgress = Math.min(99, Math.round(progress * 99))
            // 1.9.4+ Phase B: also write to the per-tier
            // progress map so the Quality menu can show
            // "720p · 45%" and "1080p · 23%" simultaneously when
            // both tiers run in parallel. We use `jsonb_set`
            // which is atomic at the row level — two concurrent
            // ffmpegs writing different keys never clobber each
            // other (Postgres serialises the two UPDATEs but
            // the JSONB key paths don't conflict). The coarse
            // `processingProgress` field above is kept in sync
            // for legacy code (overlay polls, dashboard chip).
            await prisma.$executeRawUnsafe(
              `UPDATE "Video" SET "transcodeProgressByTier" = jsonb_set(COALESCE("transcodeProgressByTier", '{}'::jsonb), $1::text[], to_jsonb($2::int), true), "processingProgress" = $3 WHERE "id" = $4`,
              `{${settings.resolution}}`,
              scaledProgress,
              scaledProgress,
              videoId,
            )
            consecutiveFailures = 0
          } catch (err: any) {
            // P2025 = "record not found": the user deleted the
            // video while we were transcoding. Don't even bother
            // logging it — kill ffmpeg fast and let the outer
            // catch turn this into a clean skip.
            if (err?.code === 'P2025') {
              abortController.abort()
              return
            }
            consecutiveFailures += 1
            logError(`[WORKER] Progress update failed for video ${videoId}:`, err)
            // Belt-and-braces: after 3 consecutive non-P2025 DB
            // errors, also abort — something's persistently wrong
            // (DB down, permissions, schema drift) and spamming
            // logs while burning CPU on a dead job is worse than
            // failing fast.
            if (consecutiveFailures >= 3) {
              abortController.abort()
            }
          } finally {
            writing = false
          }
        }
      })(),
    })
  } catch (err: any) {
    // Re-throw with a clean message so the orchestrator can
    // distinguish "user cancelled" from "ffmpeg blew up".
    if (err?.message === 'TranscodeAborted' || abortController.signal.aborted) {
      throw new Error('TranscodeAborted')
    }
    throw err
  }

  const transcodeTime = Date.now() - transcodeStart
  logMessage(`[WORKER] Generated ${settings.resolution} preview for video ${videoId} in ${(transcodeTime / 1000).toFixed(2)}s`)

  const transcodeStats = fs.statSync(tempPreviewPath)
  debugLog('Transcoded file size:', (transcodeStats.size / 1024 / 1024).toFixed(2) + ' MB')

  // Upload preview to storage
  const previewPath = `projects/${projectId}/videos/${videoId}/preview-${settings.resolution}.mp4`

  debugLog('Uploading preview to:', previewPath)

  const uploadStart = Date.now()
  await uploadFile(
    previewPath,
    fs.createReadStream(tempPreviewPath),
    transcodeStats.size,
    'video/mp4'
  )
  const uploadTime = Date.now() - uploadStart

  debugLog('Preview uploaded in:', (uploadTime / 1000).toFixed(2) + ' s')
  debugLog('Upload speed:', (transcodeStats.size / 1024 / 1024 / (uploadTime / 1000)).toFixed(2) + ' MB/s')

  return previewPath
}

/**
 * Generate thumbnail and upload
 */
export async function processThumbnail(
  videoId: string,
  projectId: string,
  inputPath: string,
  duration: number,
  tempFiles: TempFiles
): Promise<string> {
  // Calculate thumbnail timestamp using constants
  const timestamp = Math.min(
    Math.max(duration * THUMBNAIL_CONFIG.percentage, THUMBNAIL_CONFIG.min),
    THUMBNAIL_CONFIG.max
  )

  const tempThumbnailPath = path.join(TEMP_DIR, `${videoId}-thumb.jpg`)
  tempFiles.thumbnail = tempThumbnailPath

  debugLog('Generating thumbnail...')
  debugLog('Thumbnail timestamp:', timestamp + ' s')

  const thumbStart = Date.now()
  await generateThumbnail(inputPath, tempThumbnailPath, timestamp)
  const thumbTime = Date.now() - thumbStart

  logMessage(`[WORKER] Generated thumbnail for video ${videoId} in ${(thumbTime / 1000).toFixed(2)}s`)

  // Upload thumbnail
  const thumbnailPath = `projects/${projectId}/videos/${videoId}/thumbnail.jpg`
  const statsThumbnail = fs.statSync(tempThumbnailPath)

  debugLog('Uploading thumbnail to:', thumbnailPath)
  debugLog('Thumbnail file size:', (statsThumbnail.size / 1024).toFixed(2) + ' KB')

  const uploadStart = Date.now()
  await uploadFile(
    thumbnailPath,
    fs.createReadStream(tempThumbnailPath),
    statsThumbnail.size,
    'image/jpeg'
  )
  const uploadTime = Date.now() - uploadStart

  debugLog('Thumbnail uploaded in:', (uploadTime / 1000).toFixed(2) + ' s')

  return thumbnailPath
}

/**
 * Generate the hover-scrub storyboard sprite (1.0.6+). 100 frames in
 * a 10x10 grid, each 192x108. Total payload is tiny (~50-150KB) so
 * the dashboard can scrub instantly via CSS background-position.
 *
 * Returns the storage path on success, or `null` if generation
 * failed — the caller treats it as a soft failure since the video
 * itself is fine.
 */
export async function processStoryboard(
  videoId: string,
  projectId: string,
  inputPath: string,
  duration: number,
  tempFiles: TempFiles,
): Promise<string | null> {
  try {
    if (!Number.isFinite(duration) || duration <= 0) {
      return null
    }
    const tempStoryboardPath = path.join(TEMP_DIR, `${videoId}-storyboard.jpg`)
    tempFiles.storyboard = tempStoryboardPath

    const t0 = Date.now()
    await generateStoryboard(inputPath, tempStoryboardPath, duration)
    logMessage(`[WORKER] Generated storyboard for video ${videoId} in ${((Date.now() - t0) / 1000).toFixed(2)}s`)

    const storyboardPath = `projects/${projectId}/videos/${videoId}/storyboard.jpg`
    const stats = fs.statSync(tempStoryboardPath)
    debugLog('Storyboard file size:', (stats.size / 1024).toFixed(2) + ' KB')

    await uploadFile(
      storyboardPath,
      fs.createReadStream(tempStoryboardPath),
      stats.size,
      'image/jpeg',
    )
    return storyboardPath
  } catch (err) {
    // Soft failure — log but don't block video readiness.
    logError(`[WORKER] Storyboard generation failed for video ${videoId}:`, err)
    return null
  }
}

/**
 * Update video record with final processing results
 */
export async function finalizeVideo(
  videoId: string,
  previewPath: string,
  thumbnailPath: string,
  metadata: VideoMetadata,
  resolution: string,
  storyboardPath?: string | null,
): Promise<void> {
  // Preserve user-supplied thumbnails (assets) when reprocessing so we don't overwrite them
  const existingThumbnail = await prisma.video.findUnique({
    where: { id: videoId },
    select: { thumbnailPath: true },
  })

  const hasCustomThumbnail = existingThumbnail?.thumbnailPath
    ? !!(await prisma.videoAsset.findFirst({
        where: {
          videoId,
          storagePath: existingThumbnail.thumbnailPath,
        },
        select: { id: true },
      })) || existingThumbnail.thumbnailPath.includes('/videos/assets/')
    : false

  const updateData: any = {
    status: 'READY',
    processingProgress: 100,
    // Keep custom thumbnails; only overwrite system-generated ones
    thumbnailPath: hasCustomThumbnail ? existingThumbnail?.thumbnailPath : thumbnailPath,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    codec: metadata.codec,
  }

  // Store preview path in correct field based on resolution (skip if no transcoding)
  if (previewPath && resolution === '720p') {
    updateData.preview720Path = previewPath
  } else if (previewPath && resolution === '1080p') {
    updateData.preview1080Path = previewPath
  } else if (previewPath && resolution === '2160p') {
    updateData.preview2160Path = previewPath
  }

  debugLog('Updating database with final video data...')
  debugLog('Update data:', updateData)

  await prisma.video.update({
    where: { id: videoId },
    data: updateData,
  })

  // Storyboard update is intentionally a SECOND, isolated query
  // (1.0.6+). If the DB doesn't yet have the storyboardPath column
  // (migration not applied) this fails silently and the main video
  // still finalizes to READY — the worst case is "no hover-scrub
  // sprite" rather than "the whole upload is stuck in PROCESSING".
  if (storyboardPath) {
    try {
      await prisma.video.update({
        where: { id: videoId },
        data: { storyboardPath } as any,
      })
    } catch (err) {
      logError(`[WORKER] Storyboard path persist failed for ${videoId} (column missing? run prisma migrate dev):`, err)
    }
  }

  debugLog('Database updated to READY status')
}

/**
 * Update video status in database.
 *
 * 1.9.4+: rethrows P2025 as `TranscodeAborted` so the orchestrator
 * can bail out before doing any expensive transcoding work when
 * the row has already been deleted (cheap race-window save).
 */
export async function updateVideoStatus(
  videoId: string,
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR',
  progress: number
): Promise<void> {
  debugLog(`Updating video status to ${status}...`)

  try {
    await prisma.video.update({
      where: { id: videoId },
      data: { status, processingProgress: progress },
    })
  } catch (err: any) {
    if (err?.code === 'P2025') {
      throw new Error('TranscodeAborted')
    }
    throw err
  }

  debugLog(`Database updated to ${status} status`)
}

/**
 * Cleanup temporary files
 * Used in both success and error paths (DRY principle)
 */
export async function cleanupTempFiles(tempFiles: TempFiles): Promise<void> {
  debugLog('Starting temp file cleanup...')

  const files = Object.values(tempFiles).filter((f): f is string => !!f)

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        const fileStats = fs.statSync(file)
        await fs.promises.unlink(file)
        logMessage(`[WORKER] Cleaned up temp file: ${path.basename(file)}`)
        debugLog('Freed disk space:', (fileStats.size / 1024 / 1024).toFixed(2) + ' MB')
      }
    } catch (cleanupError) {
      logError(`[WORKER ERROR] Failed to cleanup temp file ${path.basename(file)}:`, cleanupError)
    }
  }
}

/**
 * Handle processing errors - update database and log.
 *
 * 1.9.4+: silently swallows P2025 ("record not found") because
 * that means the video row was already deleted while we were
 * processing — re-marking a tombstoned row as ERROR would itself
 * fail and add another layer of noise. The orchestrator already
 * short-circuits on `TranscodeAborted` before reaching here, so
 * if we DO land here with a missing row it's a race we want to
 * fail closed on, not loud on.
 */
export async function handleProcessingError(
  videoId: string,
  error: unknown
): Promise<void> {
  logError(`[WORKER ERROR] Error processing video ${videoId}:`, error)

  if (error instanceof Error) {
    debugLog('Full error stack:', error.stack)
  }

  const errorMessage = error instanceof Error ? error.message : 'Unknown error'

  debugLog('Updating database with error status...')
  debugLog('Error message:', errorMessage)

  try {
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: 'ERROR',
        processingError: errorMessage,
      },
    })
  } catch (dbErr: any) {
    if (dbErr?.code === 'P2025') {
      // Row already deleted — nothing to mark.
      return
    }
    throw dbErr
  }
}

// =====================================================================
// 1.9.4+ Progressive multi-tier helpers (Phase A)
// =====================================================================
//
// Old pipeline transcoded a SINGLE preview at the project's chosen
// resolution and flipped status=READY only when that lone pass +
// thumbnail + storyboard were done. For a 4K master targeting 2160p
// that's ~10-15 minutes of black UI from the user's POV.
//
// The new ladder generates 720p first, marks the video READY as
// soon as 720p is up (+ thumbnail + storyboard), then continues
// generating 1080p and 2160p in the SAME worker job. Each higher
// tier writes to its own column (preview1080Path, preview2160Path)
// and bumps processingProgress; the player picks the highest
// available column at watch time.

export type QualityTier = '480p' | '720p' | '1080p' | '2160p'

export interface ProgressivePass {
  tier: QualityTier
  dimensions: OutputDimensions
}

/**
 * Build the ordered list of quality tiers we'll transcode for a
 * given input, respecting both the project's max-quality preference
 * AND the input's actual resolution (no upscaling — bumping a
 * 1080p master to "2160p" wastes CPU + bytes for zero visual gain).
 *
 * 1.9.4+ Phase A: ALWAYS starts with 480p as the fastest path to
 * a playable preview. Then climbs to whatever the project's
 * `previewResolution` setting allows, gated by the input's actual
 * short-side resolution. So a 4K input with previewResolution=2160p
 * gets the full ladder 480p → 720p → 1080p → 2160p, while a phone
 * clip uploaded to a 720p project gets just 480p → 720p.
 *
 * Quality is measured by the SHORT side of the frame (Math.min of
 * width/height) so that vertical 1080×1920 phone clips are still
 * classified as "1080p source".
 */
export function computeProgressiveTiers(
  metadata: VideoMetadata,
  maxResolution: string,
): ProgressivePass[] {
  const shortSide = Math.min(metadata.width, metadata.height)
  const passes: ProgressivePass[] = []

  // 1.9.4+ Phase A: cinematic / cropped sources (e.g. 1920×1008
  // letterboxed, 1920×800 ultrawide) shouldn't be downgraded
  // just because their short side missed the tier threshold by
  // a few pixels. Anything within 90% of a tier's nominal height
  // counts as "that quality" — close enough that the user
  // expects the tier in the Quality menu.
  const meetsTier = (tierHeight: number) => shortSide >= tierHeight * 0.9

  // 1.9.4+ Phase A: "auto" means "climb to whatever the input
  // actually is". With the 90% tolerance a 1920×1008 cinematic
  // master gets the full 1080p ladder slot instead of being
  // capped at 720p.
  let effectiveMax = maxResolution
  if (effectiveMax === 'auto') {
    if (meetsTier(2160)) effectiveMax = '2160p'
    else if (meetsTier(1080)) effectiveMax = '1080p'
    else if (meetsTier(720)) effectiveMax = '720p'
    else effectiveMax = '720p' // floor — still allow a 720p tier above 480p for sub-720p sources
  }

  // Always start with 480p — fastest path to status=READY.
  passes.push({
    tier: '480p',
    dimensions: calculateOutputDimensions(metadata, '480p'),
  })

  // 720p tier — include if project allows AND input is essentially >= 720p.
  const wants720 = effectiveMax === '720p' || effectiveMax === '1080p' || effectiveMax === '2160p'
  if (wants720 && meetsTier(720)) {
    passes.push({
      tier: '720p',
      dimensions: calculateOutputDimensions(metadata, '720p'),
    })
  }

  // 1080p tier — include if project allows AT LEAST 1080p AND
  // input is essentially >= 1080p (90% rule handles 1920×1008
  // cinematic crops, ultrawides, etc.).
  const wants1080 = effectiveMax === '1080p' || effectiveMax === '2160p'
  if (wants1080 && meetsTier(1080)) {
    passes.push({
      tier: '1080p',
      dimensions: calculateOutputDimensions(metadata, '1080p'),
    })
  }

  // 2160p tier — include if project allows it AND input is
  // essentially >= 2160p.
  const wants2160 = effectiveMax === '2160p'
  if (wants2160 && meetsTier(2160)) {
    passes.push({
      tier: '2160p',
      dimensions: calculateOutputDimensions(metadata, '2160p'),
    })
  }

  return passes
}

/**
 * Write back the FIRST tier (720p) result:
 *   - flips status=READY so the player can start serving the file
 *   - persists preview720Path
 *   - persists thumbnail + metadata + storyboard (the "ready" blob)
 *   - sets processingProgress to (1 / totalTiers) so the dashboard
 *     can show "1080p still cooking..." while playback works
 *
 * Honours the same hasCustomThumbnail rule as finalizeVideo so a
 * client-uploaded asset thumbnail isn't clobbered on reprocess.
 */
export async function finalizeFirstTier(
  videoId: string,
  tier: QualityTier,
  previewPath: string,
  thumbnailPath: string,
  metadata: VideoMetadata,
  storyboardPath: string | null,
  totalTiers: number,
): Promise<void> {
  const existingThumbnail = await prisma.video.findUnique({
    where: { id: videoId },
    select: { thumbnailPath: true },
  })

  const hasCustomThumbnail = existingThumbnail?.thumbnailPath
    ? !!(await prisma.videoAsset.findFirst({
        where: { videoId, storagePath: existingThumbnail.thumbnailPath },
        select: { id: true },
      })) || existingThumbnail.thumbnailPath.includes('/videos/assets/')
    : false

  // Progress: 720p done = 1/totalTiers slice. For a 3-tier ladder
  // we sit at ~33% while 1080p + 2160p continue. The "READY" flag
  // already tells the user it's playable; progress is purely a
  // visual indicator that higher quality is still on the way.
  const progress = Math.round((1 / totalTiers) * 100)

  const updateData: any = {
    status: 'READY',
    processingProgress: progress,
    thumbnailPath: hasCustomThumbnail ? existingThumbnail?.thumbnailPath : thumbnailPath,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    codec: metadata.codec,
  }

  // 1.9.4+ Phase A: first tier is 480p in every code path now.
  // Keep the dispatch parametric in case we ever skip 480p for
  // skipTranscoding-style flows.
  if (tier === '480p') updateData.preview480Path = previewPath
  else if (tier === '720p') updateData.preview720Path = previewPath
  else if (tier === '1080p') updateData.preview1080Path = previewPath
  else if (tier === '2160p') updateData.preview2160Path = previewPath

  await prisma.video.update({ where: { id: videoId }, data: updateData })

  if (storyboardPath) {
    try {
      await prisma.video.update({
        where: { id: videoId },
        data: { storyboardPath } as any,
      })
    } catch (err) {
      logError(`[WORKER] Storyboard path persist failed for ${videoId}:`, err)
    }
  }

  debugLog(`Video ${videoId} flipped to READY after ${tier} (progress=${progress}%)`)
}

/**
 * Write back a HIGHER tier (1080p or 2160p) after the video is
 * already READY. Only touches the relevant preview*Path column +
 * processingProgress — does NOT alter status or thumbnail.
 *
 * The orchestrator passes `tierIndex` (0-based) and `totalTiers` so
 * we can compute a coarse progress percentage; the last tier in
 * the ladder lands at 100.
 */
/**
 * 1.9.4+ Phase B: process the HLS variant for a given tier.
 *
 * Runs FFmpeg's `-c copy` HLS muxer on the just-finished MP4 to
 * produce `playlist.m3u8` + `seg_*.ts` segments. No re-encoding,
 * just demux + chunk — typically 5-30 s per tier regardless of
 * source duration.
 *
 * Uploads every segment + playlist to storage under
 *   `projects/<projectId>/videos/<videoId>/hls/<tier>/`
 * and then updates `Video.hlsBasePath` (idempotent — same value
 * for all tiers of a given video) and pushes `tier` into
 * `Video.hlsQualities` so the dynamic master.m3u8 starts listing
 * it on the next poll.
 *
 * Soft-fail: HLS is additive, the MP4 path is unaffected if
 * remux blows up. We log and move on.
 */
export async function processHlsTier(
  videoId: string,
  projectId: string,
  mp4LocalPath: string,
  tier: QualityTier,
  tempFiles: TempFiles,
): Promise<void> {
  const localOutDir = path.join(TEMP_DIR, `${videoId}-hls-${tier}`)
  // Track the directory so cleanup walks remove it on success or
  // failure. Storing the playlist filename so the cleaner has a
  // file to unlink; recursive cleanup of the dir is handled at
  // the end of this function explicitly.
  ;(tempFiles as any)[`hls_${tier}`] = path.join(localOutDir, 'playlist.m3u8')

  const t0 = Date.now()
  try {
    await remuxToHls(mp4LocalPath, localOutDir)
  } catch (err) {
    logError(`[WORKER] HLS remux failed for video ${videoId} ${tier}:`, err)
    return
  }
  logMessage(
    `[WORKER] HLS remux for video ${videoId} ${tier} in ${((Date.now() - t0) / 1000).toFixed(2)}s`,
  )

  // Upload every produced file to storage. The remuxer writes a
  // small handful (playlist + segments), so we walk the dir.
  const baseStoragePath = `projects/${projectId}/videos/${videoId}/hls/${tier}`
  let files: string[] = []
  try {
    files = fs.readdirSync(localOutDir)
  } catch (err) {
    logError(`[WORKER] Could not read HLS output dir for ${videoId} ${tier}:`, err)
    return
  }

  try {
    for (const f of files) {
      const localPath = path.join(localOutDir, f)
      const stats = fs.statSync(localPath)
      if (!stats.isFile()) continue
      const remotePath = `${baseStoragePath}/${f}`
      const contentType = f.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : f.endsWith('.ts')
          ? 'video/mp2t'
          : 'application/octet-stream'
      await uploadFile(remotePath, fs.createReadStream(localPath), stats.size, contentType)
    }
  } catch (err) {
    logError(`[WORKER] HLS upload failed for ${videoId} ${tier}:`, err)
    return
  }

  // Persist hlsBasePath (one-time-per-video — idempotent) and
  // push the tier into hlsQualities so the dynamic master.m3u8
  // picks it up. Using `set` with the current array ensures we
  // don't double-add on reprocessing.
  try {
    const existing = await prisma.video.findUnique({
      where: { id: videoId },
      select: { hlsQualities: true } as any,
    }) as any
    const set = new Set<string>(existing?.hlsQualities || [])
    set.add(tier)
    await prisma.video.update({
      where: { id: videoId },
      data: {
        hlsBasePath: `projects/${projectId}/videos/${videoId}/hls`,
        hlsQualities: Array.from(set),
      } as any,
    })
    logMessage(`[WORKER] HLS ${tier} ready for video ${videoId}`)
  } catch (err: any) {
    // P2025 = row already deleted by user mid-processing. Soft fail.
    if (err?.code === 'P2025') return
    logError(`[WORKER] HLS DB update failed for ${videoId} ${tier}:`, err)
  }

  // Best-effort cleanup of the local HLS output dir. The temp
  // file sweeper picks up the playlist path but doesn't recurse,
  // so we unlink the dir explicitly.
  try {
    for (const f of fs.readdirSync(localOutDir)) {
      try { fs.unlinkSync(path.join(localOutDir, f)) } catch {}
    }
    fs.rmdirSync(localOutDir)
  } catch {}
}

export async function finalizeAdditionalTier(
  videoId: string,
  tier: QualityTier,
  previewPath: string,
  tierIndex: number,
  totalTiers: number,
): Promise<void> {
  const isLast = tierIndex === totalTiers - 1
  const progress = isLast ? 100 : Math.round(((tierIndex + 1) / totalTiers) * 100)

  const updateData: any = { processingProgress: progress }
  if (tier === '480p') updateData.preview480Path = previewPath
  else if (tier === '720p') updateData.preview720Path = previewPath
  else if (tier === '1080p') updateData.preview1080Path = previewPath
  else if (tier === '2160p') updateData.preview2160Path = previewPath

  await prisma.video.update({ where: { id: videoId }, data: updateData })

  // 1.9.4+ Phase B: also nail this tier's per-tier progress to
  // 100 so the Quality menu rows transition cleanly from "45%"
  // to gone (the player drops them from pendingQualities once
  // they show up in hlsQualities / preview*Path). Without this,
  // the last writer's % from the onProgress throttle window
  // could be e.g. 87 forever — a confusing "stuck just below
  // done" reading.
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "Video" SET "transcodeProgressByTier" = jsonb_set(COALESCE("transcodeProgressByTier", '{}'::jsonb), $1::text[], to_jsonb(100::int), true) WHERE "id" = $2`,
      `{${tier}}`,
      videoId,
    )
  } catch (err) {
    // Soft fail — the row's preview*Path is what actually
    // matters for "tier ready"; the JSON map is decorative.
    logError(`[WORKER] transcodeProgressByTier finalize failed for ${videoId} ${tier}:`, err)
  }

  debugLog(`Video ${videoId} ${tier} tier persisted (progress=${progress}%)`)
}
