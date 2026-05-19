import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getFilePath, isS3Mode, createWebReadableStream, downloadFile } from '@/lib/storage'
import { Readable } from 'stream'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 1.2.0+: serve a project's optional cover image. Admin-only — the
 * dashboard is admin-only too, so no need for a signed URL or share-
 * token flow. Returns 404 when the project has no cover, so the card
 * can fall back to its gradient.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const adminCheck = await requireApiAdmin(request)
  if (adminCheck instanceof Response) return adminCheck

  try {
    const { id } = await params
    const project = await prisma.project.findUnique({
      where: { id },
      select: { coverImagePath: true } as any,
    })
    const coverPath = (project as any)?.coverImagePath as string | null | undefined
    if (!coverPath) {
      return NextResponse.json({ error: 'No cover image' }, { status: 404 })
    }

    // Cheap content-type sniff from the file extension. The upload
    // endpoint preserves the original ext, so this is reliable.
    const ext = (coverPath.split('.').pop() || 'jpg').toLowerCase()
    const contentType =
      ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
            : 'image/jpeg'

    if (isS3Mode()) {
      const nodeStream = await downloadFile(coverPath)
      // Convert Node Readable to Web ReadableStream (Next.js accepts
      // either, but createWebReadableStream is specific to fs.ReadStream
      // so we bridge manually here).
      const webStream = new ReadableStream({
        async start(controller) {
          for await (const chunk of nodeStream as Readable) {
            controller.enqueue(chunk as Uint8Array)
          }
          controller.close()
        },
      })
      return new NextResponse(webStream, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=300',
        },
      })
    }

    const fullPath = getFilePath(coverPath)
    if (!fs.existsSync(fullPath)) {
      return NextResponse.json({ error: 'Cover image not found' }, { status: 404 })
    }
    const stream = fs.createReadStream(fullPath)
    return new NextResponse(createWebReadableStream(stream), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to serve cover' }, { status: 500 })
  }
}
