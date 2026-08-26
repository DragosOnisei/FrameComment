import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'stream'
import { prismaPrivileged } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { uploadFile } from '@/lib/storage'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.3.0 — a screenshot or a short screen recording attached to a report.
 *
 * A picture of the bug is worth more than the sentence describing it, and a
 * recording is worth more than both when the fault only exists in motion.
 *
 * Three limits, each for its own reason:
 *  - 25MB, because this is a bug report and not a delivery pipeline. Anything
 *    larger belongs in the product's own upload path.
 *  - images and video only, checked against an allow-list rather than a
 *    block-list, so an unexpected type is refused rather than guessed at.
 *  - the caller must OWN the report. Without it, a valid session could staple
 *    files onto somebody else's row by guessing an id.
 */
const MAX_BYTES = 25 * 1024 * 1024
const ALLOWED = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const limited = await rateLimit(
    request,
    { windowMs: 60 * 60 * 1000, maxRequests: 40, message: 'Too many uploads — try again shortly.' },
    'feedback-attach',
  )
  if (limited) return limited

  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth

  const { id } = await params

  try {
    const report = await prismaPrivileged.feedback.findUnique({
      where: { id },
      select: { id: true, userId: true },
    })
    // The same 404 for "does not exist" and "is not yours": a guessed id must
    // not be able to tell the difference.
    if (!report || report.userId !== auth.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file' }, { status: 400 })
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large (25MB max)' }, { status: 413 })
    }
    if (!ALLOWED.has(file.type)) {
      return NextResponse.json({ error: 'Only images and video' }, { status: 415 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    // Stored under the report's own id, so deleting a report's files is a
    // prefix operation rather than a search.
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)
    const storagePath = `feedback/${id}/${Date.now()}-${safeName}`
    await uploadFile(storagePath, Readable.from(buffer), buffer.length, file.type)

    const created = await prismaPrivileged.feedbackAttachment.create({
      data: {
        feedbackId: id,
        fileName: file.name.slice(0, 255),
        fileType: file.type,
        fileSize: BigInt(buffer.length),
        storagePath,
      },
      select: { id: true },
    })

    return NextResponse.json({ id: created.id }, { status: 201 })
  } catch (error) {
    logError('[feedback] attachment upload failed:', error, id)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
