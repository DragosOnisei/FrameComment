import { Job, Worker } from 'bullmq'
import { getRedisForQueue } from '../lib/redis'
import type { StorageTransferJob } from '../lib/queue'
import { runStorageTransfer, runStoragePurge } from '../lib/storage-transfer'
import { isValidBackend } from '../lib/storage-backends'
import { logMessage } from '../lib/logging'

/**
 * 4.2.0+ (Phase 2c): worker for the storage transfer/purge job. Concurrency 1 —
 * only one runs at a time. 'transfer' copies to the active backend (keeps
 * sources); 'purge' re-verifies + deletes every copy on `purgeBackend`.
 * Progress is reported to Redis.
 */
export async function processStorageTransfer(job: Job<StorageTransferJob>): Promise<void> {
  const mode = job.data?.mode === 'purge' ? 'purge' : 'transfer'
  if (mode === 'purge') {
    const backend = job.data?.purgeBackend
    if (!isValidBackend(backend)) throw new Error(`Invalid purge backend: ${backend}`)
    logMessage(`[WORKER] storage-purge job started (backend=${backend})`)
    await runStoragePurge(backend)
    logMessage('[WORKER] storage-purge job finished')
    return
  }
  logMessage('[WORKER] storage-transfer job started')
  await runStorageTransfer()
  logMessage('[WORKER] storage-transfer job finished')
}

export function createStorageTransferWorker() {
  return new Worker<StorageTransferJob>('storage-transfer', processStorageTransfer, {
    connection: getRedisForQueue(),
    concurrency: 1,
  })
}
