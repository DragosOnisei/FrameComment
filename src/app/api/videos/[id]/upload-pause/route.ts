import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.20.3: POST { paused: boolean } — the upload window telling the server
 * that the person pressed Pause or Resume.
 *
 * Without it the server cannot tell a paused transfer from a dead one: both
 * send nothing. The abandoned-upload reaper (/api/processing-status) marked
 * a row Failed after 30 silent minutes — on every colleague's card — even
 * though its uploader had only paused it, and the bottom-right banner read
 * "No data for 40s — retrying" over a transfer nobody was retrying. With
 * `uploadPausedAt` set the reaper waits 24 hours (an uploader who paused
 * and closed the laptop is still cleared up eventually) and the banner
 * says "Paused".
 *
 * Only an UPLOADING row is touched; anything else answers ok with nothing
 * changed — a late Resume after the upload finished is harmless.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'upload-pause',
  )
  if (limited) return limited

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    if (typeof body?.paused !== 'boolean') {
      return NextResponse.json({ error: 'paused must be true or false' }, { status: 400 })
    }
    const updated = await prisma.video.updateMany({
      where: { id, status: 'UPLOADING' },
      data: { uploadPausedAt: body.paused ? new Date() : null },
    })
    return NextResponse.json({ ok: true, updated: updated.count })
  } catch (error) {
    logError('[POST /api/videos/[id]/upload-pause] failed:', error)
    return NextResponse.json({ error: 'Could not record the pause' }, { status: 500 })
  }
}
