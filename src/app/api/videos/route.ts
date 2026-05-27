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

    // Resolve a unique name in this (project, folder) scope.
    let finalName = videoName
    {
      const folderFilter =
        resolvedFolderId === null ? { folderId: null } : { folderId: resolvedFolderId }
      // Pull all names that look like "videoName" or "videoName (n)"
      // so we can pick the next free suffix in one query.
      const conflicts = await prisma.video.findMany({
        where: {
          projectId,
          ...folderFilter,
          OR: [
            { name: videoName },
            { name: { startsWith: `${videoName} (` } },
          ],
        },
        select: { name: true },
      })
      if (conflicts.some((v) => v.name === videoName)) {
        let n = 2
        const taken = new Set(conflicts.map((v) => v.name))
        while (taken.has(`${videoName} (${n})`)) n++
        finalName = `${videoName} (${n})`
      }
    }
    const nextVersion = 1

    // Detect whether this upload is an image or a real video (1.0.9+).
    // We check both the MIME type AND the filename extension so the
    // route survives browsers that hand us a bogus or generic MIME.
    // The flag is stored on the row as `mediaType` so the worker can
    // route the file through the right pipeline.
    const isImage =
      isImageMime(mimeType || '') ||
      isImageExtension(originalFileName || '')

    // Create video record. createdById was added in 1.0.6 — when
    // the migration for it hasn't been applied yet, Prisma throws
    // an "Unknown arg" error on the field. Retry once without it
    // so existing dev DBs still accept uploads.
    const baseCreate = {
      projectId,
      folderId: resolvedFolderId,
      name: finalName,
      version: nextVersion,
      versionLabel: versionLabel || `v${nextVersion}`,
      originalFileName,
      originalFileSize: BigInt(originalFileSize),
      originalStoragePath: `projects/${projectId}/videos/original-${Date.now()}-${originalFileName}`,
      status: 'UPLOADING' as const,
      duration: 0,
      width: 0,
      height: 0,
    }
    // Spread `mediaType` separately + via `as any` so the route still
    // compiles against an older generated Prisma client that doesn't
    // know about the field. Once `prisma generate` runs after the
    // 20260514120000_add_media_type migration, the cast becomes a
    // no-op.
    const withMediaType = {
      ...baseCreate,
      mediaType: isImage ? 'IMAGE' : 'VIDEO',
    } as any
    let video
    try {
      video = await prisma.video.create({
        data: { ...withMediaType, createdById: admin.id },
      })
    } catch {
      // Fall back without createdById — migration probably not run.
      video = await prisma.video.create({ data: withMediaType })
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
