import { Queue } from 'bullmq'
import { getRedisForQueue } from './redis'

// Lazy initialization to prevent connections during build time
let videoQueueInstance: Queue<VideoQueueJobData> | null = null
let assetQueueInstance: Queue<AssetProcessingJob> | null = null
let projectUploadQueueInstance: Queue<ProjectUploadProcessingJob> | null = null
let externalNotificationQueueInstance: Queue<ExternalNotificationJob> | null = null
let cleanPreviewQueueInstance: Queue<CleanPreviewJob> | null = null

// 2.2.0+: legacy single-shot job payload. Kept exported (not
// removed) for two reasons:
//   1. Backwards compat with any external code / tests that
//      reference the type name.
//   2. The queue is the same physical Redis stream — a job
//      enqueued by a pre-2.2.0 deployment that happens to land
//      in a fresh 2.2.0 worker will still parse as this shape
//      and gets routed by `job.name` in the worker dispatcher
//      (see src/worker/index.ts).
export interface VideoProcessingJob {
  videoId: string
  originalStoragePath: string
  projectId: string
}

// 2.2.0+: breadth-first pipeline payloads.
//
// PrepareVideoJob does the cheap up-front work that EVERY video
// needs no matter how many tiers it'll get: download original,
// magic-byte validation, probe metadata, thumbnail, decide
// `plannedTiers`, then enqueue one `EncodeTierJob` per tier +
// one `FinalizeVideoJob` to mop up. It runs at priority 1 — the
// highest in the whole pipeline — so on a bulk upload of N
// files, all N prepare jobs blast through before any encode
// job starts, which is exactly what unlocks the "every video
// has a thumbnail + is enqueued for encoding within a few
// seconds" UX win.
export interface PrepareVideoJob {
  videoId: string
  originalStoragePath: string
  projectId: string
}

// 2.2.0+: encode a single quality tier for a single video.
//
// Priority is assigned by the enqueueing code (PrepareVideoJob)
// based on tier — 10 for 480p, 50 for 720p, 100 for 1080p, 200
// for 2160p. BullMQ pops lower-priority numbers first, so on a
// 100-video upload every 480p gets processed BEFORE any 720p
// starts, then every 720p before any 1080p, etc. That's the
// breadth-first behaviour the release is built around.
export interface EncodeTierJob {
  videoId: string
  projectId: string
  // Path to the source file in storage (S3 key / local path)
  // so that if /tmp got evicted between prepare and encode we
  // can re-download.
  originalStoragePath: string
  tier: '480p' | '720p' | '1080p' | '2160p'
}

// 2.2.0+: post-encode cleanup job.
//
// Enqueued by PrepareVideoJob at priority 500 (the lowest in
// the pipeline) so it never starves an encode-tier of a
// different video. The handler checks `completedTiers.length
// === plannedTiers.length`; if not, re-queues itself with a
// delay (handles the "wait until all tiers actually land"
// requirement without blocking a worker slot).
export interface FinalizeVideoJob {
  videoId: string
  projectId: string
  // Used so the finalize job can fall back to re-downloading
  // the source for the storyboard pass if /tmp was evicted.
  originalStoragePath: string
}

// Union over every shape a single job on the video-processing
// queue can carry. The worker uses `job.name` to discriminate,
// so this type is the static "what payload does the handler
// see" mirror of the dynamic discriminator. We accept the
// legacy `VideoProcessingJob` here so a pre-2.2.0 `process-video`
// job sitting in Redis at upgrade time can still be picked up
// and re-routed (see worker/index.ts dispatch).
export type VideoQueueJobData =
  | VideoProcessingJob
  | PrepareVideoJob
  | EncodeTierJob
  | FinalizeVideoJob

// 2.2.0+: priorities are hard-coded constants instead of magic
// numbers scattered around enqueue sites. BullMQ priority is
// `number` (lower = sooner). The gaps between tiers leave room
// for hot-fixes / experimentation without renumbering.
export const VIDEO_JOB_PRIORITY = {
  PREPARE: 1,
  ENCODE_480P: 10,
  ENCODE_720P: 50,
  ENCODE_1080P: 100,
  ENCODE_2160P: 200,
  FINALIZE: 500,
} as const

export function priorityForTier(tier: EncodeTierJob['tier']): number {
  switch (tier) {
    case '480p':
      return VIDEO_JOB_PRIORITY.ENCODE_480P
    case '720p':
      return VIDEO_JOB_PRIORITY.ENCODE_720P
    case '1080p':
      return VIDEO_JOB_PRIORITY.ENCODE_1080P
    case '2160p':
      return VIDEO_JOB_PRIORITY.ENCODE_2160P
  }
}

/**
 * 2.2.0+: cancel every pending job for a given videoId in the
 * video-processing queue.
 *
 * Called by the video delete endpoint when a user pulls the plug
 * mid-encode. Without this, on a permanent delete:
 *   - The currently-running encode-tier ffmpeg would still abort
 *     cleanly (the helper sees P2025 and throws TranscodeAborted),
 *     but
 *   - Any QUEUED encode-tier jobs (e.g. the 1080p slot waiting
 *     for the 720p to free up CPU) would still start, run their
 *     own lookup, see no row, and waste a worker slot logging
 *     "row not found".
 *
 * The pattern is straightforward thanks to the jobIds we assign at
 * enqueue time:
 *   - prepare-<videoId>
 *   - encode-<videoId>-<tier>
 *   - finalize-<videoId>
 *   - finalize-<videoId>-retry-<timestamp>
 *
 * `Queue.remove(jobId)` is a no-op if the job is already gone or
 * currently active, so calling this repeatedly is safe. Active
 * jobs aren't removed by remove() — they're cancelled organically
 * via the TranscodeAborted path on their next DB write.
 */
export async function cancelPendingVideoJobs(videoId: string): Promise<void> {
  const queue = getVideoQueue()
  // Direct jobId removals for the deterministic IDs.
  const knownIds = [
    `prepare-${videoId}`,
    `encode-${videoId}-480p`,
    `encode-${videoId}-720p`,
    `encode-${videoId}-1080p`,
    `encode-${videoId}-2160p`,
    `finalize-${videoId}`,
  ]
  await Promise.allSettled(knownIds.map((id) => queue.remove(id)))

  // Sweep for any retry-suffixed finalize jobs (timestamps make
  // them non-deterministic). getJobs() returns up to the limit
  // across the listed states; we scan delayed + waiting which is
  // where finalize-<videoId>-retry-<ts> sits between requeues.
  try {
    const candidates = await queue.getJobs(['delayed', 'waiting'], 0, 500, true)
    for (const j of candidates) {
      if (!j) continue
      const data: any = j.data || {}
      if (data?.videoId === videoId) {
        try {
          await j.remove()
        } catch {
          // Race: job picked up by a worker between scan + remove.
          // The worker will hit P2025 immediately and bail cleanly.
        }
      }
    }
  } catch {
    // Best-effort — if getJobs blows up for any reason we still
    // got the deterministic IDs above, which covers >99% of cases.
  }
}

export interface AssetProcessingJob {
  assetId: string
  storagePath: string
  expectedCategory?: string
}

export interface ProjectUploadProcessingJob {
  uploadId: string
  storagePath: string
  projectId: string
}

export interface ExternalNotificationJob {
  // When set, worker sends only to these destinations (used for tests).
  destinationIds?: string[]

  // Used for subscription matching and logging.
  eventType: string

  title: string
  body: string
  notifyType?: 'info' | 'success' | 'warning' | 'failure'
}

export interface CleanPreviewJob {
  videoId: string
  projectId: string
  originalStoragePath: string
  resolution: string // "720p", "1080p", or "2160p"
}

export function getVideoQueue(): Queue<VideoQueueJobData> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!videoQueueInstance) {
    // 2.2.0+: same physical queue name as 2.1.x — multiple job
    // *types* (`prepare-video`, `encode-tier`, `finalize-video`,
    // plus the legacy `process-video`) coexist on it. The single
    // Worker in src/worker/index.ts dispatches on `job.name`.
    // defaultJobOptions (attempts: 3, exponential backoff,
    // removeOnComplete/Fail) apply uniformly to every job type,
    // so retries + cleanup work identically for the split jobs.
    videoQueueInstance = new Queue<VideoQueueJobData>('video-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // keep completed jobs for 1 hour
        },
        removeOnFail: {
          age: 86400, // keep failed jobs for 24 hours
        },
      },
    })
  }
  return videoQueueInstance
}

export function getAssetQueue(): Queue<AssetProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!assetQueueInstance) {
    assetQueueInstance = new Queue<AssetProcessingJob>('asset-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // keep completed jobs for 1 hour
        },
        removeOnFail: {
          age: 86400, // keep failed jobs for 24 hours
        },
      },
    })
  }
  return assetQueueInstance
}

export function getProjectUploadQueue(): Queue<ProjectUploadProcessingJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!projectUploadQueueInstance) {
    projectUploadQueueInstance = new Queue<ProjectUploadProcessingJob>('project-upload-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // keep completed jobs for 1 hour
        },
        removeOnFail: {
          age: 86400, // keep failed jobs for 24 hours
        },
      },
    })
  }
  return projectUploadQueueInstance
}

export function getExternalNotificationQueue(): Queue<ExternalNotificationJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!externalNotificationQueueInstance) {
    externalNotificationQueueInstance = new Queue<ExternalNotificationJob>('external-notifications', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // keep completed jobs for 1 hour
        },
        removeOnFail: {
          age: 86400, // keep failed jobs for 24 hours
        },
      },
    })
  }

  return externalNotificationQueueInstance
}

export function getCleanPreviewQueue(): Queue<CleanPreviewJob> {
  // Don't create queue during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    throw new Error('Queue not available during build phase')
  }

  if (!cleanPreviewQueueInstance) {
    cleanPreviewQueueInstance = new Queue<CleanPreviewJob>('clean-preview-processing', {
      connection: getRedisForQueue(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600, // keep completed jobs for 1 hour
        },
        removeOnFail: {
          age: 86400, // keep failed jobs for 24 hours
        },
      },
    })
  }

  return cleanPreviewQueueInstance
}

// Export for backward compatibility, but use getter in new code
export const videoQueue = new Proxy({} as Queue<VideoQueueJobData>, {
  get(_target, prop) {
    return getVideoQueue()[prop as keyof Queue<VideoQueueJobData>]
  }
})

export const assetQueue = new Proxy({} as Queue<AssetProcessingJob>, {
  get(_target, prop) {
    return getAssetQueue()[prop as keyof Queue<AssetProcessingJob>]
  }
})
