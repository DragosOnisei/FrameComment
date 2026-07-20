import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.2.x: lightweight batch status lookup for a set of video ids.
 *
 * The upload widget uses this to reconcile its client-side progress with the
 * real server state: if a TUS `onSuccess` callback is lost (an intermittent
 * proxy/network/tab-throttle blip) the widget can otherwise stay stuck at a
 * partial % even though the upload finished and the video is already
 * PROCESSING/READY. Polling the true status lets the widget clear itself.
 *
 * Returns only { id, status } for the requested ids (missing ids are simply
 * absent — e.g. deleted mid-upload). Admin-only.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const ids = Array.isArray(body?.ids)
    ? (body.ids as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 200)
    : []

  if (ids.length === 0) {
    return NextResponse.json({ statuses: {} })
  }

  try {
    const rows = await prisma.video.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    })
    const statuses: Record<string, string> = {}
    for (const r of rows) statuses[r.id] = r.status
    return NextResponse.json(
      { statuses },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    logError('[videos/statuses] failed:', error)
    return NextResponse.json({ error: 'Failed to read statuses' }, { status: 500 })
  }
}
