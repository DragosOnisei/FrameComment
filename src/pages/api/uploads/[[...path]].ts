import { Server } from '@tus/server'
import { FileStore } from '@tus/file-store'
import { prisma } from '@/lib/db'
import { videoQueue, getAssetQueue, getProjectUploadQueue } from '@/lib/queue'
import { ALL_ALLOWED_EXTENSIONS } from '@/lib/asset-validation'
import { uploadFile, moveFile, initStorage, getTusUploadDir, isS3Mode, getFilePath } from '@/lib/storage'
import { generateThumbnail } from '@/lib/ffmpeg'
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import type { NextApiRequest, NextApiResponse } from 'next'
import { logError, logMessage } from '@/lib/logging'
import { parseBearerToken, verifyAdminAccessToken, verifyShareToken } from '@/lib/auth'
import { handleReverseShareUploadNotification } from '@/lib/upload-notifications'


// 1.5.x+: TUS staging directory is now resolved via getTusUploadDir()
// so multi-GB uploads land on the same dataset as final storage
// instead of the container's small tmpfs `/tmp`. See storage.ts for
// the resolution order + the perf bug that motivated this change.
const TUS_UPLOAD_DIR = getTusUploadDir()
const ABSOLUTE_MAX_UPLOAD_SIZE_BYTES = 1000 * 1024 * 1024 * 1024 // 1000 GB hard safety cap

if (!fs.existsSync(TUS_UPLOAD_DIR)) {
  fs.mkdirSync(TUS_UPLOAD_DIR, { recursive: true })
}

const tusServer: Server = new Server({
  path: '/api/uploads',
  datastore: new FileStore({
    directory: TUS_UPLOAD_DIR,
  }),

  maxSize: ABSOLUTE_MAX_UPLOAD_SIZE_BYTES,
  respectForwardedHeaders: true,
  relativeLocation: true,

  async onUploadCreate(req, upload) {
    try {
      const bearer = parseBearerToken(req as any)

      if (!bearer) {
        throw {
          status_code: 401,
          body: 'Authentication required'
        }
      }

      // Try admin auth first, then fall back to share token auth
      let isAdmin = false
      const adminPayload = await verifyAdminAccessToken(bearer)
      if (adminPayload && adminPayload.role === 'ADMIN') {
        isAdmin = true
      } else {
        // Try share token auth for client uploads
        const sharePayload = await verifyShareToken(bearer)
        if (!sharePayload) {
          throw {
            status_code: 403,
            body: 'Access denied'
          }
        }

        // Share tokens can only upload assets or project uploads (not videos)
        if (!upload.metadata?.assetId && !upload.metadata?.projectUploadId) {
          throw {
            status_code: 403,
            body: 'Share tokens can only upload assets'
          }
        }

        // Verify comment permission
        if (!sharePayload.permissions?.includes('comment')) {
          throw {
            status_code: 403,
            body: 'Comment permission required'
          }
        }

        // Guests cannot upload
        if (sharePayload.guest) {
          throw {
            status_code: 403,
            body: 'Guest access cannot upload files'
          }
        }

        if (upload.metadata?.projectUploadId) {
          // Reverse share upload — verify the ProjectUpload record
          const projectUpload = await prisma.projectUpload.findUnique({
            where: { id: upload.metadata.projectUploadId as string },
            select: { projectId: true, uploadedBySessionId: true },
          })

          if (!projectUpload) {
            throw { status_code: 404, body: 'Upload record not found' }
          }

          if (projectUpload.projectId !== sharePayload.projectId) {
            throw { status_code: 403, body: 'Upload does not belong to your project' }
          }

          if (projectUpload.uploadedBySessionId !== sharePayload.sessionId) {
            throw { status_code: 403, body: 'Upload does not belong to your session' }
          }

          const project = await prisma.project.findUnique({
            where: { id: sharePayload.projectId },
            select: { allowReverseShare: true },
          })

          if (!project?.allowReverseShare) {
            throw { status_code: 403, body: 'File submissions are not enabled for this project' }
          }
        } else {
          // Comment attachment upload — verify VideoAsset record
          const asset = await prisma.videoAsset.findUnique({
            where: { id: upload.metadata.assetId as string },
            select: {
              uploadedBy: true,
              uploadedBySessionId: true,
              category: true,
              video: { select: { projectId: true } },
            },
          })

          if (!asset) {
            throw { status_code: 404, body: 'Asset record not found' }
          }

          if (asset.uploadedBy !== 'client') {
            throw { status_code: 403, body: 'Access denied' }
          }

          if (asset.video.projectId !== sharePayload.projectId) {
            throw { status_code: 403, body: 'Asset does not belong to your project' }
          }

          if (asset.uploadedBySessionId !== sharePayload.sessionId) {
            throw { status_code: 403, body: 'Asset does not belong to your session' }
          }

          // 4.1.1+: File attachments are ALWAYS enabled — the
          // `allowClientAssetUpload` gate was removed. Anyone who can
          // comment can attach files.
        }
      }

      const videoId = upload.metadata?.videoId as string
      const assetId = upload.metadata?.assetId as string
      const projectUploadId = upload.metadata?.projectUploadId as string

      if (!videoId && !assetId && !projectUploadId) {
        throw {
          status_code: 400,
          body: 'Missing required metadata: videoId, assetId, or projectUploadId'
        }
      }

      // Enforce configurable max upload size from Global Settings
      const appSettings = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { maxUploadSizeGB: true },
      })
      // 1.5.x+: fallback default lifted from 1 GB → 1000 GB (= 1 TB).
      // Matches the new Prisma schema default; pre-1.5.x installs with
      // the legacy default-1 row are migrated by
      // 20260525_lift_max_upload_size_default.
      const maxUploadSizeGB = appSettings?.maxUploadSizeGB ?? 1000
      const maxUploadSizeBytes = maxUploadSizeGB * 1024 * 1024 * 1024
      const requestedSize = Number(upload.size || 0)

      if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
        throw {
          status_code: 400,
          body: 'Invalid upload size metadata'
        }
      }

      if (requestedSize > maxUploadSizeBytes) {
        throw {
          status_code: 413,
          body: `Upload exceeds maximum allowed size of ${maxUploadSizeGB} GB`
        }
      }

      if (requestedSize > ABSOLUTE_MAX_UPLOAD_SIZE_BYTES) {
        throw {
          status_code: 413,
          body: 'Upload exceeds maximum allowed size'
        }
      }

      if (videoId) {
        // In S3 mode, video uploads must go through /api/uploads/s3/presign — not TUS.
        // TUS is only used for local filesystem storage.
        if (isS3Mode()) {
          throw { status_code: 400, body: 'Video uploads must use the S3 multipart upload path in S3 mode' }
        }

        // Only admins can upload videos
        if (!isAdmin) {
          throw {
            status_code: 403,
            body: 'Admin access required for video uploads'
          }
        }

        const video = await prisma.video.findUnique({
          where: { id: videoId }
        })

        if (!video) {
          throw {
            status_code: 404,
            body: 'Video record not found'
          }
        }

        if (video.status !== 'UPLOADING') {
          throw {
            status_code: 400,
            body: 'Video is not in UPLOADING state'
          }
        }
      }

      if (assetId && isAdmin) {
        // Admin asset upload — just verify asset exists (share token path already verified above)
        const asset = await prisma.videoAsset.findUnique({
          where: { id: assetId }
        })

        if (!asset) {
          throw {
            status_code: 404,
            body: 'Asset record not found'
          }
        }
      }

      if (projectUploadId && isAdmin) {
        // Admin project upload — verify record exists
        const projectUpload = await prisma.projectUpload.findUnique({
          where: { id: projectUploadId },
          select: { id: true },
        })

        if (!projectUpload) {
          throw {
            status_code: 404,
            body: 'Upload record not found'
          }
        }
      }

      return { metadata: upload.metadata }
    } catch (error) {
      logError('[UPLOAD] Error in onUploadCreate:', error)
      throw error
    }
  },

  async onUploadFinish(_req, upload) {
    const tusFilePath = path.join(TUS_UPLOAD_DIR, upload.id)
    const videoId = upload.metadata?.videoId as string
    const assetId = upload.metadata?.assetId as string
    const projectUploadId = upload.metadata?.projectUploadId as string

    try {
      if (videoId) {
        return await handleVideoUploadFinish(tusFilePath, upload, videoId, tusServer)
      } else if (assetId) {
        return await handleAssetUploadFinish(tusFilePath, upload, assetId, tusServer)
      } else if (projectUploadId) {
        return await handleProjectUploadFinish(tusFilePath, upload, projectUploadId, tusServer)
      } else {
        logMessage('[UPLOAD] No videoId, assetId, or projectUploadId in upload metadata')
        return {}
      }
    } catch (error) {
      logError('[UPLOAD] Error in onUploadFinish:', error)
      await cleanupTUSFile(tusFilePath)

      if (videoId) {
        await markVideoAsError(videoId, error)
      }

      throw error
    }
  }
})

// 2.1.7+: Server-side per-video upload progress tracking. The TUS
// server emits a `POST_RECEIVE` event after each successful PATCH
// chunk. We use it to push `(offset / size) * 100` into the
// Video.uploadProgress field, which the `/api/processing-status`
// endpoint already reads on every poll. This fixes the dead
// "Uploading videos · 0%" banner for both browser TUS uploads AND
// the bulk-upload.mjs CLI — neither client had to be modified
// because progress is now derived purely from what the server
// already observes.
//
// Throttle by videoId: each video gets its own 1500 ms cooldown
// so a fast 10 MB chunk every 200 ms doesn't generate 50 db
// writes/second. The final state hits when onUploadFinish flips
// status to PROCESSING (uploadProgress becomes irrelevant at
// that point because the row is no longer in the "uploading"
// banner anyway).
const lastProgressWriteAt = new Map<string, number>()
const UPLOAD_PROGRESS_THROTTLE_MS = 1500

;(tusServer as any).on?.('POST_RECEIVE', async (_req: any, upload: any) => {
  try {
    const videoId = upload?.metadata?.videoId as string | undefined
    if (!videoId) return
    const size = Number(upload?.size ?? 0)
    const offset = Number(upload?.offset ?? 0)
    if (!size || size <= 0) return

    const now = Date.now()
    const last = lastProgressWriteAt.get(videoId) ?? 0
    if (now - last < UPLOAD_PROGRESS_THROTTLE_MS) return
    lastProgressWriteAt.set(videoId, now)

    const pct = Math.min(99, Math.max(0, Math.round((offset / size) * 100)))
    await prisma.video
      .update({
        where: { id: videoId },
        data: { uploadProgress: pct },
      })
      .catch((err) => {
        // Don't blow up the upload because we couldn't update a
        // progress field. Most likely the row got deleted mid-
        // upload (user navigated away + cancelled). Swallow.
        logError(`[UPLOAD] uploadProgress update failed for ${videoId}:`, err)
      })
  } catch (err) {
    logError('[UPLOAD] POST_RECEIVE handler threw:', err)
  }
})

async function handleVideoUploadFinish(tusFilePath: string, upload: any, videoId: string, tusServer: any) {
  const video = await prisma.video.findUnique({
    where: { id: videoId }
  })

  if (!video) {
    logMessage(`[UPLOAD] Video not found: ${videoId}`)
    await cleanupTUSFile(tusFilePath)
    return {}
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size)

  await validateVideoFile(tusFilePath, upload.metadata?.filename as string)

  await initStorage()

  // 1.5.x+: on local storage, rename the staging file into the final
  // layout (instant — same FS) instead of streaming-copying it. The
  // copy used to dominate disk I/O on HDD-backed TrueNAS datasets:
  // a 3 GB upload meant 6 GB of writes (3 GB into staging, then
  // another 3 GB into the final path). With rename we only write
  // once. S3 still uses the streaming path because there's no
  // server-side staging to rename FROM.
  if (isS3Mode()) {
    const fileStream = (tusServer.datastore as any).read(upload.id)
    await uploadFile(
      video.originalStoragePath,
      fileStream,
      fileSize,
      upload.metadata?.filetype as string || 'video/mp4'
    )
  } else {
    await moveFile(tusFilePath, video.originalStoragePath, fileSize)
  }

  // 1.0.9+: image uploads share the same TUS pipeline as videos but
  // skip the worker entirely. There's nothing to transcode, and the
  // original file IS the thumbnail. Flip the row straight to READY
  // and point `thumbnailPath` at the uploaded original so the folder
  // grid and player can sign a URL for it just like a normal video
  // thumbnail.
  const mediaType: 'VIDEO' | 'IMAGE' =
    ((video as any).mediaType as 'VIDEO' | 'IMAGE' | undefined) || 'VIDEO'
  if (mediaType === 'IMAGE') {
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: 'READY',
        processingProgress: 100,
        thumbnailPath: video.originalStoragePath,
        // Duration / width / height stay at the seed values from the
        // upload route (0). Width/height ideally come from probing the
        // image with sharp, but the player + grid already render fine
        // off the natural dimensions of the <img>, so we skip the
        // server-side probe for the MVP.
      } as any,
    })
    logMessage(
      `[UPLOAD] Image ${videoId} upload complete, marked READY (worker skipped)`,
    )
    await cleanupTUSFile(tusFilePath)
    return {}
  }

  // Update video status to PROCESSING since upload is complete and job will be queued
  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: 'PROCESSING',
      processingProgress: 0,
    },
  })

  logMessage(`[UPLOAD] Video ${videoId} upload complete, status updated to PROCESSING`)

  // 2.2.10+ ORDERING FIX: enqueue prepare-video FIRST, then kick
  // off instant thumbnail in parallel. Pre-2.2.10 we awaited the
  // instant thumbnail (with a 15 s timeout) BEFORE enqueueing —
  // so for typical files the worker didn't even see the job for
  // 3-8 s after the upload finished, which the user perceived as
  // "nothing happens for 5-10 s after upload reaches 100%". Now
  // the worker picks up `prepare-video` within milliseconds of
  // the bytes landing; the upload-side instant thumbnail still
  // runs (so the grid gets a frame within a couple seconds), it
  // just doesn't gate the encode pipeline anymore. The worker's
  // own thumbnail pass is idempotent on the same storage path,
  // so a race between the two writes resolves to "same file" and
  // doesn't break anything.
  // 1.9.4+ Phase A: instant thumbnail extraction. Local-mode only
  // — S3 would require downloading the full original just for one
  // frame, which doesn't pay back.
  if (!isS3Mode()) {
    // Don't await — fire and let it complete in the background.
    // Worker starts the heavy lifting in parallel.
    void Promise.race([
      initInstantThumbnail(video.id, video.projectId, video.originalStoragePath),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Instant thumbnail timeout')), 15000),
      ),
    ]).catch((err) => {
      // Non-fatal: worker will generate a thumbnail later via its
      // own processThumbnail call. Log and continue.
      logError(`[UPLOAD] Instant thumbnail failed for ${videoId} (non-fatal):`, err)
    })
  }

  // 2.2.0+: enqueue prepare-video (priority 1) instead of the
  // legacy process-video. prepare-video does the cheap up-front
  // work (download, validate, probe, thumbnail, plan tiers) and
  // fans out per-tier encode-tier jobs + a finalize-video tail.
  // For a bulk upload, every video reaches "thumbnail visible +
  // tiers planned" before ANY encode starts — the breadth-first
  // behaviour 2.2.0 is built around.
  await videoQueue.add(
    'prepare-video',
    {
      videoId: video.id,
      originalStoragePath: video.originalStoragePath,
      projectId: video.projectId,
    },
    { priority: 1, jobId: `prepare-${video.id}` },
  )

  logMessage(`[UPLOAD] Video ${videoId} queued for worker processing`)

  await cleanupTUSFile(tusFilePath)

  return {}
}

async function handleAssetUploadFinish(tusFilePath: string, upload: any, assetId: string, tusServer: any) {
  const asset = await prisma.videoAsset.findUnique({
    where: { id: assetId }
  })

  if (!asset) {
    logMessage(`[UPLOAD] Asset not found: ${assetId}`)
    await cleanupTUSFile(tusFilePath)
    throw new Error(`Asset record not found for upload completion: ${assetId}`)
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size)

  await validateUploadedAssetFile(tusFilePath, upload.metadata?.filename as string)

  await initStorage()

  // 1.5.x+: rename staging → final on local storage. See
  // handleVideoUploadFinish for the perf rationale.
  const actualFileType = upload.metadata?.filetype as string || 'application/octet-stream'
  if (isS3Mode()) {
    const fileStream = (tusServer.datastore as any).read(upload.id)
    await uploadFile(
      asset.storagePath,
      fileStream,
      fileSize,
      actualFileType
    )
  } else {
    await moveFile(tusFilePath, asset.storagePath, fileSize)
  }

  await prisma.videoAsset.update({
    where: { id: assetId },
    data: {
      fileType: actualFileType,
      fileSize: BigInt(fileSize),
      uploadCompletedAt: new Date(),
    },
  })

  // Queue asset for magic byte validation in worker
  const assetQueue = getAssetQueue()

  await assetQueue.add('process-asset', {
    assetId: asset.id,
    storagePath: asset.storagePath,
    expectedCategory: asset.category ?? undefined,
  })

  logMessage(`[UPLOAD] Asset uploaded and queued for processing: ${assetId}`)

  await cleanupTUSFile(tusFilePath)

  return {}
}

async function handleProjectUploadFinish(tusFilePath: string, upload: any, projectUploadId: string, tusServer: any) {
  const projectUpload = await prisma.projectUpload.findUnique({
    where: { id: projectUploadId }
  })

  if (!projectUpload) {
    logMessage(`[UPLOAD] ProjectUpload not found: ${projectUploadId}`)
    await cleanupTUSFile(tusFilePath)
    throw new Error(`Upload record not found: ${projectUploadId}`)
  }

  const fileSize = await verifyUploadedFile(tusFilePath, upload.size)

  await validateUploadedAssetFile(tusFilePath, upload.metadata?.filename as string)

  await initStorage()

  // 1.5.x+: rename staging → final on local storage. See
  // handleVideoUploadFinish for the perf rationale.
  const actualFileType = upload.metadata?.filetype as string || 'application/octet-stream'
  if (isS3Mode()) {
    const fileStream = (tusServer.datastore as any).read(upload.id)
    await uploadFile(projectUpload.storagePath, fileStream, fileSize, actualFileType)
  } else {
    await moveFile(tusFilePath, projectUpload.storagePath, fileSize)
  }

  await prisma.projectUpload.update({
    where: { id: projectUploadId },
    data: {
      fileType: actualFileType,
      fileSize: BigInt(fileSize),
      uploadCompletedAt: new Date(),
    },
  })

  // Queue project upload for magic byte MIME detection in worker
  const projectUploadQueue = getProjectUploadQueue()
  await projectUploadQueue.add('process-upload', {
    uploadId: projectUpload.id,
    storagePath: projectUpload.storagePath,
    projectId: projectUpload.projectId,
  })

  logMessage(`[UPLOAD] ProjectUpload complete: ${projectUploadId}`)

  // Fire-and-forget notification to admins
  void handleReverseShareUploadNotification({
    projectId: projectUpload.projectId,
    fileName: projectUpload.fileName,
    uploaderName: projectUpload.uploadedByName,
    uploaderEmail: projectUpload.uploadedByEmail,
  })

  await cleanupTUSFile(tusFilePath)

  return {}
}

async function verifyUploadedFile(tusFilePath: string, expectedSize?: number): Promise<number> {
  if (!fs.existsSync(tusFilePath)) {
    throw new Error('Uploaded file not found on disk')
  }

  const fileStats = fs.statSync(tusFilePath)
  const fileSize = fileStats.size

  if (expectedSize && fileSize !== expectedSize) {
    await cleanupTUSFile(tusFilePath)
    throw new Error(
      `File size mismatch: expected ${expectedSize} bytes, got ${fileSize} bytes. ` +
      `Upload may have been interrupted.`
    )
  }

  return fileSize
}

async function validateVideoFile(tusFilePath: string, filename?: string) {
  // Validate file extension
  if (filename) {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    // 1.0.9+: accept image extensions too. Image uploads travel
    // through the same `/api/uploads` TUS pipeline but bypass the
    // worker — see `handleVideoUploadFinish` below.
    const allowedExtensions = [
      '.mp4', '.mov', '.avi', '.webm', '.mkv',
      '.jpg', '.jpeg', '.png', '.webp', '.gif',
    ]

    if (!allowedExtensions.includes(ext)) {
      await cleanupTUSFile(tusFilePath)
      throw new Error(
        `Invalid file extension: ${ext}. Allowed: ${allowedExtensions.join(', ')}`
      )
    }
  }

  // NOTE: Magic byte validation is performed in the video-processor worker
  // This ensures proper file content validation happens during processing
  // without causing Next.js build issues with the file-type ESM module
  logMessage(`[UPLOAD] File extension validation passed, magic byte check will run in worker`)
}

async function validateUploadedAssetFile(tusFilePath: string, filename?: string) {
  // Validate file extension
  if (filename) {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    if (!ALL_ALLOWED_EXTENSIONS.includes(ext)) {
      await cleanupTUSFile(tusFilePath)
      throw new Error(
        `Invalid file extension: ${ext}. Allowed: ${ALL_ALLOWED_EXTENSIONS.join(', ')}`
      )
    }
  }

  // NOTE: Magic byte validation is performed in the asset-processor worker
  // This ensures proper file content validation happens during processing
  // without causing Next.js build issues with the file-type ESM module
  logMessage(`[UPLOAD] Asset extension validation passed, magic byte check will run in worker`)
}

/**
 * Phase A — Instant thumbnail.
 *
 * Pulls a single frame out of the freshly-uploaded video file
 * before the heavy worker pipeline runs, so the folder grid /
 * project page can show a real thumbnail within ~3 seconds of
 * upload finish instead of waiting 5-10 minutes for transcoding.
 *
 * Local storage only. In S3 mode the original is in cloud storage
 * and pulling it back just for one frame is a poor tradeoff —
 * worker.processThumbnail will handle it after the file is staged.
 *
 * Soft-fail: any error (ffmpeg missing, file race, etc.) is logged
 * and swallowed — the worker will overwrite with a higher-quality
 * thumbnail later anyway. Uses the SAME storage path the worker
 * uses (`projects/<projectId>/videos/<videoId>/thumbnail.jpg`) so
 * the worker's later write is the authoritative final version.
 */
async function initInstantThumbnail(
  videoId: string,
  projectId: string,
  originalStoragePath: string,
): Promise<void> {
  // Resolve the on-disk location of the master file. In local mode
  // this is the absolute path under STORAGE_DIR.
  const sourcePath = getFilePath(originalStoragePath)
  if (!fs.existsSync(sourcePath)) {
    logMessage(
      `[UPLOAD] Instant thumbnail: source not found at ${sourcePath} for ${videoId}; skipping`,
    )
    return
  }

  // Stage into the worker's TEMP_DIR so we don't pollute /tmp and
  // the worker cleanup sweeps it up later if we leak.
  const tmpRoot = '/tmp/framecomment'
  if (!fs.existsSync(tmpRoot)) {
    fs.mkdirSync(tmpRoot, { recursive: true })
  }
  const tmpThumb = path.join(tmpRoot, `instant-${videoId}.jpg`)

  // Frame 0 — literal first frame, matching the worker's
  // THUMBNAIL_CONFIG (percentage: 0) so the instant version and
  // the worker's eventual rewrite are visually identical. Users
  // expect "the thumbnail = the first frame they'd see if they hit
  // play". generateThumbnail uses `nice -n 10` so it doesn't starve
  // worker transcodes if any are already running.
  try {
    await generateThumbnail(sourcePath, tmpThumb, 0)
  } catch (err) {
    logError(`[UPLOAD] Instant thumbnail ffmpeg failed for ${videoId}:`, err)
    return
  }

  if (!fs.existsSync(tmpThumb)) {
    logMessage(`[UPLOAD] Instant thumbnail: ffmpeg produced no output for ${videoId}`)
    return
  }

  // Upload via the storage abstraction (local → moves to
  // STORAGE_DIR; S3 path won't run, see caller). Use the EXACT
  // path the worker will later write so finalizeVideo's overwrite
  // logic is the authoritative final pass.
  const thumbnailStoragePath = `projects/${projectId}/videos/${videoId}/thumbnail.jpg`
  try {
    const buffer = fs.readFileSync(tmpThumb)
    await uploadFile(thumbnailStoragePath, buffer, buffer.length, 'image/jpeg')
  } catch (err) {
    logError(`[UPLOAD] Instant thumbnail upload failed for ${videoId}:`, err)
    try { fs.unlinkSync(tmpThumb) } catch {}
    return
  }

  try { fs.unlinkSync(tmpThumb) } catch {}

  // Persist on the Video row so the folder grid + project page
  // pick it up on next render.
  try {
    await prisma.video.update({
      where: { id: videoId },
      data: { thumbnailPath: thumbnailStoragePath },
    })
  } catch (err) {
    logError(`[UPLOAD] Instant thumbnail DB update failed for ${videoId}:`, err)
    return
  }

  logMessage(`[UPLOAD] Instant thumbnail ready for ${videoId}`)
}

async function cleanupTUSFile(tusFilePath: string) {
  try {
    if (fs.existsSync(tusFilePath)) {
      fs.unlinkSync(tusFilePath)
    }
    const metadataPath = `${tusFilePath}.json`
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath)
    }
  } catch (cleanupErr) {
    logError('[UPLOAD] Failed to cleanup TUS files:', cleanupErr)
  }
}

async function markVideoAsError(videoId: string, error: any) {
  try {
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: 'ERROR',
        processingError: error instanceof Error ? error.message : 'Unknown upload error'
      }
    })
  } catch (dbError) {
    logError('[UPLOAD] Failed to mark video as ERROR:', dbError)
  }
}

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '1000mb',
    responseLimit: false,
  },
  maxDuration: 3600,
}

function toWebRequest(req: NextApiRequest): Request {
  const protocol = req.headers['x-forwarded-proto'] || 'http'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const url = `${protocol}://${host}${req.url}`

  const headers = new Headers()
  Object.entries(req.headers).forEach(([key, value]) => {
    if (value) {
      headers.set(key, Array.isArray(value) ? value[0] : value)
    }
  })

  let body: ReadableStream | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // @ts-ignore
    body = Readable.toWeb(req)
  }

  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body,
    // @ts-ignore
    duplex: 'half',
  })
}

async function fromWebResponse(webRes: Response, res: NextApiResponse): Promise<void> {
  res.status(webRes.status)

  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  if (webRes.body) {
    const reader = webRes.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  res.end()
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const webRequest = toWebRequest(req)
    const webResponse = await tusServer.handleWeb(webRequest)
    await fromWebResponse(webResponse, res)
  } catch (error) {
    logError('[UPLOAD] Pages Router Error:', error)
    res.status(500).json({
      error: 'Internal server error',
    })
  }
}
