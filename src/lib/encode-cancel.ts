/**
 * 6.14.0 — stopping an encode without throwing the video away.
 *
 * Cancelling during SD means there is nothing to keep: no tier has landed, so
 * the video is not playable and the row goes. Cancelling during HD is a
 * different decision — SD is already done and serving. The person is not
 * saying "delete this", they are saying "this is good enough, stop burning
 * CPU on it". Same for HD+ with SD and HD behind it.
 *
 * So a stop leaves the ladder exactly as tall as it got, and the video stays
 * playable at those qualities.
 *
 * The flag lives in Redis because the decision is made in an HTTP request and
 * has to reach a worker that is mid-ffmpeg, in another process. The worker
 * checks it at the points where it would otherwise persist a tier or queue the
 * next one — so the tier being encoded at the moment of the click is
 * abandoned, not silently added afterwards. Killing ffmpeg mid-frame would be
 * the only way to reclaim those seconds of CPU, and it is not worth the
 * complexity of tracking child processes across a restart.
 *
 * The TTL is a safety net: a flag nobody consumed (worker restarted, job
 * already gone) must not linger and quietly break the next encode of the same
 * video after a retry.
 */

import { getRedis } from './redis'
import { logError } from './logging'

const FLAG_TTL_SECONDS = 60 * 60 // 1 hour

function key(videoId: string): string {
  return `encode:stopped:${videoId}`
}

/** Ask the worker to stop after the tier it is on. */
export async function markEncodeStopped(videoId: string): Promise<void> {
  try {
    await getRedis().setex(key(videoId), FLAG_TTL_SECONDS, Date.now().toString())
  } catch (error) {
    // Non-fatal: `cancelPendingVideoJobs` already removed the queued tiers, so
    // the worst case is the in-flight tier lands and the ladder is one taller
    // than asked for. More quality than requested, never less.
    logError('[ENCODE-STOP] Could not set the stop flag:', error)
  }
}

/** Has someone asked for this encode to stop? */
export async function isEncodeStopped(videoId: string): Promise<boolean> {
  try {
    return (await getRedis().get(key(videoId))) !== null
  } catch (error) {
    // Fail OPEN here, deliberately: if Redis is unreachable we cannot tell,
    // and the safe answer is to let the encode finish. Producing an extra
    // tier is harmless; refusing to encode because a cache is down is not.
    logError('[ENCODE-STOP] Stop-flag lookup failed, continuing the encode:', error)
    return false
  }
}

/** Clear it — on a retry, or once the stop has been applied. */
export async function clearEncodeStopped(videoId: string): Promise<void> {
  try {
    await getRedis().del(key(videoId))
  } catch {
    // It expires on its own.
  }
}

/**
 * Which of these videos have been stopped?
 *
 * `/api/processing-status` deliberately keeps a READY row in the encoding
 * banner while BullMQ still reports an active job for it — otherwise a row
 * would vanish the moment its first tier landed, while the worker was clearly
 * still busy. After a stop that rule works against us: the tier that was
 * already inside ffmpeg stays "active" until it finishes, so a video the user
 * explicitly stopped would sit in the banner for the rest of that encode with
 * no way to dismiss it.
 *
 * One MGET over a handful of ids, so the poll stays cheap.
 */
export async function filterStoppedVideoIds(videoIds: string[]): Promise<Set<string>> {
  const stopped = new Set<string>()
  if (videoIds.length === 0) return stopped
  try {
    const values = await getRedis().mget(...videoIds.map(key))
    videoIds.forEach((id, i) => {
      if (values[i] !== null && values[i] !== undefined) stopped.add(id)
    })
  } catch (error) {
    logError('[ENCODE-STOP] Could not read stop flags:', error)
  }
  return stopped
}
