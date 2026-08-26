import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { downloadFile } from '@/lib/storage'
import { Readable } from 'stream'
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
        storagePath: true,
        storageBackend: true,
      },
    })
    // The id in the path must match the row, or a valid attachment id could be
    // fetched through any report's URL.
    if (!attachment || attachment.feedbackId !== id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const nodeStream = await downloadFile(
      attachment.storagePath,
      (attachment.storageBackend as any) || undefined,
    )

    // 7.3.1: `downloadFile` hands back a Node Readable — an fs.ReadStream
    // locally, an S3 body in the other mode — and this route used to pass it
    // straight into NextResponse behind an `as any`, which is the cast covering
    // up the fact that the two are not the same type. Bridged the way the
    // project-cover route already bridges it, which is the version that has
    // been serving bytes since 1.2.0.
    const webStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of nodeStream as Readable) {
            controller.enqueue(chunk as Uint8Array)
          }
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
      cancel() {
        nodeStream.destroy()
      },
    })

    // No Content-Length. The stored size is what the uploader reported, and a
    // header that disagrees with the body by one byte fails the whole response
    // — the cover route has never sent one either.
    return new NextResponse(webStream, {
      headers: {
        'Content-Type': attachment.fileType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(attachment.fileName)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    logError('[feedback] attachment read failed:', error, attachmentId)
    return NextResponse.json({ error: 'Could not read file' }, { status: 500 })
  }
}
