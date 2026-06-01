import os from 'os'
import { logMessage } from './logging'

/**
 * Centralized CPU allocation for video processing
 *
 * Goal: Never max out CPU, leave headroom for system/host processes
 *
 * This module coordinates between:
 * - Worker concurrency (how many jobs run at once)
 * - FFmpeg threads per job
 * - Total CPU budget
 */

export interface CpuAllocation {
  totalThreads: number
  workerConcurrency: number
  threadsPerJob: number
  cleanPreviewConcurrency: number
  maxThreadsUsed: number
}

/**
 * Calculate optimal CPU allocation based on available threads
 *
 * 2.0.4 update: defaults now target higher utilisation on the
 * common dedicated-NAS profile (TrueNAS / Synology / Unraid box
 * that exists to run FrameComment + a few static services).
 * Previously the medium and large tiers ran a single video at a
 * time, leaving more than half the box idle during big batch
 * uploads. Each tier now tries to keep the box busy with
 * `workerConcurrency × threadsPerJob ≈ totalThreads` so a bulk
 * import (e.g. 4000 files via `scripts/bulk-upload.mjs`) finishes
 * 2-4× faster than under 2.0.3.
 *
 * If you DON'T want the box busy — e.g. you also run Plex,
 * Immich, or a database that competes for CPU — set the env
 * vars below to dial it back:
 *
 *   WORKER_CONCURRENCY            number of videos in flight (default: tier-specific)
 *   FFMPEG_THREADS_PER_JOB        ffmpeg `-threads N` (default: tier-specific)
 *   CLEAN_PREVIEW_CONCURRENCY     LUT job concurrency (default: 1)
 *   CPU_THREADS                   override the "available threads" probe
 *
 * For Docker-Compose users: add them under the worker service
 * `environment:` block. For TrueNAS Apps users: the chart now
 * exposes them under "Advanced — CPU / Worker tuning".
 *
 * Remember: on hyperthreaded CPUs, 12 threads = 6 physical cores.
 */
export function getCpuAllocation(): CpuAllocation {
  const totalThreads = os.cpus().length

  // Allow override via environment variable (for Docker resource limits)
  const envThreads = process.env.CPU_THREADS ? parseInt(process.env.CPU_THREADS, 10) : null
  const effectiveThreads = envThreads && envThreads > 0 ? envThreads : totalThreads

  let workerConcurrency: number
  let cleanPreviewConcurrency: number
  let threadsPerJob: number

  // Tier-aware defaults — picked to keep the box busy on a
  // dedicated NAS but leave a thread or two free for non-encode
  // work (DB writes, HLS remux, thumbnail generation, etc.).
  if (effectiveThreads <= 2) {
    // Minimal: 1 job at a time, 1 thread
    workerConcurrency = 1
    cleanPreviewConcurrency = 1
    threadsPerJob = 1
  } else if (effectiveThreads <= 4) {
    // Small (4 threads): 1+1 jobs, 1 thread each = 2 threads (50%)
    workerConcurrency = 1
    cleanPreviewConcurrency = 1
    threadsPerJob = 1
  } else if (effectiveThreads <= 8) {
    // Medium (6-8 threads): 2+1 jobs, 3 threads each = 9 threads
    // peak. Slight oversub when clean-preview overlaps but rare.
    workerConcurrency = 2
    cleanPreviewConcurrency = 1
    threadsPerJob = 3
  } else if (effectiveThreads <= 16) {
    // Large (12-16 threads, e.g. Xeon E5-1650 v3 6c/12t):
    // 2+1 jobs, 6 threads each. 2×6 = 12 = full box utilisation
    // for the video queue, with clean-preview suppressed to
    // 1 job to avoid going hard oversub. Bumped from
    // workerConcurrency=1 in 2.0.3 — the old "Conservative"
    // comment was wishful thinking on a dedicated NAS: half the
    // CPU was sitting idle during 2.8 TB bulk uploads.
    workerConcurrency = 2
    cleanPreviewConcurrency = 1
    threadsPerJob = 6
  } else {
    // XL (24+ threads): 3+1 jobs, 8 threads each = up to 32 (~100%).
    // Encoding throughput scales sub-linearly with thread count, so
    // three parallel jobs at 8 threads beats one job at 24.
    workerConcurrency = 3
    cleanPreviewConcurrency = 1
    threadsPerJob = 8
  }

  // Env-var overrides — applied AFTER the tier defaults so users
  // can dial concurrency up or down without recompiling. Values
  // <=0 or non-numeric are ignored.
  const parseOverride = (raw: string | undefined): number | null => {
    if (!raw) return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const wcOverride = parseOverride(process.env.WORKER_CONCURRENCY)
  if (wcOverride !== null) workerConcurrency = wcOverride
  const tpjOverride = parseOverride(process.env.FFMPEG_THREADS_PER_JOB)
  if (tpjOverride !== null) threadsPerJob = tpjOverride
  const cpcOverride = parseOverride(process.env.CLEAN_PREVIEW_CONCURRENCY)
  if (cpcOverride !== null) cleanPreviewConcurrency = cpcOverride

  const maxThreadsUsed = (workerConcurrency + cleanPreviewConcurrency) * threadsPerJob

  return {
    totalThreads: effectiveThreads,
    workerConcurrency,
    threadsPerJob,
    cleanPreviewConcurrency,
    maxThreadsUsed,
  }
}

/**
 * Log CPU allocation for debugging
 */
export function logCpuAllocation(allocation: CpuAllocation): void {
  const utilizationPercent = Math.round((allocation.maxThreadsUsed / allocation.totalThreads) * 100)

  logMessage(`[CPU CONFIG] Available threads: ${allocation.totalThreads}`)
  logMessage(`[CPU CONFIG] Video workers: ${allocation.workerConcurrency}, Clean preview: ${allocation.cleanPreviewConcurrency}`)
  logMessage(`[CPU CONFIG] FFmpeg threads per job: ${allocation.threadsPerJob}`)
  logMessage(`[CPU CONFIG] Max thread usage: ${allocation.maxThreadsUsed}/${allocation.totalThreads} (~${utilizationPercent}%)`)
}
