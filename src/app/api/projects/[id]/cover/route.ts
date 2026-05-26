import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import {
  initStorage,
  uploadFile,
  deleteFile,
  getFilePath,
  isS3Mode,
  createWebReadableStream,
  downloadFile,
} from '@/lib/storage'
import { Readable } from 'stream'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_COVER_BYTES = 5 * 1024 * 1024 // 5 MB

const ALLOWED_COVER_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

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

/**
 * 1.5.8+: POST replaces the project's cover image. Accepts PNG, JPEG,
 * WEBP or GIF up to 5 MB. The new file is uploaded to
 * `projects/{id}/cover.{ext}`; the previous one is deleted on a
 * best-effort basis so we don't accumulate orphans when an admin
 * keeps changing the cover.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const adminCheck = await requireApiAdmin(request)
  if (adminCheck instanceof Response) return adminCheck

  try {
    const { id } = await params

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, coverImagePath: true } as any,
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file field' }, { status: 400 })
    }
    if (file.size > MAX_COVER_BYTES) {
      return NextResponse.json(
        { error: `Image too large (max ${Math.floor(MAX_COVER_BYTES / (1024 * 1024))} MB)` },
        { status: 400 },
      )
    }

    const mime = (file.type || '').toLowerCase().split(';')[0].trim()
    const ext = ALLOWED_COVER_TYPES[mime]
    if (!ext) {
      return NextResponse.json(
        { error: 'Unsupported file type. Use PNG, JPEG, WEBP or GIF.' },
        { status: 400 },
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    await initStorage()

    // Best-effort cleanup of any previous cover so orphan files don't
    // accumulate when the admin tries several images in a row.
    const prevPath = (project as any).coverImagePath as string | null | undefined
    if (prevPath) {
      try {
        await deleteFile(prevPath)
      } catch (cleanupErr) {
        logError('[PROJECT:COVER] Failed to remove previous cover', cleanupErr)
      }
    }

    const storagePath = `projects/${id}/cover.${ext}`
    await uploadFile(storagePath, buffer, buffer.byteLength, mime)

    await prisma.project.update({
      where: { id },
      data: { coverImagePath: storagePath } as any,
    })

    return NextResponse.json({ path: storagePath })
  } catch (err) {
    logError('[PROJECT:COVER] POST failed', err)
    return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 })
  }
}

/**
 * 1.5.8+: DELETE removes the cover image. After this the dashboard
 * tile falls back to its deterministic gradient. Idempotent so a
 * double-click is safe.
 */
export async function DELETE(
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
      return new NextResponse(null, { status: 204 })
    }

    await initStorage()
    try {
      await deleteFile(coverPath)
    } catch (cleanupErr) {
      logError('[PROJECT:COVER] Storage delete failed (clearing DB pointer anyway)', cleanupErr)
    }

    await prisma.project.update({
      where: { id },
      data: { coverImagePath: null } as any,
    })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    logError('[PROJECT:COVER] DELETE failed', err)
    return NextResponse.json({ error: 'Failed to remove image' }, { status: 500 })
  }
}
