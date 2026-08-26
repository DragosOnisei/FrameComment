import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { downloadFile } from '@/lib/storage'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.3.0 — stream one feedback attachment to the founder.
 *
 * Founder only, and no signed-URL scheme like the share side has: these files
 * are never shown to anyone but the person reading the inbox, so a token that
 * could be forwarded would be a way to leak one company's screenshot to
 * another. A session check on every request is both simpler and stricter.
 *
 * `inline` rather than `attachment`: the point is to look at the picture inside
 * the inbox, not to collect files.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const { id, attachmentId } = await params

  try {
    const attachment = await prismaPrivileged.feedbackAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        feedbackId: true,
        fileName: true,
        fileType: true,
        fileSize: true,
        storagePath: true,
        storageBackend: true,
      },
    })
    // The id in the path must match the row, or a valid attachment id could be
    // fetched through any report's URL.
    if (!attachment || attachment.feedbackId !== id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const stream = await downloadFile(
      attachment.storagePath,
      (attachment.storageBackend as any) || undefined,
    )

    return new NextResponse(stream as any, {
      headers: {
        'Content-Type': attachment.fileType,
        'Content-Length': attachment.fileSize.toString(),
        'Content-Disposition': `inline; filename="${encodeURIComponent(attachment.fileName)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    logError('[feedback] attachment read failed:', error, attachmentId)
    return NextResponse.json({ error: 'Could not read file' }, { status: 500 })
  }
}
