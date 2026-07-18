import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getStorageTransferQueue } from '@/lib/queue'
import { getTransferState, requestCancel, computeBackendStatus } from '@/lib/storage-transfer'
import { getActiveBackend, backendLabel, isValidBackend } from '@/lib/storage-backends'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 4.2.0+ (Phase 2c): start / cancel / poll the storage transfer + purge, and
// report per-backend usage so the Settings storage cards can offer a
// "Delete all files from this storage" button when it's safe. Admin-only.

// GET — current job progress + per-backend status (polled by the Settings UI).
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const [state, activeBackend, backendStatus] = await Promise.all([
      getTransferState(),
      getActiveBackend(),
      computeBackendStatus(),
    ])
    return NextResponse.json({
      ...state,
      activeBackend,
      activeBackendLabel: backendLabel(activeBackend),
      backends: backendStatus.backends,
    })
  } catch (error) {
    logError('[settings/storage/transfer GET] failed:', error)
    return NextResponse.json({ error: 'Failed to read transfer status' }, { status: 500 })
  }
}

// POST { action: 'start' | 'purge' | 'cancel', backend? }
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Too many requests. Please slow down.',
  }, 'settings-storage-transfer')
  if (rateLimitResult) return rateLimitResult

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const action = body?.action

  if (action === 'cancel') {
    await requestCancel()
    return NextResponse.json({ ok: true })
  }

  // Both start (transfer) and purge (delete) enqueue on the same single-
  // concurrency queue; the `running` guard prevents overlap.
  if (action === 'start' || action === 'purge') {
    const state = await getTransferState()
    if (state.status === 'running') {
      return NextResponse.json({ error: 'A storage job is already running' }, { status: 409 })
    }

    let payload: { mode: 'transfer' | 'purge'; purgeBackend?: string }
    if (action === 'purge') {
      const backend = body?.backend
      if (!isValidBackend(backend)) {
        return NextResponse.json({ error: 'Invalid backend' }, { status: 400 })
      }
      const active = await getActiveBackend()
      if (backend === active) {
        return NextResponse.json({ error: 'Cannot delete the active storage backend' }, { status: 400 })
      }
      payload = { mode: 'purge', purgeBackend: backend }
    } else {
      payload = { mode: 'transfer' }
    }

    try {
      const queue = getStorageTransferQueue()
      // Unique jobId per run so legitimate re-runs aren't blocked by a retained
      // completed job. Overlap is prevented by the `running` guard + worker
      // concurrency: 1.
      await queue.add('storage-transfer', payload, { jobId: `storage-transfer-${Date.now()}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      logError('[settings/storage/transfer POST] enqueue failed:', error)
      return NextResponse.json({ error: 'Failed to start job' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
