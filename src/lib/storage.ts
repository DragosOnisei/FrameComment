import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { ReadStream } from 'fs'
import { pipeline } from 'stream/promises'
import { mkdir } from 'fs/promises'
import { s3UploadFile, s3DownloadFile, s3DeleteFile, s3DeleteDirectory, s3FileExists, s3GetFileSize, s3ListKeys } from './s3-storage'
import {
  type StorageBackend,
  type S3BackendConfig,
  legacyBackend,
  getS3ConfigForBackend,
  backendIsLocalFilesystem,
} from './storage-backends'

/** The uploads root from the environment (the original, always-present root). */
const ENV_STORAGE_ROOT = process.env.STORAGE_ROOT || '/app/uploads'

// 4.2.0+ (Phase 2d): the LOCAL backend's uploads folder is configurable via
// Settings.localStoragePath. Cached in-process (refreshed on save + TTL) so the
// sync path helpers stay sync. NULL cache → fall back to ENV_STORAGE_ROOT, i.e.
// exactly the pre-4.2.0 behaviour (an instance that never sets a custom folder
// is byte-identical). New WRITES go to the primary root; READS also fall back to
// ENV_STORAGE_ROOT so files stored before a folder change stay reachable.
let _localRootCache: string | null = null
let _localRootFetchedAt = 0
const LOCAL_ROOT_TTL_MS = 30_000

/** Update the cached local root from the DB. Call on settings save + startup. */
export async function refreshLocalStorageRoot(): Promise<void> {
  try {
    // Lazy import to avoid a hard prisma dependency in edge/build contexts.
    const { prisma } = await import('./db')
    const rows = await prisma.$queryRawUnsafe<Array<{ localStoragePath: string | null }>>(
      'SELECT "localStoragePath" FROM "Settings" WHERE id = $1 LIMIT 1',
      'default',
    )
    const v = rows?.[0]?.localStoragePath?.trim()
    _localRootCache = v && v.length ? v : null
  } catch {
    // Table/column missing or DB unreachable — keep env fallback.
    _localRootCache = null
  }
  _localRootFetchedAt = Date.now()
}

/** Primary local uploads root (where new writes go): DB value ?? env. Sync. */
function getPrimaryLocalRoot(): string {
  // Kick off a background refresh when the cache is stale; return the last known
  // value meanwhile (env fallback until the first refresh completes).
  if (Date.now() - _localRootFetchedAt > LOCAL_ROOT_TTL_MS) {
    void refreshLocalStorageRoot()
  }
  return _localRootCache || ENV_STORAGE_ROOT
}

/** Public: the primary local uploads root (for display in Settings). */
export function getLocalUploadsRoot(): string {
  return getPrimaryLocalRoot()
}

/** Every local root a file could live under: primary first, then env fallback. */
function getLocalRoots(): string[] {
  const primary = getPrimaryLocalRoot()
  return primary === ENV_STORAGE_ROOT ? [primary] : [primary, ENV_STORAGE_ROOT]
}

/** True when STORAGE_PROVIDER=s3 is set. */
export function isS3Mode(): boolean {
  return process.env.STORAGE_PROVIDER === 's3'
}

/**
 * 4.2.0+: Resolve a storage operation to either the local filesystem or a
 * specific S3 backend config.
 *
 *  - `backend` omitted → legacy behaviour: local disk, or (when
 *    STORAGE_PROVIDER=s3) the env-based S3 client with no explicit config, so
 *    pre-4.2.0 call sites behave exactly as before.
 *  - `backend` explicit → 'local' uses the filesystem; 'fc'/'r2'/'aws' build
 *    the S3 config for that backend (fc = operator env, r2/aws = Settings).
 */
async function resolveS3Target(
  backend?: StorageBackend
): Promise<{ isS3: boolean; config?: S3BackendConfig }> {
  const b = backend ?? legacyBackend()
  // Local disk: 'local', or 'fc' when it isn't S3-backed (operator's own disk).
  if (backendIsLocalFilesystem(b)) return { isS3: false }
  // Legacy fallback (no explicit backend): let s3-storage use its env config.
  if (!backend) return { isS3: true, config: undefined }
  return { isS3: true, config: await getS3ConfigForBackend(b) }
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
 * Validate a relative storage path against a specific root.
 * Guards against null bytes, URL-encoded traversal, backslashes, and .. sequences.
 * The traversal protection is identical regardless of which root is passed.
 */
function validatePathIn(filePath: string, root: string): string {
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

  const fullPath = path.join(root, path.normalize(decoded))
  const realPath = path.resolve(fullPath)
  const realRoot = path.resolve(root)

  if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
    throw new Error('Invalid file path - path traversal detected')
  }

  return fullPath
}

/** Validate against the PRIMARY local root (where new writes go). */
function validatePath(filePath: string): string {
  return validatePathIn(filePath, getPrimaryLocalRoot())
}

/**
 * Resolve a relative path to the local root that actually holds it — the
 * primary root if the file is there, else the env fallback root (so files
 * stored before a folder change stay reachable). Always validated per-root.
 * Falls back to the primary full path when it exists in neither.
 */
function resolveExistingLocalPath(filePath: string): string {
  for (const root of getLocalRoots()) {
    const full = validatePathIn(filePath, root)
    if (fs.existsSync(full)) return full
  }
  return validatePath(filePath)
}

export async function initStorage() {
  // S3 mode: bucket must exist; no local directory needed.
  if (isS3Mode()) return
  await mkdir(getPrimaryLocalRoot(), { recursive: true })
}

export async function uploadFile(
  filePath: string,
  stream: Readable | Buffer,
  size: number,
  contentType: string = 'application/octet-stream',
  backend?: StorageBackend
): Promise<void> {
  const { isS3, config } = await resolveS3Target(backend)
  if (isS3) {
    await s3UploadFile(filePath, stream, contentType, size, config)
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
  backend?: StorageBackend,
): Promise<void> {
  const b = backend ?? legacyBackend()
  if (!backendIsLocalFilesystem(b)) {
    // Remote (S3-type) backends have no local rename path — the upload route
    // stays on the streaming `uploadFile()` API. Throw so callers don't
    // silently skip the remote upload.
    throw new Error('moveFile() is only supported for local-disk storage')
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

export async function downloadFile(filePath: string, backend?: StorageBackend): Promise<Readable> {
  const { isS3, config } = await resolveS3Target(backend)
  if (isS3) {
    return s3DownloadFile(filePath, config)
  }
  // Read from wherever the file actually lives (primary root, else env root).
  const fullPath = resolveExistingLocalPath(filePath)
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
export function getLocalSourcePath(filePath: string, backend?: StorageBackend): string | null {
  const b = backend ?? legacyBackend()
  if (!backendIsLocalFilesystem(b)) return null
  for (const root of getLocalRoots()) {
    const full = validatePathIn(filePath, root)
    if (fs.existsSync(full)) return full
  }
  return null
}

export async function deleteFile(filePath: string, backend?: StorageBackend): Promise<void> {
  const { isS3, config } = await resolveS3Target(backend)
  if (isS3) {
    await s3DeleteFile(filePath, config)
    return
  }
  // Remove from every local root it might live under (primary + env fallback).
  for (const root of getLocalRoots()) {
    const full = validatePathIn(filePath, root)
    if (fs.existsSync(full)) await fs.promises.unlink(full)
  }
}

export async function deleteDirectory(dirPath: string, backend?: StorageBackend): Promise<void> {
  const { isS3, config } = await resolveS3Target(backend)
  if (isS3) {
    await s3DeleteDirectory(dirPath, config)
    return
  }
  for (const root of getLocalRoots()) {
    const full = validatePathIn(dirPath, root)
    if (fs.existsSync(full)) await fs.promises.rm(full, { recursive: true, force: true })
  }
}

export function getFilePath(filePath: string): string {
  return resolveExistingLocalPath(filePath)
}

/**
 * 4.2.0+ (storage transfer helpers) — backend-aware existence / size / listing.
 * `backend` omitted → legacy env behaviour, same as the other storage fns.
 */
export async function storageFileExists(filePath: string, backend?: StorageBackend): Promise<boolean> {
  const { isS3, config } = await resolveS3Target(backend)
  if (isS3) return s3FileExists(filePath, config)
  for (const root of getLocalRoots()) {
    if (fs.existsSync(validatePathIn(filePath, root))) return true
  }
  return false
}

export async function getStorageFileSize(filePath: string, backend?: StorageBackend): Promise<number> {
  const { isS3, config } = await resolveS3Target(backend)
  if (isS3) return s3GetFileSize(filePath, config)
  const fullPath = resolveExistingLocalPath(filePath)
  const st = await fs.promises.stat(fullPath)
  return st.size
}

/**
 * List every file under a directory/prefix on a backend, returned as storage
 * paths (relative to STORAGE_ROOT for local, object keys for S3 — both are the
 * same shape the rest of the storage API expects). Used to enumerate HLS
 * segment folders during a transfer, which have no per-file DB row.
 */
export async function listStorageDirectory(dirPath: string, backend?: StorageBackend): Promise<string[]> {
  const { isS3, config } = await resolveS3Target(backend)
  if (isS3) return s3ListKeys(dirPath, config)

  // Pick the local root that actually contains this directory (primary, else
  // the env fallback where older files may live).
  let root = ''
  let fullBase = ''
  for (const r of getLocalRoots()) {
    const candidate = validatePathIn(dirPath, r)
    if (fs.existsSync(candidate)) { root = path.resolve(r); fullBase = candidate; break }
  }
  if (!fullBase) return []

  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  await walk(fullBase)
  return out
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
