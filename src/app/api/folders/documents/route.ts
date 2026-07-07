import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 3.9.x GET /api/folders/documents?projectId=<id>&folderId=<id|root>
 *
 * Lists the non-video FILES that live in a folder (or the project root
 * when folderId is "root"/omitted). Currently these are the transcript
 * PDFs produced by "Create Transcript". Admin-only. Each row carries a
 * ready-to-use `downloadUrl` (admin-authed streaming endpoint).
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')
    const folderParam = searchParams.get('folderId')
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    }
    const folderId =
      !folderParam || folderParam === 'root' || folderParam === 'null'
        ? null
        : folderParam

    const docs = await (prisma as any).folderDocument.findMany({
      where: { projectId, folderId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json(
      (docs as any[]).map((d) => ({
        id: d.id,
        name: d.name,
        mimeType: d.mimeType,
        size: d.size != null ? d.size.toString() : '0',
        kind: d.kind,
        sourceVideoId: d.sourceVideoId,
        createdAt: d.createdAt,
        downloadUrl: `/api/documents/${d.id}/download`,
      })),
    )
  } catch (error) {
    logError('Error listing folder documents:', error)
    return NextResponse.json(
      { error: 'Failed to list documents' },
      { status: 500 },
    )
  }
}
