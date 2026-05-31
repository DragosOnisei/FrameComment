import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/folders/[id]/download/stat
 *
 * 2.0.x+: companion to /api/folders/[id]/download that returns a cheap
 * size estimate (no ZIP streaming) so the client can show a progress
 * banner with a meaningful percentage while the actual download
 * happens. Walks the same folder tree the download route does and
 * sums `Video.originalFileSize` for the latest version of each clip.
 *
 * The returned `totalBytes` is the SOURCE size, not the compressed ZIP
 * size — but archive level 6 on already-compressed video bitstreams
 * (h264/mp4) produces a ratio close enough to 1:1 that the percentage
 * reads as accurate to the user.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult
  const { id } = await params

  try {
    const rootFolder = await prisma.folder.findUnique({
      where: { id },
      select: { id: true, name: true, deletedAt: true },
    })
    if (!rootFolder || (rootFolder as any).deletedAt) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    const queue: string[] = [rootFolder.id]
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

      // Latest-version-per-name dedup — same rule the streaming
      // ZIP route uses, so the byte total matches what'll be added
      // to the archive.
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
      folderName: rootFolder.name,
      fileCount,
      // BigInt isn't JSON-serializable directly; ship as string and
      // let the client parseInt — values can exceed Number.MAX_SAFE_INTEGER
      // for large libraries.
      totalBytes: totalBytes.toString(),
    })
  } catch (err) {
    logError('[FOLDER ZIP STAT] failed:', err)
    return NextResponse.json(
      { error: 'Failed to compute folder stats' },
      { status: 500 },
    )
  }
}
