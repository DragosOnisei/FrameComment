import { NextRequest, NextResponse } from 'next/server'
import { requireApiManageSettings } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getStorageTransferQueue } from '@/lib/queue'
import { getTransferState, requestCancel, computeBackendStatus } from '@/lib/storage-transfer'
import { getActiveBackend, backendLabel, isValidBackend, isS3Backend, getS3ConfigForBackend } from '@/lib/storage-backends'
import { s3FileExists } from '@/lib/s3-storage'
import { currentOrgId } from '@/lib/db'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 4.2.0+ (Phase 2c): start / cancel / poll the storage transfer + purge, and
// report per-backend usage so the Settings storage cards can offer a
// "Delete all files from this storage" button when it's safe. Admin-only.
//
// 5.12.0: org-scoped state (each company polls ITS OWN progress), a cheap
// `?light=1` mode for the global progress banner (Redis state only — no
// full-table scans), and `activeReachable` so the UI only offers "Transfer
// all files to X" once the saved R2/AWS backend actually answers.

// GET — current job progress + per-backend status (polled by the Settings UI).
export async function GET(request: NextRequest) {
  const authResult = await requireApiManageSettings(request)
  if (authResult instanceof Response) return authResult

  const light = new URL(request.url).searchParams.get('light') === '1'

  try {
    const orgId = currentOrgId()
    const [state, activeBackend] = await Promise.all([
      getTransferState(orgId),
      getActiveBackend(),
    ])

    if (light) {
      // Banner polling: Redis state + labels only. No DB scans.
      return NextResponse.json({
        ...state,
        activeBackend,
        activeBackendLabel: backendLabel(activeBackend),
      })
    }

    // Full status for the Settings page: per-backend usage + (for S3-style
    // active backends) a real reachability probe with the SAVED credentials.
    const [backendStatus, activeReachable] = await Promise.all([
      computeBackendStatus(),
      (async () => {
        if (!isS3Backend(activeBackend)) return true
        try {
          const config = await getS3ConfigForBackend(activeBackend)
          // HEAD on a random key: false (no error) when creds+bucket are
          // valid; throws on auth/bucket problems.
          await s3FileExists(`.framecomment-connection-test-${Date.now()}`, config)
          return true
        } catch {
          return false
        }
      })(),
    ])
    return NextResponse.json({
      ...state,
      activeBackend,
      activeBackendLabel: backendLabel(activeBackend),
      activeReachable,
      backends: backendStatus.backends,
    })
  } catch (error) {
    logError('[settings/storage/transfer GET] failed:', error)
    return NextResponse.json({ error: 'Failed to read transfer status' }, { status: 500 })
  }
}

// POST { action: 'start' | 'purge' | 'cancel', backend? }
export async function POST(request: NextRequest) {
  const authResult = await requireApiManageSettings(request)
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
  const orgId = currentOrgId()

  if (action === 'cancel') {
    await requestCancel(orgId)
    return NextResponse.json({ ok: true })
  }

  // Both start (transfer) and purge (delete) enqueue on the same single-
  // concurrency queue; the `running` guard prevents overlap.
  if (action === 'start' || action === 'purge') {
    const state = await getTransferState(orgId)
    if (state.status === 'running') {
      return NextResponse.json({ error: 'A storage job is already running' }, { status: 409 })
    }

    let payload: { mode: 'transfer' | 'purge'; purgeBackend?: string; organizationId: string }
    if (action === 'purge') {
      const backend = body?.backend
      if (!isValidBackend(backend)) {
        return NextResponse.json({ error: 'Invalid backend' }, { status: 400 })
      }
      const active = await getActiveBackend()
      if (backend === active) {
        return NextResponse.json({ error: 'Cannot delete the active storage backend' }, { status: 400 })
      }
      payload = { mode: 'purge', purgeBackend: backend, organizationId: orgId }
    } else {
      payload = { mode: 'transfer', organizationId: orgId }
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
