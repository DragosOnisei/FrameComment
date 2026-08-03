import { Job, Worker } from 'bullmq'
import { getRedisForQueue } from '../lib/redis'
import type { StorageTransferJob } from '../lib/queue'
import { runStorageTransfer, runStoragePurge } from '../lib/storage-transfer'
import { isValidBackend } from '../lib/storage-backends'
import { runWithOrgContext } from '../lib/org-context'
import { logMessage } from '../lib/logging'

/**
 * 4.2.0+ (Phase 2c): worker for the storage transfer/purge job. Concurrency 1 —
 * only one runs at a time. 'transfer' copies to the active backend (keeps
 * sources); 'purge' re-verifies + deletes every copy on `purgeBackend`.
 * Progress is reported to Redis.
 *
 * 5.12.0: org-aware. Every job carries the requesting organizationId (legacy
 * jobs default to 'org-1'); the run executes inside that org's context so
 * `getActiveBackend()` resolves the COMPANY's chosen backend, and the
 * enumeration in storage-transfer.ts filters rows by the same org explicitly
 * (the worker's privileged role isn't bound by RLS). Optional `videoId`
 * scopes a transfer to a single video (the per-video kebab action).
 */
export async function processStorageTransfer(job: Job<StorageTransferJob>): Promise<void> {
  const organizationId = job.data?.organizationId || 'org-1'
  const mode = job.data?.mode === 'purge' ? 'purge' : 'transfer'

  await runWithOrgContext(organizationId, async () => {
    if (mode === 'purge') {
      const backend = job.data?.purgeBackend
      if (!isValidBackend(backend)) throw new Error(`Invalid purge backend: ${backend}`)
      logMessage(`[WORKER] storage-purge job started (org=${organizationId}, backend=${backend})`)
      await runStoragePurge(organizationId, backend)
      logMessage('[WORKER] storage-purge job finished')
      return
    }
    const videoId = typeof job.data?.videoId === 'string' && job.data.videoId ? job.data.videoId : undefined
    logMessage(`[WORKER] storage-transfer job started (org=${organizationId}${videoId ? `, video=${videoId}` : ''})`)
    await runStorageTransfer(organizationId, { videoId })
    logMessage('[WORKER] storage-transfer job finished')
  })
}

export function createStorageTransferWorker() {
  return new Worker<StorageTransferJob>('storage-transfer', processStorageTransfer, {
    connection: getRedisForQueue(),
    concurrency: 1,
  })
}
