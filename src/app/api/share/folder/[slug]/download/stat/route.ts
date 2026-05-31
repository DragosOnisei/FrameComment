import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest, getShareContext } from '@/lib/auth'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/share/folder/[slug]/download/stat
 *
 * 2.0.x+: companion to /api/share/folder/[slug]/download that returns
 * cheap size + file-count metadata so the client can show a meaningful
 * progress percentage in the download banner. Honours the same auth
 * model as the streaming endpoint (NONE / PASSWORD, plus the per-
 * project `allowAssetDownload` flag).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params

    const folderMeta = await prisma.folder.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        projectId: true,
        authMode: true,
        project: {
          select: { allowAssetDownload: true },
        },
      },
    })
    if (!folderMeta) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

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
        { error: 'Folder OTP/BOTH auth is not supported for downloads.' },
        { status: 400 },
      )
    }
    if (!authorized) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }
    if (!isAdmin && !folderMeta.project.allowAssetDownload) {
      return NextResponse.json(
        { error: 'Downloads disabled for this project.' },
        { status: 403 },
      )
    }

    // Walk the tree the same way the streaming endpoint does.
    const queue: string[] = [folderMeta.id]
    const visited = new Set<string>()
    let totalBytes = BigInt(0)
    let fileCount = 0

    while (queue.length > 0) {
      const folderId = queue.shift()!
      if (visited.has(folderId)) continue
      visited.add(folderId)

      const folder = await prisma.folder.findUnique({
        where: { id: folderId },
        include: {
          subfolders: {
            where: { deletedAt: null } as any,
            select: { id: true },
          },
          videos: {
            where: { deletedAt: null } as any,
            select: {
              name: true,
              version: true,
              originalFileSize: true,
              originalStoragePath: true,
            },
          },
        },
      })
      if (!folder) continue

      const byKey = new Map<string, { version: number; size: bigint }>()
      for (const v of folder.videos as any[]) {
        if (!v.originalStoragePath) continue
        const size = typeof v.originalFileSize === 'bigint'
          ? v.originalFileSize
          : BigInt(v.originalFileSize || 0)
        const prev = byKey.get(v.name)
        if (!prev || (v.version ?? 0) > prev.version) {
          byKey.set(v.name, { version: v.version ?? 0, size })
        }
      }
      for (const v of byKey.values()) {
        fileCount += 1
        totalBytes += v.size
      }
      for (const sub of folder.subfolders as any[]) {
        queue.push(sub.id)
      }
    }

    return NextResponse.json({
      folderName: folderMeta.name,
      fileCount,
      totalBytes: totalBytes.toString(),
    })
  } catch (err) {
    logError('[SHARE FOLDER ZIP STAT] failed:', err)
    return NextResponse.json(
      { error: 'Failed to compute folder stats' },
      { status: 500 },
    )
  }
}
