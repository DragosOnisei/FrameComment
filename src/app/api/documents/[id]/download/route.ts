import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { downloadFile, sanitizeFilenameForHeader } from '@/lib/storage'
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

/**
 * 3.9.x GET /api/documents/[id]/download
 *
 * Streams a FolderDocument (transcript PDF) to an authenticated admin.
 * `?download=true` forces a save dialog; otherwise the browser opens it
 * inline. Documents are small (PDFs), so we buffer the whole file.
 */
export async function GET(
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
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    const stream = await downloadFile(doc.storagePath)
    const buffer = await streamToBuffer(stream as Readable)

    const wantsDownload = new URL(request.url).searchParams.get('download') === 'true'
    const safeName = sanitizeFilenameForHeader(doc.name || 'document.pdf')
    const disposition = wantsDownload ? 'attachment' : 'inline'

    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        'Content-Type': doc.mimeType || 'application/pdf',
        'Content-Length': String(buffer.length),
        'Content-Disposition': `${disposition}; filename="${safeName}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    logError('Error downloading document:', error)
    return NextResponse.json(
      { error: 'Failed to download document' },
      { status: 500 },
    )
  }
}
