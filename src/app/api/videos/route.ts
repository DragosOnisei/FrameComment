import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import {
  isImageExtension,
  isImageMime,
  validateUploadedFile,
} from '@/lib/file-validation'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const videoMessages = messages?.videos || {}

  // SECURITY: Require admin authentication
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }
  const admin = authResult

  // 1.7.1+: rate limit removed for admin uploads. Editors routinely
  // dump 50–200 files into a project in one go (e.g. a full episode
  // export folder); the old 50/hour cap turned every bulk upload
  // into "Too many video uploads. Please try again later." after
  // the first batch. Authentication via `requireApiAdmin` above
  // already gates the route to logged-in admins, so trust the
  // caller and don't second-guess the volume.

  try {
    const body = await request.json()
    const { projectId, versionLabel, originalFileName, originalFileSize, name, mimeType, folderId } = body

    // Validate required fields
    if (!name || !name.trim()) {
  return NextResponse.json({ error: videoMessages.videoNameRequired || 'Video name is required' }, { status: 400 })
    }

    // If a folderId is provided, validate that it belongs to the same
    // project — otherwise drop it silently so we don't leak a video
    // into someone else's folder tree (1.0.6+).
    let resolvedFolderId: string | null = null
    if (folderId && typeof folderId === 'string') {
      const folder = await prisma.folder.findUnique({
        where: { id: folderId },
        select: { id: true, projectId: true },
      })
      if (folder && folder.projectId === projectId) {
        resolvedFolderId = folder.id
      }
    }

    const videoName = name.trim()

    // Validate uploaded file
    const fileValidation = validateUploadedFile(
      originalFileName || 'upload.mp4',
      mimeType || 'video/mp4',
      originalFileSize || 0
    )

    if (!fileValidation.valid) {
      return NextResponse.json(
        { error: fileValidation.error || 'Invalid file' },
        { status: 400 }
      )
    }

    // 1.0.6+: every new upload starts as its OWN v1 group. Stacking
    // happens explicitly via drag-drop or POST /api/videos/[id]/stack,
    // not implicitly by filename collision. To allow re-uploading
    // files with the same name without auto-stacking them, we
    // file-system-style suffix the name when there's a collision in
    // the same folder.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    })

    if (!project) {
      return NextResponse.json(
        { error: videoMessages.projectNotFoundApi || 'Project not found' },
        { status: 404 },
      )
    }

    const nextVersion = 1

    // Detect whether this upload is an image or a real video (1.0.9+).
    // We check both the MIME type AND the filename extension so the
    // route survives browsers that hand us a bogus or generic MIME.
    const isImage =
      isImageMime(mimeType || '') ||
      isImageExtension(originalFileName || '')

    // Base row fields (the unique `name` is resolved inside the locked
    // transaction below). `mediaType` via `as any` so the route still
    // compiles against an older generated Prisma client.
    const baseCreate = {
      projectId,
      folderId: resolvedFolderId,
      version: nextVersion,
      versionLabel: versionLabel || `v${nextVersion}`,
      originalFileName,
      originalFileSize: BigInt(originalFileSize),
      originalStoragePath: `projects/${projectId}/videos/original-${Date.now()}-${originalFileName}`,
      status: 'UPLOADING' as const,
      duration: 0,
      width: 0,
      height: 0,
      mediaType: isImage ? 'IMAGE' : 'VIDEO',
    } as any

    // 4.1.7+: resolve a UNIQUE name in this (project, folder) scope and
    // create the row, SERIALIZED per base-name with a Postgres advisory
    // lock. Two videos uploaded AT THE SAME TIME used to both read "no
    // conflict" before either committed, land the same `name`, and then
    // the folder view grouped them into one card with two "v1"s
    // (accidental auto-versioning). The lock makes the second upload see
    // the first and fall back to "name (2)", so simultaneous uploads stay
    // SEPARATE. Intentional versioning is unaffected — that goes through
    // the explicit /stack endpoint, never a name collision.
    const folderKey = resolvedFolderId === null ? 'root' : resolvedFolderId
    const lockKey = `video-name:${projectId}:${folderKey}:${videoName}`
    // 32-bit signed hash of the lock key (fits in a Postgres bigint).
    let lockInt = 0
    for (let i = 0; i < lockKey.length; i++) {
      lockInt = (Math.imul(31, lockInt) + lockKey.charCodeAt(i)) | 0
    }

    // Resolve the next free name in this (project, folder) scope using
    // the given client (a tx when we hold the advisory lock).
    const resolveUniqueName = async (client: typeof prisma): Promise<string> => {
      const folderFilter =
        resolvedFolderId === null ? { folderId: null } : { folderId: resolvedFolderId }
      const conflicts = await client.video.findMany({
        where: {
          projectId,
          ...folderFilter,
          OR: [{ name: videoName }, { name: { startsWith: `${videoName} (` } }],
        },
        select: { name: true },
      })
      if (conflicts.some((v: { name: string }) => v.name === videoName)) {
        let n = 2
        const taken = new Set(conflicts.map((v: { name: string }) => v.name))
        while (taken.has(`${videoName} (${n})`)) n++
        return `${videoName} (${n})`
      }
      return videoName
    }

    const createRow = async (client: typeof prisma, finalName: string) => {
      try {
        return await client.video.create({
          data: { ...baseCreate, name: finalName, createdById: admin.id },
        })
      } catch {
        // Fall back without createdById — very old dev DBs.
        return await client.video.create({ data: { ...baseCreate, name: finalName } })
      }
    }

    let video
    try {
      // Primary path: serialize same-name uploads with an advisory lock
      // so two simultaneous uploads don't both land the same name (which
      // the folder view would then group into one card = accidental
      // versioning). `$executeRawUnsafe` avoids deserialising the void
      // result. Held until the tx commits.
      video = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::bigint)', lockInt)
        const finalName = await resolveUniqueName(tx as unknown as typeof prisma)
        return createRow(tx as unknown as typeof prisma, finalName)
      })
    } catch (lockErr) {
      // If the advisory lock / transaction isn't supported for any
      // reason, NEVER break the upload — fall back to an unlocked create
      // (the pre-4.1.7 behaviour). Worst case is the rare simultaneous
      // collision, which the user can split with a rename.
      logError('[videos] locked create failed, falling back to unlocked:', lockErr)
      const finalName = await resolveUniqueName(prisma)
      video = await createRow(prisma, finalName)
    }

    // Return videoId - TUS will handle upload directly
    return NextResponse.json({
      videoId: video.id,
    })
  } catch (error) {
    logError('Error creating video:', error)
    return NextResponse.json({ error: videoMessages.failedToCreateVideo || 'Failed to create video' }, { status: 500 })
  }
}
