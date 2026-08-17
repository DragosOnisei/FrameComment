/**
 * POST /api/videos/[id]/cancel-upload — 6.14.0.
 *
 * Ends an upload that is going nowhere, right now.
 *
 * Until now the only way an UPLOADING row stopped being UPLOADING was the
 * abandoned-upload reaper in `/api/processing-status`, which waits 30 minutes
 * (TUS) or 24 hours (S3) before touching anything. That caution is correct for
 * a background sweep — it must never kill a slow-but-alive transfer — but it
 * left the person watching the banner with no way out: the transfer had
 * visibly died, the banner said "1 in progress" at 85%, and the only honest
 * answer the UI could give was "wait half an hour".
 *
 * Two callers:
 *   - the Cancel button on the upload banner, when someone decides a stuck
 *     transfer is not coming back;
 *   - the upload modal's stall watchdog, after its retry fails, so the row
 *     dies at the same moment the client gives up instead of half an hour
 *     later.
 *
 * The row is marked ERROR, never deleted — same as every other failure path,
 * so it stays visible as a card the admin can retry or remove. PROCESSING and
 * READY rows are refused: this is about transfers, not about undoing work the
 * worker already did.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'cancel-upload',
  )
  if (limited) return limited

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : ''

    const video = await prisma.video.findUnique({
      where: { id },
      select: { id: true, name: true, status: true },
    })
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }
    if (video.status !== 'UPLOADING') {
      // Not an error worth shouting about: the upload probably finished
      // between the click and the request. Say what happened and move on.
      return NextResponse.json({
        success: true,
        alreadyFinished: true,
        status: video.status,
      })
    }

    await prisma.video.update({
      where: { id },
      data: {
        status: 'ERROR',
        processingError: reason || 'Upload cancelled.',
      } as any,
    })

    logMessage(`[upload] Cancelled upload for "${video.name}" (${id}) — ${reason || 'cancelled by user'}`)

    return NextResponse.json({ success: true })
  } catch (error) {
    logError('[upload] Failed to cancel upload:', error)
    return NextResponse.json({ error: 'Could not cancel the upload.' }, { status: 500 })
  }
}
