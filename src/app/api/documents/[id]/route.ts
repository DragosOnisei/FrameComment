import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { deleteFile } from '@/lib/storage'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.9.x DELETE /api/documents/[id]
 *
 * Permanently removes a FolderDocument (e.g. a transcript PDF) and its
 * backing file. Admin-only. Best-effort on the storage delete so a
 * missing file doesn't block removing the row.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const { id } = await params
    const doc = await (prisma as any).folderDocument.findUnique({
      where: { id },
      select: { id: true, storagePath: true },
    })
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    if (doc.storagePath) {
      await deleteFile(doc.storagePath).catch(() => {
        /* file already gone — proceed with row delete */
      })
    }
    await (prisma as any).folderDocument.delete({ where: { id } })

    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error deleting document:', error)
    return NextResponse.json(
      { error: 'Failed to delete document' },
      { status: 500 },
    )
  }
}
