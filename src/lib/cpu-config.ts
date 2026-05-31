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
 * Conservative approach:
 * - Targets ~30-50% thread utilization
 * - Leaves plenty of headroom for system/host processes
 * - Remember: on hyperthreaded CPUs, 12 threads = 6 physical cores
 */
export function getCpuAllocation(): CpuAllocation {
  const totalThreads = os.cpus().length

  // Allow override via environment variable (for Docker resource limits)
  const envThreads = process.env.CPU_THREADS ? parseInt(process.env.CPU_THREADS, 10) : null
  const effectiveThreads = envThreads && envThreads > 0 ? envThreads : totalThreads

  let workerConcurrency: number
  let cleanPreviewConcurrency: number
  let threadsPerJob: number

  // Conservative allocation - keep CPU usage low
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
    // Medium (6-8 threads): 1+1 jobs, 4 threads each = up to 8 (100%
    // when a job is running, idle otherwise). 1.9.4+ Phase A bumped
    // this from 2 threads/job to 4 — typical dedicated NAS / TrueNAS
    // boxes have nothing else burning CPU, so we should USE the
    // threads we have rather than play conservative.
    workerConcurrency = 1
    cleanPreviewConcurrency = 1
    threadsPerJob = 4
  } else if (effectiveThreads <= 16) {
    // Large (12-16 threads, e.g. Xeon E5-1650 v3 6c/12t): 1+1 jobs,
    // 6 threads each. With Phase A's parallel-tier encoding we run
    // 2 ffmpeg processes simultaneously after the first tier flips
    // READY, so 6+6 = 12 threads = full utilisation of a 12-thread
    // box. The `nice -n 10` cushion already keeps the system
    // responsive, so leaving 8 of 12 threads idle (the old config)
    // was just CPU left on the floor.
    workerConcurrency = 1
    cleanPreviewConcurrency = 1
    threadsPerJob = 6
  } else {
    // XL (24+ threads): 2+1 jobs, 8 threads each = up to 24 (50-67%).
    // Two parallel video jobs keep the box busy without saturating.
    workerConcurrency = 2
    cleanPreviewConcurrency = 1
    threadsPerJob = 8
  }

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
