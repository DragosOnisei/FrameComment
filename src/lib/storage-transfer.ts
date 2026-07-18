/**
 * 4.2.0+ (Phase 2) — Storage transfer.
 *
 * Migrates every existing file that lives on a backend OTHER than the currently
 * active one over to the active backend, then removes the source copy. The flow
 * per file is deliberately safe:
 *
 *   1. If the file is already on the target (resumable / idempotent) → skip.
 *   2. Copy source → target (streamed).
 *   3. Verify the destination byte size matches the source.
 *   4. Only after ALL of an entity's files are verified: retag the row's
 *      `storageBackend` to the target so reads resolve to the new location.
 *   5. Delete the source copies (best-effort — a failed delete never loses data,
 *      it just leaves an orphan the operator can sweep later).
 *
 * A copy/verify failure aborts that ONE entity (its source is left intact and
 * untagged) and the transfer moves on; nothing is ever deleted before a
 * verified copy exists on the target.
 *
 * Progress + a cancel flag live in Redis so the admin UI can poll status and
 * stop a long run. The whole thing runs inside the BullMQ worker (it can take
 * hours for a large library), never in a Next request.
 */
import { prisma } from './db'
import { getRedis } from './redis'
import {
  downloadFile,
  uploadFile,
  deleteFile,
  deleteDirectory,
  storageFileExists,
  getStorageFileSize,
  listStorageDirectory,
  getLocalUploadsRoot,
} from './storage'
import {
  getActiveBackend,
  resolveFileBackend,
  backendLabel,
  describeBackend,
  parseLocations,
  formatLocations,
  STORAGE_BACKENDS,
  type StorageBackend,
} from './storage-backends'
import { logError, logMessage } from './logging'

const STATE_KEY = 'storage-transfer:state'
const CANCEL_KEY = 'storage-transfer:cancel'
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60

export interface TransferState {
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  // 'transfer' = copy files to the active backend (keeps sources).
  // 'purge'    = re-verify + delete every copy on `purgeBackend`.
  mode: 'transfer' | 'purge'
  target: StorageBackend | null
  targetLabel: string
  purgeBackend: StorageBackend | null
  total: number
  processed: number
  copiedFiles: number
  deletedFiles: number
  skipped: number
  failed: number
  currentLabel: string
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  recentErrors: string[]
}

function emptyState(): TransferState {
  return {
    status: 'idle',
    mode: 'transfer',
    target: null,
    targetLabel: '',
    purgeBackend: null,
    total: 0,
    processed: 0,
    copiedFiles: 0,
    deletedFiles: 0,
    skipped: 0,
    failed: 0,
    currentLabel: '',
    startedAt: null,
    finishedAt: null,
    error: null,
    recentErrors: [],
  }
}

export async function getTransferState(): Promise<TransferState> {
  try {
    const raw = await getRedis().get(STATE_KEY)
    if (!raw) return emptyState()
    return { ...emptyState(), ...(JSON.parse(raw) as Partial<TransferState>) }
  } catch {
    return emptyState()
  }
}

async function saveState(state: TransferState): Promise<void> {
  try {
    await getRedis().set(STATE_KEY, JSON.stringify(state), 'EX', STATE_TTL_SECONDS)
  } catch (err) {
    logError('[storage-transfer] failed to persist state:', err)
  }
}

export async function requestCancel(): Promise<void> {
  try {
    await getRedis().set(CANCEL_KEY, '1', 'EX', STATE_TTL_SECONDS)
  } catch (err) {
    logError('[storage-transfer] failed to set cancel flag:', err)
  }
}

async function isCancelled(): Promise<boolean> {
  try {
    return (await getRedis().get(CANCEL_KEY)) === '1'
  } catch {
    return false
  }
}

async function clearCancel(): Promise<void> {
  try {
    await getRedis().del(CANCEL_KEY)
  } catch {
    /* ignore */
  }
}

class CancelledError extends Error {}

function guessContentType(p: string): string {
  const lower = p.toLowerCase()
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (lower.endsWith('.ts')) return 'video/mp2t'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

type CopyResult = 'copied' | 'exists' | 'missing'

/** Copy one file from `from` → `to`, verifying the size. Idempotent + resumable. */
async function copyOneFile(pathStr: string, from: StorageBackend, to: StorageBackend): Promise<CopyResult> {
  const targetExists = await storageFileExists(pathStr, to)
  const sourceExists = await storageFileExists(pathStr, from)

  if (targetExists) {
    if (!sourceExists) {
      // Source already gone. Sources are only ever deleted AFTER a verified
      // copy, so a present target + absent source means this file was fully
      // migrated on a prior run. Nothing to do.
      return 'exists'
    }
    // Both exist — a prior run may have been interrupted mid-copy, leaving a
    // TRUNCATED target. Never trust the target on size alone: verify it's a
    // complete copy before we (later) delete the source. Re-copy on mismatch.
    const [srcSize, dstSize] = await Promise.all([
      getStorageFileSize(pathStr, from),
      getStorageFileSize(pathStr, to),
    ])
    if (srcSize === dstSize) return 'exists'
    await deleteFile(pathStr, to).catch(() => {})
  } else if (!sourceExists) {
    // Neither side has it (dangling DB path) → skip, non-fatal.
    return 'missing'
  }

  const size = await getStorageFileSize(pathStr, from)
  const stream = await downloadFile(pathStr, from)
  await uploadFile(pathStr, stream, size, guessContentType(pathStr), to)

  const destSize = await getStorageFileSize(pathStr, to)
  if (destSize !== size) {
    throw new Error(`size mismatch copying "${pathStr}": source=${size} dest=${destSize}`)
  }
  return 'copied'
}

interface WorkItem {
  kind: string // 'Video' | 'VideoAsset' | 'ProjectUpload' | 'FolderDocument'
  id: string
  label: string
  from: StorageBackend // primary (read) backend = copy source
  locations: StorageBackend[] // every backend this file currently lives on
  files: string[]
  hlsBasePath: string | null
}

function pushIf(arr: string[], v: unknown) {
  if (typeof v === 'string' && v.length) arr.push(v)
}

/** Current physical locations of a row: its parsed list, always including the primary. */
function currentLocations(storageBackend: unknown, storageLocations: unknown): { primary: StorageBackend; locations: StorageBackend[] } {
  const primary = resolveFileBackend(storageBackend as string | null)
  const parsed = parseLocations(storageLocations as string | null)
  const locations = parsed.length ? [...parsed] : [primary]
  if (!locations.includes(primary)) locations.push(primary)
  return { primary, locations }
}

/**
 * Enumerate EVERY stored entity with its files + current physical locations.
 * Callers filter for what they need (transfer copies to active; purge deletes
 * from a specific backend; status counts per backend).
 */
async function enumerateAll(): Promise<WorkItem[]> {
  const items: WorkItem[] = []

  const videos = await (prisma as any).video.findMany({
    select: {
      id: true, name: true, versionLabel: true, storageBackend: true, storageLocations: true, hlsBasePath: true,
      originalStoragePath: true, thumbnailPath: true, storyboardPath: true,
      preview480Path: true, preview720Path: true, preview1080Path: true, preview2160Path: true,
      cleanPreview720Path: true, cleanPreview1080Path: true, cleanPreview2160Path: true,
    },
  })
  for (const v of videos as any[]) {
    const { primary, locations } = currentLocations(v.storageBackend, v.storageLocations)
    const files: string[] = []
    pushIf(files, v.originalStoragePath)
    pushIf(files, v.thumbnailPath)
    pushIf(files, v.storyboardPath)
    pushIf(files, v.preview480Path)
    pushIf(files, v.preview720Path)
    pushIf(files, v.preview1080Path)
    pushIf(files, v.preview2160Path)
    pushIf(files, v.cleanPreview720Path)
    pushIf(files, v.cleanPreview1080Path)
    pushIf(files, v.cleanPreview2160Path)
    items.push({
      kind: 'Video',
      id: v.id,
      label: `Video: ${v.name}${v.versionLabel ? ` ${v.versionLabel}` : ''}`,
      from: primary,
      locations,
      files,
      hlsBasePath: v.hlsBasePath || null,
    })
  }

  const assets = await (prisma as any).videoAsset.findMany({
    select: { id: true, fileName: true, storagePath: true, storageBackend: true, storageLocations: true },
  })
  for (const a of assets as any[]) {
    if (!a.storagePath) continue
    const { primary, locations } = currentLocations(a.storageBackend, a.storageLocations)
    items.push({ kind: 'VideoAsset', id: a.id, label: `Attachment: ${a.fileName || a.id}`, from: primary, locations, files: [a.storagePath], hlsBasePath: null })
  }

  const uploads = await (prisma as any).projectUpload.findMany({
    select: { id: true, fileName: true, storagePath: true, storageBackend: true, storageLocations: true },
  })
  for (const u of uploads as any[]) {
    if (!u.storagePath) continue
    const { primary, locations } = currentLocations(u.storageBackend, u.storageLocations)
    items.push({ kind: 'ProjectUpload', id: u.id, label: `Upload: ${u.fileName || u.id}`, from: primary, locations, files: [u.storagePath], hlsBasePath: null })
  }

  const documents = await (prisma as any).folderDocument.findMany({
    select: { id: true, name: true, storagePath: true, storageBackend: true, storageLocations: true },
  })
  for (const d of documents as any[]) {
    if (!d.storagePath) continue
    const { primary, locations } = currentLocations(d.storageBackend, d.storageLocations)
    items.push({ kind: 'FolderDocument', id: d.id, label: `Document: ${d.name || d.id}`, from: primary, locations, files: [d.storagePath], hlsBasePath: null })
  }

  return items
}

/** Every file path an item owns, including HLS segments listed from `backend`. */
async function allFilePaths(item: WorkItem, backend: StorageBackend): Promise<string[]> {
  const paths = [...item.files]
  if (item.hlsBasePath) {
    const hlsKeys = await listStorageDirectory(item.hlsBasePath, backend)
    paths.push(...hlsKeys)
  }
  return Array.from(new Set(paths))
}

async function retag(kind: string, id: string, target: StorageBackend, locations: StorageBackend[]): Promise<void> {
  // `kind` is one of our own constant table names — safe to interpolate.
  await prisma.$executeRawUnsafe(
    `UPDATE "${kind}" SET "storageBackend" = $1, "storageLocations" = $2 WHERE id = $3`,
    target,
    formatLocations(locations),
    id,
  )
}

/**
 * Copy every file that isn't already on the ACTIVE backend over to it, keeping
 * the sources (each file then lives on both backends). Never deletes anything —
 * deletion is a separate, explicit step (runStoragePurge). Safe to re-run:
 * files already on the active backend are skipped.
 */
export async function runStorageTransfer(): Promise<void> {
  const target = await getActiveBackend()
  await clearCancel()

  const state: TransferState = {
    ...emptyState(),
    status: 'running',
    mode: 'transfer',
    target,
    targetLabel: backendLabel(target),
    startedAt: Date.now(),
  }
  await saveState(state)

  const recordError = (msg: string) => {
    state.failed += 1
    state.recentErrors = [...state.recentErrors, msg].slice(-10)
    logError(`[storage-transfer] ${msg}`)
  }

  try {
    const all = await enumerateAll()
    // Only entities not yet on the target need a copy.
    const work = all.filter((it) => !it.locations.includes(target))
    state.total = work.length
    await saveState(state)

    logMessage(`[storage-transfer] Transfer start: ${work.length} entities → ${backendLabel(target)}`)

    for (const item of work) {
      if (await isCancelled()) throw new CancelledError()
      state.currentLabel = item.label
      await saveState(state)

      try {
        const paths = await allFilePaths(item, item.from)
        for (const p of paths) {
          if (await isCancelled()) throw new CancelledError()
          const r = await copyOneFile(p, item.from, target)
          if (r === 'copied') {
            state.copiedFiles += 1
            await saveState(state)
          }
        }
        // Retag: reads now resolve to the target; record BOTH locations.
        const newLocations = Array.from(new Set([...item.locations, target]))
        await retag(item.kind, item.id, target, newLocations)
        state.processed += 1
      } catch (err) {
        if (err instanceof CancelledError) throw err
        recordError(`${item.label}: ${(err as Error)?.message || String(err)}`)
        state.processed += 1
      }
      await saveState(state)
    }

    state.status = 'completed'
    state.currentLabel = ''
    state.finishedAt = Date.now()
    await saveState(state)
    logMessage(
      `[storage-transfer] Transfer done: ${state.processed}/${state.total} entities, ${state.copiedFiles} files copied, ${state.failed} failed`,
    )
  } catch (err) {
    await finalizeError(state, err, 'Transfer')
    if (!(err instanceof CancelledError)) throw err
  }
}

/**
 * Delete every copy on `purgeBackend`, but ONLY after re-verifying that each of
 * its files also exists (size-matched) on the ACTIVE backend. Anything not
 * fully mirrored is left untouched (and reported) — nothing is ever deleted
 * without a confirmed copy elsewhere. `purgeBackend` must not be the active one.
 */
export async function runStoragePurge(purgeBackend: StorageBackend): Promise<void> {
  const target = await getActiveBackend()
  await clearCancel()

  const state: TransferState = {
    ...emptyState(),
    status: 'running',
    mode: 'purge',
    target,
    targetLabel: backendLabel(target),
    purgeBackend,
    startedAt: Date.now(),
  }
  await saveState(state)

  const recordError = (msg: string) => {
    state.failed += 1
    state.recentErrors = [...state.recentErrors, msg].slice(-10)
    logError(`[storage-transfer] ${msg}`)
  }

  try {
    if (purgeBackend === target) {
      throw new Error('Cannot delete the active storage backend')
    }

    const all = await enumerateAll()
    // Entities that still have a copy on the backend we're purging.
    const work = all.filter((it) => it.locations.includes(purgeBackend))
    state.total = work.length
    await saveState(state)

    logMessage(
      `[storage-transfer] Purge start: ${work.length} entities on ${backendLabel(purgeBackend)} (verify against ${backendLabel(target)})`,
    )

    for (const item of work) {
      if (await isCancelled()) throw new CancelledError()
      state.currentLabel = item.label
      await saveState(state)

      try {
        const paths = await allFilePaths(item, purgeBackend)

        // RE-VERIFY: every file must exist + size-match on the active backend
        // before we delete anything from purgeBackend.
        let verified = true
        for (const p of paths) {
          if (await isCancelled()) throw new CancelledError()
          const srcExists = await storageFileExists(p, purgeBackend)
          if (!srcExists) continue // already gone on source — fine
          const dstExists = await storageFileExists(p, target)
          if (!dstExists) { verified = false; break }
          const [sSize, dSize] = await Promise.all([
            getStorageFileSize(p, purgeBackend),
            getStorageFileSize(p, target),
          ])
          if (sSize !== dSize) { verified = false; break }
        }

        if (!verified) {
          recordError(`${item.label}: not fully on ${backendLabel(target)} yet — run Transfer first (skipped, nothing deleted)`)
          state.processed += 1
          await saveState(state)
          continue
        }

        // Verified — delete the copies from purgeBackend.
        for (const p of item.files) {
          await deleteFile(p, purgeBackend).catch(() => {})
        }
        if (item.hlsBasePath) {
          await deleteDirectory(item.hlsBasePath, purgeBackend).catch(() => {})
        }
        state.deletedFiles += paths.length

        // Drop purgeBackend from the location list; keep storageBackend = target.
        const newLocations = item.locations.filter((b) => b !== purgeBackend)
        await retag(item.kind, item.id, target, newLocations.length ? newLocations : [target])
        state.processed += 1
      } catch (err) {
        if (err instanceof CancelledError) throw err
        recordError(`${item.label}: ${(err as Error)?.message || String(err)}`)
        state.processed += 1
      }
      await saveState(state)
    }

    state.status = 'completed'
    state.currentLabel = ''
    state.finishedAt = Date.now()
    await saveState(state)
    logMessage(
      `[storage-transfer] Purge done: ${state.processed}/${state.total} entities, ${state.deletedFiles} files deleted from ${backendLabel(purgeBackend)}, ${state.failed} skipped`,
    )
  } catch (err) {
    await finalizeError(state, err, 'Purge')
    if (!(err instanceof CancelledError)) throw err
  }
}

/** Shared terminal-state handling for cancel / fatal error. */
async function finalizeError(state: TransferState, err: unknown, what: string): Promise<void> {
  if (err instanceof CancelledError) {
    state.status = 'cancelled'
    state.currentLabel = ''
    state.finishedAt = Date.now()
    await saveState(state)
    await clearCancel()
    logMessage(`[storage-transfer] ${what} cancelled by admin`)
    return
  }
  state.status = 'error'
  state.error = (err as Error)?.message || String(err)
  state.finishedAt = Date.now()
  await saveState(state)
  logError(`[storage-transfer] ${what} fatal error:`, err)
}

export interface BackendStatus {
  backend: StorageBackend
  label: string
  isActive: boolean
  fileCount: number
  /** Sum of the known file sizes (originals + assets + uploads + documents) on
   *  this backend. A file kept on two backends counts toward both. Derived
   *  files (previews/HLS) have no DB size, so this matches the billing metric. */
  bytes: number
  /** Mount path / location descriptor (disk path or bucket@endpoint, no secret). */
  mountPath: string
  /** True when every file on this backend also lives on the active backend
   *  (i.e. it's safe to delete this backend's copies). */
  fullyMirroredOnActive: boolean
}

const numOr0 = (v: unknown): number => {
  if (v == null) return 0
  const n = typeof v === 'bigint' ? Number(v) : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Per-backend usage (count + bytes) + mount path + mirror status, for the
 *  Settings storage cards. Reads only location + size columns (not path fields). */
export async function computeBackendStatus(): Promise<{ active: StorageBackend; backends: BackendStatus[] }> {
  const active = await getActiveBackend()

  const [videos, assets, uploads, documents] = await Promise.all([
    (prisma as any).video.findMany({ select: { storageBackend: true, storageLocations: true, originalFileSize: true } }),
    (prisma as any).videoAsset.findMany({ select: { storageBackend: true, storageLocations: true, fileSize: true } }),
    (prisma as any).projectUpload.findMany({ select: { storageBackend: true, storageLocations: true, fileSize: true } }),
    (prisma as any).folderDocument.findMany({ select: { storageBackend: true, storageLocations: true, size: true } }),
  ])

  const stat = new Map<StorageBackend, { count: number; bytes: number; notOnActive: number }>()
  for (const b of STORAGE_BACKENDS) stat.set(b, { count: 0, bytes: 0, notOnActive: 0 })

  const tally = (rows: any[], sizeField: string) => {
    for (const row of rows) {
      const { locations } = currentLocations(row.storageBackend, row.storageLocations)
      const size = numOr0(row[sizeField])
      for (const b of locations) {
        const s = stat.get(b)!
        s.count += 1
        s.bytes += size
        if (b !== active && !locations.includes(active)) s.notOnActive += 1
      }
    }
  }
  tally(videos, 'originalFileSize')
  tally(assets, 'fileSize')
  tally(uploads, 'fileSize')
  tally(documents, 'size')

  const localRoot = getLocalUploadsRoot()
  const shown = STORAGE_BACKENDS.filter((b) => stat.get(b)!.count > 0 || b === active)
  const backends: BackendStatus[] = await Promise.all(
    shown.map(async (b) => {
      const s = stat.get(b)!
      return {
        backend: b,
        label: backendLabel(b),
        isActive: b === active,
        fileCount: s.count,
        bytes: s.bytes,
        mountPath: await describeBackend(b, localRoot),
        fullyMirroredOnActive: b !== active && s.count > 0 && s.notOnActive === 0,
      }
    }),
  )

  return { active, backends }
}
