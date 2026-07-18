import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { downloadFile, uploadFile } from '@/lib/storage'
import { resolveFileBackend } from '@/lib/storage-backends'
import { logError } from '@/lib/logging'
import { Readable } from 'stream'

export const runtime = 'nodejs'

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** "Name.pdf" → "Name (copy).pdf" (suffix before the extension). */
function withCopySuffix(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    return `${name.slice(0, dot)} (copy)${name.slice(dot)}`
  }
  return `${name} (copy)`
}

/**
 * 3.9.x POST /api/documents/[id]/duplicate
 *
 * Copies a folder document (file + row) into the same folder with a
 * " (copy)" suffix. Admin-only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const { id } = await params
    const doc = await (prisma as any).folderDocument.findUnique({
      where: { id },
    })
    if (!doc || doc.deletedAt) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    // 4.2.0+: read from and write the copy to the source document's backend.
    const backend = resolveFileBackend(doc.storageBackend)
    const stream = await downloadFile(doc.storagePath, backend)
    const buffer = await streamToBuffer(stream as Readable)

    const newPath = `projects/${doc.projectId}/documents/copy-${Date.now()}-${id}.pdf`
    await uploadFile(
      newPath,
      buffer,
      buffer.length,
      doc.mimeType || 'application/pdf',
      backend,
    )

    await (prisma as any).folderDocument.create({
      data: {
        projectId: doc.projectId,
        folderId: doc.folderId ?? null,
        name: withCopySuffix(doc.name),
        storagePath: newPath,
        mimeType: doc.mimeType || 'application/pdf',
        size: BigInt(buffer.length),
        kind: doc.kind || 'transcript',
        sourceVideoId: doc.sourceVideoId ?? null,
        storageBackend: backend,
      },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error duplicating document:', error)
    return NextResponse.json(
      { error: 'Failed to duplicate document' },
      { status: 500 },
    )
  }
}
