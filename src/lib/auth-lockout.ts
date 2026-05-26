/**
 * 1.5.8+: progressive-backoff lockout helper used by every share /
 * folder / OTP verify route. Each consecutive lockout window inside
 * the past 24 hours roughly doubles the next lockout duration, which
 * slows brute-force attacks to a crawl while staying friendly to the
 * occasional legit user who forgot the password.
 *
 * Tier table:
 *   1st lockout         →  15 minutes
 *   2nd consecutive     →   1 hour
 *   3rd+ consecutive    →   4 hours
 *
 * `consecutiveLockouts` resets when the most recent lockout is more
 * than 24 hours old, so a single forgotten-password incident next
 * year doesn't carry forward any penalty.
 */

const FIFTEEN_MIN_MS = 15 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

/** Resets the consecutiveLockouts counter when no lockout has
 *  happened for this long. 24h covers "client tried again next day
 *  after a fresh sleep". */
export const LOCKOUT_DECAY_MS = 24 * 60 * 60 * 1000

/**
 * How long the next lockout should last, given how many lockouts the
 * current IP+target pair has accumulated inside the decay window.
 *
 * @param consecutiveLockouts  count of consecutive lockouts within
 *                             `LOCKOUT_DECAY_MS`, including the one
 *                             we're about to apply.
 */
export function lockoutDurationMs(consecutiveLockouts: number): number {
  if (consecutiveLockouts <= 1) return FIFTEEN_MIN_MS
  if (consecutiveLockouts === 2) return ONE_HOUR_MS
  return FOUR_HOURS_MS
}

/**
 * Shape stored in Redis at each rate-limit key. We bumped this to
 * track `consecutiveLockouts` and `lastLockoutAt` in v1.5.8 — older
 * entries without those fields still parse correctly because the
 * extras default to 0 / undefined.
 */
export interface LockoutEntry {
  count: number
  firstAttempt: number
  lastAttempt: number
  lockoutUntil?: number
  consecutiveLockouts?: number
  lastLockoutAt?: number
}

/**
 * Decide whether `consecutiveLockouts` should keep counting up or
 * reset to 1 because the previous lockout was a long time ago.
 */
export function nextConsecutiveLockouts(prev: LockoutEntry | null, now: number): number {
  if (!prev?.consecutiveLockouts || !prev.lastLockoutAt) return 1
  const elapsed = now - prev.lastLockoutAt
  if (elapsed >= LOCKOUT_DECAY_MS) return 1
  return prev.consecutiveLockouts + 1
}
