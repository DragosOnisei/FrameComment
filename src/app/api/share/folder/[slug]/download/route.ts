import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'stream'
import archiver from 'archiver'
import { prisma } from '@/lib/db'
import {
  getCurrentUserFromRequest,
  getShareContext,
} from '@/lib/auth'
import { downloadFile, sanitizeFilenameForHeader } from '@/lib/storage'
import { rateLimit } from '@/lib/rate-limit'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/share/folder/[slug]/download
 *
 * 1.4.x+: public client-facing folder ZIP download. Mirrors the admin
 * `/api/folders/[id]/download` endpoint but goes through the existing
 * folder-share auth model:
 *
 *  - NONE folders: open access, anyone with the link can download.
 *  - PASSWORD folders: caller MUST present a valid share token
 *    bound to this folder (the same token the page already uses for
 *    its content fetches).
 *  - OTP / BOTH: not supported (consistent with the share GET).
 *
 * Honours the project's `allowAssetDownload` flag — if the studio
 * has turned off client downloads for this project, we refuse with
 * 403. Same gate the project share page uses.
 *
 * Archive layout matches the admin endpoint: `<FolderName>/...`
 * with original filenames preserved.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params

    // Tight rate limit — folder downloads can be large, easy to abuse.
    const rl = await rateLimit(
      request,
      {
        windowMs: 15 * 60 * 1000,
        maxRequests: 30,
        message: 'Too many folder downloads. Please try again later.',
      },
      `share-folder-download:${slug}`,
    )
    if (rl) return rl

    const folderMeta = await prisma.folder.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        projectId: true,
        sharePassword: true,
        authMode: true,
        project: {
          select: {
            title: true,
            // 1.2.0+: `allowAssetDownload` gates client-side downloads
            // at the project level. We respect it here so an admin
            // who turned off downloads for clients doesn't get bypassed
            // through the folder share page.
            allowAssetDownload: true,
          },
        },
      },
    })

    if (!folderMeta) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    // Auth — mirrors the GET /api/share/folder/[slug] flow exactly.
    const currentUser = await getCurrentUserFromRequest(request)
    const isAdmin = currentUser?.role === 'ADMIN'
    const shareContext = await getShareContext(request)
    let authorized = false
    if (isAdmin) {
      authorized = true
    } else if (folderMeta.authMode === 'NONE') {
      authorized = true
    } else if (folderMeta.authMode === 'PASSWORD') {
      if (
        shareContext &&
        shareContext.folderId === folderMeta.id &&
        shareContext.projectId === folderMeta.projectId
      ) {
        authorized = true
      }
    } else {
      return NextResponse.json(
        {
          error:
            'Folder OTP/BOTH auth is not yet supported for downloads.',
          authMode: folderMeta.authMode,
        },
        { status: 400 },
      )
    }
    if (!authorized) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    // Admin always bypasses the per-project client-download flag.
    if (!isAdmin && !folderMeta.project.allowAssetDownload) {
      return NextResponse.json(
        {
          error:
            "The studio has disabled downloads for this project. Ask them to enable it in project settings.",
        },
        { status: 403 },
      )
    }

    // Walk the folder tree breadth-first; same logic as the admin
    // endpoint. Each entry tracks its ZIP path prefix so subfolders
    // inherit their parent's name.
    type WalkEntry = { folderId: string; zipPrefix: string }
    const queue: WalkEntry[] = [
      { folderId: folderMeta.id, zipPrefix: sanitizeFolderSegment(folderMeta.name) },
    ]
    const visited = new Set<string>()
    const filesToAdd: Array<{ storagePath: string; zipPath: string }> = []
    const emptyFolderPaths = new Set<string>()

    while (queue.length > 0) {
      const { folderId, zipPrefix } = queue.shift()!
      if (visited.has(folderId)) continue
      visited.add(folderId)
      const folder = await prisma.folder.findUnique({
        where: { id: folderId },
        include: {
          subfolders: {
            where: { deletedAt: null } as any,
            select: { id: true, name: true },
          },
          videos: {
            where: { deletedAt: null } as any,
            select: {
              id: true,
              name: true,
              version: true,
              originalFileName: true,
              originalStoragePath: true,
            },
          },
        },
      })
      if (!folder) continue

      // Latest-version-per-name grouping (matches the public grid).
      const byKey = new Map<string, any>()
      for (const v of folder.videos as any[]) {
        if (!v.originalStoragePath) continue
        const key = `${v.name}`
        const prev = byKey.get(key)
        if (!prev || (v.version ?? 0) > (prev.version ?? 0)) {
          byKey.set(key, v)
        }
      }
      let videoCount = 0
      for (const v of byKey.values()) {
        videoCount += 1
        const ext = (v.originalFileName || '').match(/\.[^./]+$/)?.[0] || ''
        const baseName = v.originalFileName
          ? v.originalFileName.replace(/\.[^./]+$/, '')
          : v.name
        const safeBase = sanitizeFolderSegment(baseName)
        const fileName = `${safeBase}${ext || '.mp4'}`
        filesToAdd.push({
          storagePath: v.originalStoragePath,
          zipPath: `${zipPrefix}/${fileName}`,
        })
      }
      if (videoCount === 0 && folder.subfolders.length === 0) {
        emptyFolderPaths.add(`${zipPrefix}/`)
      }
      for (const sub of folder.subfolders as any[]) {
        queue.push({
          folderId: sub.id,
          zipPrefix: `${zipPrefix}/${sanitizeFolderSegment(sub.name)}`,
        })
      }
    }

    if (filesToAdd.length === 0 && emptyFolderPaths.size === 0) {
      return NextResponse.json(
        { error: 'Folder is empty — nothing to download' },
        { status: 404 },
      )
    }

    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.on('error', (err) => {
      logError('Share folder ZIP archive error:', err)
    })

    for (const folderPath of emptyFolderPaths) {
      archive.append(Buffer.alloc(0), { name: folderPath })
    }
    let appended = 0
    for (const file of filesToAdd) {
      try {
        const stream = await downloadFile(file.storagePath)
        archive.append(stream, { name: file.zipPath })
        appended += 1
      } catch (err) {
        logError(`Share folder ZIP: failed to add ${file.zipPath}:`, err)
      }
    }
    logMessage(
      `[SHARE FOLDER ZIP] Built archive for ${folderMeta.name}: ${appended}/${filesToAdd.length} files`,
    )

    void archive.finalize()
    const readableStream = Readable.toWeb(archive as any) as ReadableStream

    const zipFilename = sanitizeFilenameForHeader(
      `${folderMeta.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`,
    )
    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename}"`,
        'Cache-Control': 'private, no-cache',
      },
    })
  } catch (err) {
    logError('[SHARE FOLDER ZIP] download failed:', err)
    return NextResponse.json(
      { error: 'Failed to build folder archive' },
      { status: 500 },
    )
  }
}

function sanitizeFolderSegment(raw: string): string {
  const trimmed = (raw || 'Untitled').trim()
  const cleaned = trimmed
    .replace(/[/\\:*?"<>| -]/g, '_')
    .replace(/[. ]+$/g, '')
  return cleaned || 'Untitled'
}
