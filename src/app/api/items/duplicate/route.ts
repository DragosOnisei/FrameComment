/**
 * POST /api/items/duplicate (1.1.0+)
 *
 * Duplicates videos and folders, creating REAL file-level copies in
 * storage (not just shared-path DB clones). Each duplicate lands in
 * `targetFolderId` (or the project root when null) with a unique
 * `(1)`, `(2)` … suffix appended to the name.
 *
 * Body shape:
 *   {
 *     projectId: string,
 *     targetFolderId: string | null,
 *     videoCardIds?: string[],   // card ids (latest version of each
 *                                 //  group); we expand to allIds
 *                                 //  server-side
 *     folderIds?: string[],
 *   }
 *
 * Returns: { videoIds, folderIds } — the freshly-created ids.
 *
 * Implementation notes:
 *
 *   - For each source Video we copy `originalStoragePath` via
 *     downloadFile → uploadFile stream pipe (works for both local FS
 *     and S3), then create a new Video record with status=PROCESSING
 *     and enqueue the worker to regenerate thumbnail / preview /
 *     storyboard. Images mark READY immediately (no worker step) and
 *     reuse the original as their own thumbnail.
 *   - For folders we walk the subtree depth-first, mirroring the
 *     structure under a freshly-minted parent folder.
 *   - Admin-only; rate-limited.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError, logMessage } from '@/lib/logging'
import {
  initStorage,
  downloadFile,
  uploadFile,
  isS3Mode,
} from '@/lib/storage'
import { generateUniqueFolderSlug } from '@/lib/folder-helpers'
import { videoQueue } from '@/lib/queue'
import { Readable } from 'stream'
import * as fs from 'fs'
import * as path from 'path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RECURSION_DEPTH = 20

/**
 * Pick a name that doesn't already exist among `existingNames`.
 * Appends `" (1)"`, `" (2)"`, … to `base` until a free slot opens.
 */
function uniqueName(base: string, existingNames: Set<string>): string {
  if (!existingNames.has(base)) return base
  let n = 1
  // Strip any existing " (N)" suffix so "foo (1)" doesn't become
  // "foo (1) (1)" — we'd rather see "foo (2)".
  const m = base.match(/^(.*?)(?:\s*\((\d+)\))?$/)
  const root = (m?.[1] || base).trim()
  while (existingNames.has(`${root} (${n})`)) n++
  return `${root} (${n})`
}

/**
 * Stat helper that works for both local FS and S3. Returns the file
 * size in bytes — required by `uploadFile`.
 */
async function getFileSize(storagePath: string): Promise<number> {
  if (isS3Mode()) {
    // The S3 helper exposes a HEAD via downloadFile.length when the
    // stream resolves — but we want the size up front. Fall back to
    // streaming and counting bytes.
    const stream = await downloadFile(storagePath)
    let total = 0
    for await (const chunk of stream as any) {
      total += (chunk as Buffer).length
    }
    return total
  }
  // Local FS: stat the resolved path.
  const root = process.env.STORAGE_ROOT || '/app/uploads'
  const full = path.join(root, storagePath)
  const stat = await fs.promises.stat(full)
  return stat.size
}

/**
 * Copy a single storage object from `srcPath` to `destPath`. For
 * local FS this is a streaming file copy; for S3 it's
 * download-then-reupload (less efficient than CopyObject but
 * abstraction-clean).
 */
async function copyStorageFile(
  srcPath: string,
  destPath: string,
  contentType: string,
): Promise<void> {
  if (isS3Mode()) {
    // We need the size up front for uploadFile. Fetch + buffer +
    // upload — fine for thumbnails (KB); for huge originals this is
    // a memory blip but acceptable for MVP.
    const stream = await downloadFile(srcPath)
    const chunks: Buffer[] = []
    for await (const chunk of stream as any) chunks.push(chunk as Buffer)
    const buf = Buffer.concat(chunks)
    await uploadFile(destPath, buf, buf.length, contentType)
    return
  }
  // Local FS path: stat + stream copy.
  const size = await getFileSize(srcPath)
  const stream = await downloadFile(srcPath)
  await uploadFile(destPath, stream as Readable, size, contentType)
}

/**
 * Duplicate a single Video row — including the underlying storage
 * file. Returns the new Video id. Status starts at PROCESSING and we
 * enqueue the worker so derived assets (thumbnail / preview /
 * storyboard) get regenerated from the freshly-copied original.
 *
 * For images we skip the worker entirely (mirrors the regular
 * image-upload flow): we just point the new thumbnail at the new
 * storage path and mark READY.
 */
async function duplicateVideoRow(
  source: any,
  targetFolderId: string | null,
  newName: string,
  adminId: string | null,
): Promise<string> {
  const mediaType: 'VIDEO' | 'IMAGE' = (source.mediaType as any) || 'VIDEO'
  const isImage = mediaType === 'IMAGE'

  const ext = (() => {
    const dot = source.originalFileName?.lastIndexOf('.') ?? -1
    return dot > 0 ? source.originalFileName.slice(dot) : ''
  })()
  const newOriginalPath = `projects/${source.projectId}/videos/dup-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}${ext}`

  // Copy the original file. Mime is just a hint — uploadFile uses it
  // for the S3 ContentType header; the downstream worker only cares
  // about extension.
  const mime = isImage
    ? source.originalFileName?.toLowerCase().endsWith('.png')
      ? 'image/png'
      : source.originalFileName?.toLowerCase().endsWith('.webp')
        ? 'image/webp'
        : source.originalFileName?.toLowerCase().endsWith('.gif')
          ? 'image/gif'
          : 'image/jpeg'
    : 'video/mp4'
  await copyStorageFile(source.originalStoragePath, newOriginalPath, mime)

  // Create the new record. For images we point thumbnail at the same
  // path (the file IS the thumbnail) and go straight to READY. For
  // videos we leave thumbnail/preview/storyboard null and let the
  // worker regenerate them.
  const base = {
    projectId: source.projectId,
    folderId: targetFolderId,
    name: newName,
    version: 1,
    versionLabel: 'v1',
    originalFileName: source.originalFileName,
    originalFileSize: source.originalFileSize,
    originalStoragePath: newOriginalPath,
    duration: isImage ? 0 : source.duration,
    width: source.width,
    height: source.height,
    fps: source.fps ?? null,
    codec: source.codec ?? null,
    status: (isImage ? 'READY' : 'PROCESSING') as 'READY' | 'PROCESSING',
    processingProgress: isImage ? 100 : 0,
    thumbnailPath: isImage ? newOriginalPath : null,
    mediaType,
    approved: false,
  } as any

  const data = adminId ? { ...base, createdById: adminId } : base
  let created: any
  try {
    created = await prisma.video.create({ data })
  } catch {
    // Older schemas without createdById — retry without it.
    created = await prisma.video.create({ data: base })
  }

  // For videos, enqueue the worker so the derived assets get
  // regenerated from the new original. The worker re-uses the same
  // pipeline as a fresh upload.
  if (!isImage) {
    try {
      // 2.2.0+: enqueue prepare-video (prio 1) instead of legacy
      // process-video. The breadth-first pipeline fans out into
      // encode-tier + finalize-video jobs in the worker.
      await videoQueue.add(
        'prepare-video',
        {
          videoId: created.id,
          originalStoragePath: newOriginalPath,
          projectId: source.projectId,
        },
        { priority: 1, jobId: `prepare-${created.id}` },
      )
    } catch (err) {
      logError('[duplicate] enqueue failed', err)
    }
  }
  return created.id
}

/**
 * Duplicate a whole video group (a "card" = all versions sharing the
 * same name). Every version becomes a new Video row pointing at its
 * own freshly-copied storage file. Returns the new card id (the new
 * latest-version row).
 */
async function duplicateVideoGroup(
  cardId: string,
  targetFolderId: string | null,
  takenNames: Set<string>,
  adminId: string | null,
): Promise<string | null> {
  const card = await prisma.video.findUnique({
    where: { id: cardId },
    select: { name: true, projectId: true },
  })
  if (!card) return null
  // All versions in the source group.
  const versions = await prisma.video.findMany({
    where: { projectId: card.projectId, name: card.name } as any,
    orderBy: { version: 'asc' },
  })
  if (versions.length === 0) return null

  // Pick a target name that doesn't collide with anything in the
  // destination folder (or with already-claimed dup names this run).
  const newName = uniqueName(card.name, takenNames)
  takenNames.add(newName)

  let latestId: string | null = null
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]
    const newId = await duplicateVideoRow(v, targetFolderId, newName, adminId)
    // Patch the version + label of the new row to match the source's
    // shape (duplicateVideoRow seeds v1/'v1' by default).
    await prisma.video.update({
      where: { id: newId },
      data: {
        version: v.version,
        versionLabel: v.versionLabel,
      },
    })
    latestId = newId
  }
  return latestId
}

/**
 * Recursively duplicate a folder under `targetParentFolderId`. Walks
 * the subtree depth-first, creating new Folder rows + duplicating
 * each video group.
 */
async function duplicateFolderRecursive(
  sourceFolderId: string,
  targetParentFolderId: string | null,
  takenNamesAtTarget: Set<string>,
  adminId: string | null,
  depth: number = 0,
): Promise<string | null> {
  if (depth > MAX_RECURSION_DEPTH) {
    logMessage('[duplicate] hit max folder recursion depth')
    return null
  }
  const src = await prisma.folder.findUnique({
    where: { id: sourceFolderId },
  })
  if (!src) return null

  const newName = uniqueName(src.name, takenNamesAtTarget)
  takenNamesAtTarget.add(newName)

  const newFolder = await prisma.folder.create({
    data: {
      projectId: src.projectId,
      parentFolderId: targetParentFolderId,
      name: newName,
      slug: await generateUniqueFolderSlug(),
      authMode: 'NONE',
      createdById: adminId ?? null,
    } as any,
  })

  // Take stock of names already inside the NEW folder (empty at
  // creation, but used by helpers that may have added entries).
  const innerTaken = new Set<string>()

  // Duplicate every video group living directly inside the source.
  const videos = await prisma.video.findMany({
    where: { folderId: sourceFolderId, deletedAt: null } as any,
    select: { id: true, name: true, version: true },
  })
  // Reduce to one card per name (latest version) so we don't process
  // versions in isolation.
  const groupsByName = new Map<string, { id: string; version: number }>()
  for (const v of videos) {
    const prev = groupsByName.get(v.name)
    if (!prev || v.version > prev.version) {
      groupsByName.set(v.name, { id: v.id, version: v.version })
    }
  }
  for (const { id } of groupsByName.values()) {
    await duplicateVideoGroup(id, newFolder.id, innerTaken, adminId)
  }

  // Recurse into sub-folders.
  const subs = await prisma.folder.findMany({
    where: { parentFolderId: sourceFolderId, deletedAt: null } as any,
    select: { id: true },
  })
  for (const s of subs) {
    await duplicateFolderRecursive(
      s.id,
      newFolder.id,
      innerTaken,
      adminId,
      depth + 1,
    )
  }

  return newFolder.id
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult
  const admin = authResult

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 20,
      message: 'Too many duplicate requests. Please slow down.',
    },
    'admin-items-duplicate',
  )
  if (rl) return rl

  try {
    const body = await request.json()
    const projectId: string | undefined = body?.projectId
    const targetFolderId: string | null =
      typeof body?.targetFolderId === 'string' ? body.targetFolderId : null
    const videoCardIds: string[] = Array.isArray(body?.videoCardIds)
      ? body.videoCardIds.filter((x: any) => typeof x === 'string')
      : []
    const folderIds: string[] = Array.isArray(body?.folderIds)
      ? body.folderIds.filter((x: any) => typeof x === 'string')
      : []

    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 },
      )
    }
    if (videoCardIds.length === 0 && folderIds.length === 0) {
      return NextResponse.json(
        { error: 'At least one video or folder is required' },
        { status: 400 },
      )
    }
    // Sanity caps so an accidental bulk doesn't tie up the worker
    // for an hour.
    if (videoCardIds.length + folderIds.length > 100) {
      return NextResponse.json(
        { error: 'Too many items to duplicate in one request' },
        { status: 400 },
      )
    }

    // Confirm targetFolderId belongs to the same project (if set).
    if (targetFolderId) {
      const f = await prisma.folder.findUnique({
        where: { id: targetFolderId },
        select: { id: true, projectId: true },
      })
      if (!f || f.projectId !== projectId) {
        return NextResponse.json(
          { error: 'Target folder not in this project' },
          { status: 400 },
        )
      }
    }

    await initStorage()

    // Pre-load the set of names already taken at the destination so
    // unique-suffixing works across both videos and folders.
    const folderFilter =
      targetFolderId === null ? { folderId: null } : { folderId: targetFolderId }
    const [existingVideoNames, existingFolderNames] = await Promise.all([
      prisma.video.findMany({
        where: { projectId, ...folderFilter, deletedAt: null } as any,
        select: { name: true },
      }),
      prisma.folder.findMany({
        where: {
          projectId,
          parentFolderId: targetFolderId,
          deletedAt: null,
        } as any,
        select: { name: true },
      }),
    ])
    const taken = new Set<string>([
      ...existingVideoNames.map((v) => v.name),
      ...existingFolderNames.map((f) => f.name),
    ])

    const newVideoIds: string[] = []
    for (const cardId of videoCardIds) {
      const id = await duplicateVideoGroup(
        cardId,
        targetFolderId,
        taken,
        admin.id || null,
      )
      if (id) newVideoIds.push(id)
    }

    const newFolderIds: string[] = []
    for (const fid of folderIds) {
      const id = await duplicateFolderRecursive(
        fid,
        targetFolderId,
        taken,
        admin.id || null,
      )
      if (id) newFolderIds.push(id)
    }

    return NextResponse.json({
      videoIds: newVideoIds,
      folderIds: newFolderIds,
    })
  } catch (error) {
    logError('[POST /api/items/duplicate] failed:', error)
    return NextResponse.json(
      { error: 'Failed to duplicate items' },
      { status: 500 },
    )
  }
}
