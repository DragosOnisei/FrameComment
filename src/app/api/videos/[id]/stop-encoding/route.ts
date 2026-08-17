/**
 * POST /api/videos/[id]/stop-encoding — 6.14.0.
 *
 * Stops the encode ladder where it stands, and keeps what already works.
 *
 * The rule, in the user's words: cancelling during SD deletes the video,
 * because nothing is playable yet. Cancelling during HD keeps it at SD.
 * Cancelling during HD+ keeps it at SD and HD. The click means "this is good
 * enough, stop spending CPU on it" — not "throw it away" — from the moment the
 * first tier lands.
 *
 * Three things have to happen together, or the ladder grows back:
 *   1. The stop flag, so the tier currently inside ffmpeg is abandoned instead
 *      of being persisted a minute later (see `lib/encode-cancel.ts`).
 *   2. `cancelPendingVideoJobs`, so the tiers still queued never start.
 *   3. `plannedTiers` shrunk to what finished — otherwise every progress bar
 *      in the product keeps drawing a denominator that will never be reached,
 *      and the video reads as "83% encoded" forever.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { cancelPendingVideoJobs } from '@/lib/queue'
import { markEncodeStopped } from '@/lib/encode-cancel'
import { hardDeleteVideoById } from '@/lib/trash-cleanup'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function asTierList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'stop-encoding',
  )
  if (limited) return limited

  try {
    const { id } = await params

    const video = (await prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        plannedTiers: true,
        completedTiers: true,
      } as any,
    })) as any

    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const completed = asTierList(video.completedTiers)

    // Order matters: raise the flag BEFORE pulling jobs, so a tier that
    // finishes in the gap still sees it and drops itself.
    await markEncodeStopped(id)
    await cancelPendingVideoJobs(id).catch((err) =>
      logError(`[stop-encoding] Could not cancel queued jobs for ${id}:`, err),
    )

    // Nothing playable yet — the video is just a source file and a plan.
    if (completed.length === 0) {
      await hardDeleteVideoById(id)
      logMessage(`[stop-encoding] "${video.name}" (${id}) stopped before any tier — removed`)
      return NextResponse.json({ action: 'deleted', keptTiers: [] })
    }

    // Keep it, at the height it reached.
    await prisma.video.update({
      where: { id },
      data: {
        status: 'READY',
        // The ladder is now exactly what exists. Every progress calculation in
        // the app divides by this, so leaving the original plan in place would
        // pin the video at a percentage it can never finish.
        plannedTiers: completed,
        processingProgress: 100,
      } as any,
    })

    logMessage(
      `[stop-encoding] "${video.name}" (${id}) stopped — keeping ${completed.join(', ')}`,
    )

    return NextResponse.json({ action: 'kept', keptTiers: completed })
  } catch (error) {
    logError('[stop-encoding] failed:', error)
    return NextResponse.json({ error: 'Could not stop the encode.' }, { status: 500 })
  }
}
