import { Worker, Queue, Job } from 'bullmq'
import {
  VideoProcessingJob,
  VideoQueueJobData,
  PrepareVideoJob,
  EncodeTierJob,
  FinalizeVideoJob,
  RegenerateThumbnailJob,
  CreateTranscriptJob,
  AssetProcessingJob,
  ProjectUploadProcessingJob,
  ExternalNotificationJob,
} from '../lib/queue'
import { initStorage, refreshLocalStorageRoot } from '../lib/storage'
import { runCleanup } from '../lib/upload-cleanup'
import { purgeExpiredTrash } from '../lib/trash-cleanup'
import { purgeExpiredAccessAttempts, ACCESS_RETENTION_DAYS } from '../lib/access-log'
import { runScheduledSecurityScan, scheduledScanIsDue } from '../lib/scheduled-security-scan'
import { finalizeExpiredTransfers } from '../lib/ownership'
import { getRedisForQueue, closeRedisConnection } from '../lib/redis'
import { getCpuAllocation, logCpuAllocation } from '../lib/cpu-config'
import { getActiveVideoEncoder, getMaxParallelTranscodes } from '../lib/ffmpeg'
import { processVideo } from './video-processor'
import { processPrepareVideo } from './prepare-video-processor'
import { processEncodeTier } from './encode-tier-processor'
import { processFinalizeVideo } from './finalize-video-processor'
import { processRegenerateThumbnail } from './regenerate-thumbnail-processor'
import { processCreateTranscript } from './create-transcript-processor'
import { processAsset } from './asset-processor'
import { processProjectUpload } from './project-upload-processor'
import { processAdminNotifications } from './admin-notifications'
import { processClientNotifications } from './client-notifications'
import { processExternalNotificationJob } from './external-notifications/processExternalNotificationJob'
import { createStorageTransferWorker } from './storage-transfer-processor'
import { processDueDateReminders } from './due-date-reminders'
import { processBillingCycle } from './billing-cycle'
import { processOrgDeletions } from './org-deletion'
import { recordHeartbeat } from '../lib/platform-uptime'
import { cleanupOldTempFiles, ensureTempDir } from './cleanup'
import { logError, logMessage } from '../lib/logging'

const DEBUG = process.env.DEBUG_WORKER === 'true'
const ONE_HOUR_MS = 60 * 60 * 1000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

async function main() {
  logMessage('[WORKER] Initializing video processing worker...')

  // 6.8.0 Faza 5: mark the boot before anything else can fail. If the worker
  // was down, the gap since the last beat is recorded as an outage right here.
  await recordHeartbeat('worker', {
    isBoot: true,
    version: process.env.npm_package_version || null,
  })

  // Get centralized CPU allocation (coordinates with FFmpeg threads)
  const cpuAllocation = getCpuAllocation()
  logCpuAllocation(cpuAllocation)

  // 1.9.4+ Phase A: log the active video encoder + parallelism so
  // it's obvious at startup which transcoding path is in use.
  logMessage(
    `[WORKER] Video encoder: ${getActiveVideoEncoder()} (max parallel tiers: ${getMaxParallelTranscodes()})`,
  )

  if (DEBUG) {
    logMessage('[WORKER DEBUG] Debug mode is ENABLED')
    logMessage(`[WORKER DEBUG] Node version: ${process.version}`)
    logMessage(`[WORKER DEBUG] Platform: ${process.platform}`)
    logMessage(`[WORKER DEBUG] Architecture: ${process.arch}`)
  }

  // Ensure temp directory exists
  ensureTempDir()

  // Initialize storage
  if (DEBUG) {
    logMessage('[WORKER DEBUG] Initializing storage...')
  }

  // 4.2.0+ (Phase 2d): load the configured local uploads folder before any
  // storage op so worker writes land in the right place from the first job.
  await refreshLocalStorageRoot()
  await initStorage()

  if (DEBUG) {
    logMessage('[WORKER DEBUG] Storage initialized')
  }

  // Use centralized CPU allocation for worker concurrency
  const concurrency = cpuAllocation.workerConcurrency

  logMessage(`[WORKER] Worker concurrency: ${concurrency} (from CPU allocation)`)

  // 2.2.0+: single Worker, multiple job types on the same queue.
  // We dispatch on `job.name` so a 2.1.x-era `process-video` job
  // sitting in Redis at upgrade time still routes correctly via the
  // legacy `processVideo` handler — that preserves backwards compat
  // for jobs already enqueued before the worker swap.
  //
  // New job types:
  //   - prepare-video   → processPrepareVideo  (prio 1)
  //   - encode-tier     → processEncodeTier    (prio 10/50/100/200)
  //   - finalize-video  → processFinalizeVideo (prio 500)
  //
  // BullMQ's `defaultJobOptions.attempts: 3` from getVideoQueue()
  // applies to ALL of these uniformly, so transient failures retry
  // identically to 2.1.x.
  const videoJobRouter = async (job: Job<VideoQueueJobData>) => {
    switch (job.name) {
      case 'prepare-video':
        return processPrepareVideo(job as Job<PrepareVideoJob>)
      case 'encode-tier':
        return processEncodeTier(job as Job<EncodeTierJob>)
      case 'finalize-video':
        return processFinalizeVideo(job as Job<FinalizeVideoJob>)
      case 'regenerate-thumbnail':
        // 2.2.4+: maintenance job — priority 700 (post-FINALIZE) so
        // a bulk sweep never delays an in-flight tier encode.
        return processRegenerateThumbnail(job as Job<RegenerateThumbnailJob>)
      case 'create-transcript':
        // 3.9.x: lowest-priority (900) — audio extract + OpenAI whisper
        // + PDF render. Never delays encode/thumbnail work.
        return processCreateTranscript(job as Job<CreateTranscriptJob>)
      case 'process-video':
      default:
        // Legacy path — drains any 2.1.x jobs that were enqueued
        // before the deploy. New uploads always enqueue
        // `prepare-video` via the four updated call sites.
        return processVideo(job as Job<VideoProcessingJob>)
    }
  }

  const worker = new Worker<VideoQueueJobData>('video-processing', videoJobRouter, {
    connection: getRedisForQueue(),
    concurrency,
    lockDuration: 600_000,
    stalledInterval: 300_000,
    maxStalledCount: 2,
    limiter: {
      max: concurrency * 10,
      duration: 60000,
    },
  })

  if (DEBUG) {
    logMessage(`[WORKER DEBUG] BullMQ worker created with config: ${JSON.stringify({
      queue: 'video-processing',
      concurrency,
      limiter: {
        max: concurrency * 10,
        duration: 60000
      }
    })}`)
  }

  worker.on('completed', (job) => {
    logMessage(`[WORKER] Job ${job.id} completed successfully`)
  })

  worker.on('failed', (job, err) => {
    logError(`[WORKER ERROR] Job ${job?.id} failed`, err)
    if (DEBUG) {
      logMessage(`[WORKER DEBUG] Job failure details: ${JSON.stringify({
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err
      })}`)
    }
  })

  logMessage('[WORKER] Video processing worker started')

  // Create asset processing worker
  const assetWorker = new Worker<AssetProcessingJob>('asset-processing', processAsset, {
    connection: getRedisForQueue(),
    concurrency: concurrency * 2, // Assets are lighter than videos
  })

  assetWorker.on('completed', (job) => {
    logMessage(`[WORKER] Asset job ${job.id} completed successfully`)
  })

  assetWorker.on('failed', (job, err) => {
    logError(`[WORKER ERROR] Asset job ${job?.id} failed`, err)
    if (DEBUG) {
      logMessage(`[WORKER DEBUG] Asset job failure details: ${JSON.stringify({
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err
      })}`)
    }
  })

  logMessage('[WORKER] Asset processing worker started')

  // Create project upload processing worker
  const projectUploadWorker = new Worker<ProjectUploadProcessingJob>('project-upload-processing', processProjectUpload, {
    connection: getRedisForQueue(),
    concurrency: concurrency * 2, // Project uploads are lighter than videos
  })

  projectUploadWorker.on('completed', (job) => {
    logMessage(`[WORKER] Project upload job ${job.id} completed successfully`)
  })

  projectUploadWorker.on('failed', (job, err) => {
    logError(`[WORKER ERROR] Project upload job ${job?.id} failed`, err)
    if (DEBUG) {
      logMessage(`[WORKER DEBUG] Project upload job failure details: ${JSON.stringify({
        jobId: job?.id,
        jobData: job?.data,
        error: err instanceof Error ? err.stack : err
      })}`)
    }
  })

  logMessage('[WORKER] Project upload processing worker started')

  // Create notification processing queue with repeatable job
  logMessage('Setting up notification processing...')
  const notificationQueue = new Queue('notification-processing', {
    connection: getRedisForQueue(),
  })

  // Add repeatable job to check notification schedules every minute
  await notificationQueue.add(
    'process-notifications',
    {},
    {
      repeat: {
        pattern: '* * * * *',
      },
      jobId: 'notification-processor',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  )

  // Create worker to process notification jobs
  const notificationWorker = new Worker(
    'notification-processing',
    async () => {
      logMessage('Running scheduled notification check...')

      await Promise.all([
        processAdminNotifications(),
        processClientNotifications(),
        processDueDateReminders(),
        // 3.7.0+: usage billing. No-op unless a card is connected AND
        // today is the billing day — then it invoices + charges via
        // Stripe.
        processBillingCycle(),
        // 5.10 Danger Zone: wipes orgs whose 30-day deletion countdown has
        // elapsed (server-side clock; re-verifies zero projects first).
        processOrgDeletions(),
        // 6.8.0 Faza 5: uptime. One beat a minute; a missing beat is written
        // down as an outage when the worker comes back. See platform-uptime.ts
        // for what this can and cannot see.
        recordHeartbeat('worker'),
      ])

      logMessage('Notification check completed')
    },
    {
      connection: getRedisForQueue(),
      concurrency: 1,
    }
  )

  notificationWorker.on('completed', (job) => {
    logMessage(`Notification check ${job.id} completed`)
  })

  notificationWorker.on('failed', (job, err) => {
    logError(`Notification check ${job?.id} failed`, err)
  })

  logMessage('Notification worker started')
  logMessage('  → Checks every 1 minute for scheduled summaries')
  logMessage('  → IMMEDIATE notifications sent instantly (not in batches)')

  // Create worker to process external notification jobs (Apprise)
  const externalNotificationWorker = new Worker<ExternalNotificationJob>(
    'external-notifications',
    async (job) => {
      await processExternalNotificationJob(job.data, String(job.id ?? 'unknown'))
    },
    {
      connection: getRedisForQueue(),
      concurrency: 5,
    }
  )

  externalNotificationWorker.on('completed', (job) => {
    if (DEBUG) {
      logMessage(`[WORKER] External notification job ${job.id} completed`)
    }
  })

  externalNotificationWorker.on('failed', (job, err) => {
    logError(`[WORKER ERROR] External notification job ${job?.id} failed`, err)
  })

  logMessage('External notification worker started')

  // 4.2.0+ (Phase 2): storage transfer worker — migrates files between
  // backends on admin request. Concurrency 1; progress lives in Redis.
  const storageTransferWorker = createStorageTransferWorker()
  storageTransferWorker.on('completed', () => {
    logMessage('[WORKER] Storage transfer completed')
  })
  storageTransferWorker.on('failed', (_job, err) => {
    logError('[WORKER ERROR] Storage transfer failed', err)
  })
  logMessage('[WORKER] Storage transfer worker started')

  // Run cleanup on startup
  logMessage('Running initial TUS upload cleanup...')
  await runCleanup().catch((err) => {
    logError('Initial cleanup failed', err)
  })

  // Cleanup old temp files on startup
  logMessage('Running initial temp file cleanup...')
  await cleanupOldTempFiles()

  // Schedule periodic cleanup every 6 hours (TUS uploads)
  const tusCleanupInterval = setInterval(async () => {
    logMessage('Running scheduled TUS upload cleanup...')
    await runCleanup().catch((err) => {
      logError('Scheduled cleanup failed', err)
    })
  }, SIX_HOURS_MS)

  // Schedule temp file cleanup every hour
  const tempCleanupInterval = setInterval(async () => {
    logMessage('Running scheduled temp file cleanup...')
    await cleanupOldTempFiles()
  }, ONE_HOUR_MS)

  /*
   * 6.18.0 — access-log retention.
   *
   * IP addresses are personal data under GDPR, and the Security page states a
   * retention window. A stated policy that nothing enforces is worse than no
   * policy: it is a claim we would be making to customers and investors while
   * quietly keeping the data forever.
   *
   * Runs at startup as well as on a timer, so an installation that was off for
   * a fortnight does not sit on expired records until its first midnight.
   */
  logMessage(`Purging access records older than ${ACCESS_RETENTION_DAYS} days...`)
  await purgeExpiredAccessAttempts()
    .then((n) => n > 0 && logMessage(`[WORKER] Removed ${n} expired access records`))
    .catch((err) => logError('Initial access-log purge failed', err))

  /*
   * 6.19.0 — the weekly security scan.
   *
   * A scan you have to remember to press is a scan that gets pressed once. The
   * findings that matter appear later: a dependency advisory published next
   * month, a share link somebody made public in March, a certificate that
   * lapsed. None of those announce themselves.
   *
   * The timer ticks hourly but the DUE check is against the database, so a
   * container that restarts twice a day neither skips the week nor scans on
   * every boot. It runs in the worker rather than the web container because
   * the web container can have several replicas and a timer there would fire
   * once per replica.
   */
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const securityScanInterval = setInterval(async () => {
    try {
      if (!(await scheduledScanIsDue(WEEK_MS))) return
      logMessage('Running scheduled weekly security scan...')
      await runScheduledSecurityScan()
    } catch (err) {
      logError('Scheduled security scan failed', err)
    }
  }, ONE_HOUR_MS)

  const accessPurgeInterval = setInterval(async () => {
    await purgeExpiredAccessAttempts()
      .then((n) => n > 0 && logMessage(`[WORKER] Removed ${n} expired access records`))
      .catch((err) => logError('Scheduled access-log purge failed', err))
  }, SIX_HOURS_MS)

  // Schedule Trash cleanup every 24 hours (1.0.8+). Hard-deletes
  // soft-deleted videos and folders whose `deletedAt` is older than
  // 30 days. Runs once at startup so a server that's been off for a
  // few days catches up immediately.
  logMessage('Running initial Trash cleanup...')
  await purgeExpiredTrash()
    .then((r) =>
      logMessage(
        `[WORKER] Trash cleanup removed ${r.videos} videos, ${r.folders} folders`,
      ),
    )
    .catch((err) => logError('Initial trash cleanup failed', err))
  const trashCleanupInterval = setInterval(async () => {
    logMessage('Running scheduled Trash cleanup...')
    try {
      const r = await purgeExpiredTrash()
      logMessage(
        `[WORKER] Trash cleanup removed ${r.videos} videos, ${r.folders} folders`,
      )
    } catch (err) {
      logError('Scheduled trash cleanup failed', err)
    }
  }, ONE_DAY_MS)

  // 4.3.0+: finalize expired ownership transfers (previous owner → Admin once
  // the 30-day grace window elapses). Lazy checks in the API cover most cases;
  // this guarantees it happens even on an idle instance. Runs at startup + hourly.
  await finalizeExpiredTransfers().catch((err) =>
    logError('Initial ownership-transfer finalize failed', err),
  )
  const ownershipFinalizeInterval = setInterval(async () => {
    try {
      await finalizeExpiredTransfers()
    } catch (err) {
      logError('Scheduled ownership-transfer finalize failed', err)
    }
  }, 60 * 60 * 1000)

  // Handle shutdown gracefully
  process.on('SIGTERM', async () => {
    logMessage('SIGTERM received, closing workers...')
    clearInterval(tusCleanupInterval)
    clearInterval(accessPurgeInterval)
    clearInterval(securityScanInterval)
    clearInterval(tempCleanupInterval)
    clearInterval(trashCleanupInterval)
    clearInterval(ownershipFinalizeInterval)
    await Promise.all([
      worker.close(),
      assetWorker.close(),
      notificationWorker.close(),
      externalNotificationWorker.close(),
      storageTransferWorker.close(),
      notificationQueue.close(),
    ])
    await closeRedisConnection()
    logMessage('Redis connection closed')
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    logMessage('SIGINT received, closing workers...')
    clearInterval(tusCleanupInterval)
    clearInterval(tempCleanupInterval)
    clearInterval(trashCleanupInterval)
    clearInterval(ownershipFinalizeInterval)
    await Promise.all([
      worker.close(),
      assetWorker.close(),
      notificationWorker.close(),
      externalNotificationWorker.close(),
      storageTransferWorker.close(),
      notificationQueue.close(),
    ])
    await closeRedisConnection()
    logMessage('Redis connection closed')
    process.exit(0)
  })
}

main().catch((err) => {
  logError('Worker error', err)
  process.exit(1)
})
