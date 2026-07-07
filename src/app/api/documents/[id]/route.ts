import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { hardDeleteFolderDocumentById } from '@/lib/trash-cleanup'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.9.x PATCH /api/documents/[id]
 *
 * Rename (`name`) and/or move (`folderId`) a folder document. `folderId`
 * null = project root. Admin-only.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    const data: Record<string, unknown> = {}
    if (typeof body?.name === 'string' && body.name.trim()) {
      data.name = body.name.trim().slice(0, 300)
    }
    if (body?.folderId !== undefined) {
      data.folderId = body.folderId || null
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const doc = await (prisma as any).folderDocument.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    await (prisma as any).folderDocument.update({ where: { id }, data })
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error updating document:', error)
    return NextResponse.json(
      { error: 'Failed to update document' },
      { status: 500 },
    )
  }
}

/**
 * 3.9.x DELETE /api/documents/[id]
 *
 * SOFT-deletes a FolderDocument (e.g. a transcript PDF) — stamps
 * `deletedAt` so it moves to Trash and can be restored, matching how
 * videos/folders behave. Pass `?permanent=true` to purge it for real
 * (file + row) — used by Empty Trash / per-item permanent delete.
 * Admin-only.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const { id } = await params
    const permanent =
      new URL(request.url).searchParams.get('permanent') === 'true'

    const doc = await (prisma as any).folderDocument.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    if (permanent) {
      await hardDeleteFolderDocumentById(id)
    } else {
      await (prisma as any).folderDocument.update({
        where: { id },
        data: { deletedAt: new Date() },
      })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error deleting document:', error)
    return NextResponse.json(
      { error: 'Failed to delete document' },
      { status: 500 },
    )
  }
}
