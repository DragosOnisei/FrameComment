import { NextRequest, NextResponse } from 'next/server'
import { requireApiManageSettings } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { prisma, currentOrgId } from '@/lib/db'
import { getStorageTransferQueue } from '@/lib/queue'
import { getTransferState } from '@/lib/storage-transfer'
import { getActiveBackend, backendLabel, parseLocations, resolveFileBackend } from '@/lib/storage-backends'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.12.0 — POST /api/videos/[id]/transfer
 *
 * Manually copy ONE video's files (original + previews + HLS + thumbnails)
 * to the company's ACTIVE storage backend — the kebab's "Transfer to …"
 * action. Runs through the same worker pipeline as the full transfer
 * (copy → verify → retag, sources kept), scoped to this video.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiManageSettings(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.',
  }, 'video-transfer')
  if (rateLimitResult) return rateLimitResult

  try {
    const { id } = await params
    // RLS (armed by the guard) scopes this lookup to the caller's company.
    const video = await prisma.video.findUnique({
      where: { id },
      select: { id: true, name: true, storageBackend: true, storageLocations: true } as any,
    })
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    const active = await getActiveBackend()
    const locations = (() => {
      const parsed = parseLocations((video as any).storageLocations)
      const primary = resolveFileBackend((video as any).storageBackend)
      return parsed.length ? parsed : [primary]
    })()
    if (locations.includes(active)) {
      return NextResponse.json(
        { error: `This video is already stored on ${backendLabel(active)}.` },
        { status: 400 },
      )
    }

    const orgId = currentOrgId()
    const state = await getTransferState(orgId)
    if (state.status === 'running') {
      return NextResponse.json(
        { error: 'A storage job is already running — try again when it finishes.' },
        { status: 409 },
      )
    }

    const queue = getStorageTransferQueue()
    await queue.add(
      'storage-transfer',
      { mode: 'transfer', organizationId: orgId, videoId: id },
      { jobId: `storage-transfer-${Date.now()}` },
    )
    logMessage(`[video-transfer] queued single-video transfer (org=${orgId}, video=${id}) → ${active}`)
    return NextResponse.json({ ok: true, target: active, targetLabel: backendLabel(active) })
  } catch (error) {
    logError('[POST /api/videos/[id]/transfer] failed:', error)
    return NextResponse.json({ error: 'Failed to start transfer' }, { status: 500 })
  }
}
