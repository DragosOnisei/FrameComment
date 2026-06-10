import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { ReadStream } from 'fs'
import { pipeline } from 'stream/promises'
import { mkdir } from 'fs/promises'
import { s3UploadFile, s3DownloadFile, s3DeleteFile, s3DeleteDirectory } from './s3-storage'

const STORAGE_ROOT = process.env.STORAGE_ROOT || '/app/uploads'

/** True when STORAGE_PROVIDER=s3 is set. */
export function isS3Mode(): boolean {
  return process.env.STORAGE_PROVIDER === 's3'
}

/**
 * Resolve the directory the TUS server should stage incoming chunks to
 * (1.5.x+).
 *
 * The previous releases hardcoded `/tmp/framecomment-tus-uploads`. On
 * Linux containers (Docker, TrueNAS SCALE, k8s pods) `/tmp` is almost
 * always a small tmpfs — its default size is 50% of the pod's memory
 * limit, so a 2 GB container has a ~1 GB `/tmp`. A 3 GB video upload
 * would soak the tmpfs, the kernel would start writing to swap (or
 * stalling), and the perceived throughput would collapse from
 * line-speed to a trickle. Locally on macOS / a workstation with a
 * roomy `/tmp` the bug was invisible.
 *
 * Resolution order:
 *   1. `TUS_UPLOAD_DIR` env var if explicitly set (operator override).
 *   2. `${STORAGE_ROOT}/.tus-uploads/` — same disk as the final
 *      payload, so we move/rename instead of cross-FS copy, and we
 *      inherit the user-provided dataset capacity. This is the
 *      default for any deploy that sets STORAGE_ROOT (TrueNAS, etc.).
 *   3. `/tmp/framecomment-tus-uploads` as a last-ditch fallback (only
 *      hit when neither env var is set, i.e. someone running the dev
 *      server with absolutely no env).
 */
export function getTusUploadDir(): string {
  if (process.env.TUS_UPLOAD_DIR) return process.env.TUS_UPLOAD_DIR
  if (process.env.STORAGE_ROOT) {
    return path.join(process.env.STORAGE_ROOT, '.tus-uploads')
  }
  return '/tmp/framecomment-tus-uploads'
}

/**
 * Validate a relative storage path against STORAGE_ROOT.
 * Guards against null bytes, URL-encoded traversal, backslashes, and .. sequences.
 */
function validatePath(filePath: string): string {
  if (filePath.includes('\0')) throw new Error('Invalid file path - null byte detected')

  let decoded = filePath
  try {
    decoded = decodeURIComponent(decoded)
    decoded = decodeURIComponent(decoded) // double-decode catches %252e%252e etc.
  } catch {
    decoded = filePath
  }

  decoded = decoded.replace(/\\/g, '/')
  while (decoded.includes('..')) decoded = decoded.replace(/\.\./g, '')

  const fullPath = path.join(STORAGE_ROOT, path.normalize(decoded))
  const realPath = path.resolve(fullPath)
  const realRoot = path.resolve(STORAGE_ROOT)

  if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
    throw new Error('Invalid file path - path traversal detected')
  }

  return fullPath
}

export async function initStorage() {
  // S3 mode: bucket must exist; no local directory needed.
  if (isS3Mode()) return
  await mkdir(STORAGE_ROOT, { recursive: true })
}

export async function uploadFile(
  filePath: string,
  stream: Readable | Buffer,
  size: number,
  contentType: string = 'application/octet-stream'
): Promise<void> {
  if (isS3Mode()) {
    await s3UploadFile(filePath, stream, contentType, size)
    return
  }

  const fullPath = validatePath(filePath)
  const dir = path.dirname(fullPath)

  await mkdir(dir, { recursive: true })

  if (Buffer.isBuffer(stream)) {
    await fs.promises.writeFile(fullPath, stream)
  } else {
    const writeStream = fs.createWriteStream(fullPath)
    await pipeline(stream, writeStream)
  }

  // Verify file was written with correct size
  const stats = await fs.promises.stat(fullPath)
  if (stats.size !== size) {
    await fs.promises.unlink(fullPath).catch(() => {})
    throw new Error(
      `File size mismatch: expected ${size} bytes, got ${stats.size} bytes. ` +
      `Upload may have been corrupted.`
    )
  }
}

/**
 * Move a file into the storage layout (1.5.x+).
 *
 * When the TUS staging dir lives on the SAME filesystem as the final
 * STORAGE_ROOT (the default since 1.5.2 — both under `/app/uploads/`),
 * `fs.rename` is an instant metadata-only operation regardless of file
 * size. The old `uploadFile()` pipeline streamed the staging file
 * through Node and re-wrote it at the destination — which doubled the
 * disk write load (3 GB upload = 6 GB written) and was the dominant
 * bottleneck on HDD-backed datasets without an SSD ZIL/SLOG.
 *
 * If the rename fails with `EXDEV` (cross-filesystem move — happens
 * when an operator points `TUS_UPLOAD_DIR` at a separate volume), we
 * fall back to the streaming copy + unlink behaviour. So this is a
 * pure perf win, not a behaviour change.
 *
 * S3 mode is unaffected — it has its own multipart upload flow and
 * never hits the local staging path.
 */
export async function moveFile(
  srcAbsolutePath: string,
  destRelativePath: string,
  expectedSize: number,
): Promise<void> {
  if (isS3Mode()) {
    // S3 mode shouldn't use this path — the upload route stays on the
    // streaming `uploadFile()` API. Throw so callers don't silently
    // skip the S3 upload.
    throw new Error('moveFile() is not supported in S3 mode')
  }

  const destFullPath = validatePath(destRelativePath)
  const destDir = path.dirname(destFullPath)
  await mkdir(destDir, { recursive: true })

  try {
    await fs.promises.rename(srcAbsolutePath, destFullPath)
  } catch (err: any) {
    // Cross-device move — Node fails with EXDEV. Fall back to a
    // stream copy then unlink the source. Same end state, just
    // slower (one full read + one full write instead of a metadata
    // flip).
    if (err && err.code === 'EXDEV') {
      const readStream = fs.createReadStream(srcAbsolutePath)
      const writeStream = fs.createWriteStream(destFullPath)
      await pipeline(readStream, writeStream)
      await fs.promises.unlink(srcAbsolutePath).catch(() => {})
    } else {
      throw err
    }
  }

  // Verify the destination has the expected size — guards against a
  // partial rename / truncation. Mirrors the check `uploadFile()`
  // does after streaming.
  const stats = await fs.promises.stat(destFullPath)
  if (stats.size !== expectedSize) {
    await fs.promises.unlink(destFullPath).catch(() => {})
    throw new Error(
      `File size mismatch after move: expected ${expectedSize} bytes, got ${stats.size} bytes.`,
    )
  }
}

export async function downloadFile(filePath: string): Promise<Readable> {
  if (isS3Mode()) {
    return s3DownloadFile(filePath)
  }
  const fullPath = validatePath(filePath)
  return fs.createReadStream(fullPath)
}

/**
 * 3.1.0+: Return the absolute on-disk path for a stored file, or null
 * if we're in S3 mode (no local file available).
 *
 * Lets the worker feed ffmpeg the source file DIRECTLY out of
 * STORAGE_ROOT, without first streaming it into /tmp. Before this, a
 * 4K master that gets transcoded to 480p/720p/1080p/2160p would be
 * copied into `/tmp/framecomment/<id>-original` once per tier (because
 * /tmp on Docker is tmpfs and gets reset between jobs) — that's a
 * 16 GB original ending up as ~64 GB of pointless I/O per video, and
 * /tmp pressure on top.
 *
 * With this helper the encoder calls getLocalSourcePath() first;
 * if it returns a path, ffmpeg reads straight from the uploads volume
 * (the file is still validated against STORAGE_ROOT to prevent
 * traversal). If null, we fall through to the old download-into-/tmp
 * path which is still correct for S3 mode (ffmpeg can't seek over an
 * HTTP body, so we have to land it on disk).
 */
export function getLocalSourcePath(filePath: string): string | null {
  if (isS3Mode()) return null
  const fullPath = validatePath(filePath)
  if (!fs.existsSync(fullPath)) return null
  return fullPath
}

export async function deleteFile(filePath: string): Promise<void> {
  if (isS3Mode()) {
    await s3DeleteFile(filePath)
    return
  }
  const fullPath = validatePath(filePath)
  if (fs.existsSync(fullPath)) {
    await fs.promises.unlink(fullPath)
  }
}

export async function deleteDirectory(dirPath: string): Promise<void> {
  if (isS3Mode()) {
    await s3DeleteDirectory(dirPath)
    return
  }
  const fullPath = validatePath(dirPath)
  if (fs.existsSync(fullPath)) {
    await fs.promises.rm(fullPath, { recursive: true, force: true })
  }
}

export function getFilePath(filePath: string): string {
  return validatePath(filePath)
}

const VIDEO_MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
}

export function getVideoContentType(filename: string): string {
  if (!filename) return 'video/mp4'
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return VIDEO_MIME_MAP[ext] || 'video/mp4'
}

/** Convert a Node.js ReadStream to a Web ReadableStream for NextResponse. */
export function createWebReadableStream(fileStream: ReadStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      fileStream.on('data', (chunk) => controller.enqueue(chunk))
      fileStream.on('end', () => controller.close())
      fileStream.on('error', (err) => controller.error(err))
    },
    cancel() {
      fileStream.destroy()
    },
  })
}

/** Strip characters unsafe in Content-Disposition headers (CRLF injection, non-ASCII). */
export function sanitizeFilenameForHeader(filename: string): string {
  if (!filename) return 'download.mp4'

  return filename
    .replace(/["\\]/g, '')         // Remove quotes and backslashes
    .replace(/[\r\n]/g, '')        // Remove CRLF (header injection)
    .replace(/[^\x20-\x7E]/g, '_') // Replace non-ASCII with underscore
    .substring(0, 255)             // Limit length to 255 characters
    .trim() || 'download.mp4'      // Fallback if empty after sanitization
}
