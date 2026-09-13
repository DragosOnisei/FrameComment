/**
 * 7.9.0: the arithmetic behind the "N / M tiers done" header of the
 * processing banner, as pure functions so it can be tested.
 *
 * The banner polls a list of videos still being worked on. A video that
 * finishes leaves the list, so its tiers must be folded into a running base
 * or the denominator would shrink as work completes. Until 7.9.0 EVERY
 * disappearance was treated as "finished" at once: but after the first tier
 * lands a video was listed only while one of its jobs was ACTIVE, so between
 * two tiers — waiting for a free slot — it vanished for a poll, its whole
 * ladder was added to the base as done, and when it came back it was counted
 * again. Four uploads of four tiers each read "25 / 27".
 *
 * The rule now: a video that vanishes is kept for a grace of two polls with
 * its last numbers, still counted as if it were listed, so the header does
 * not dip. If it comes back within the grace it simply resumes (counted once).
 * If it stays gone, it is folded into the base as finished, once. A video the
 * user stopped mid-way is folded the same way — its remaining tiers read as
 * done rather than making the total shrink, a deliberate trade for a header
 * that never moves backwards.
 */

/** Polls a vanished video is held before it counts as finished. */
export const TALLY_GRACE_POLLS = 2

export interface TallySnapshot {
  planned: number
  done: number
  /** Consecutive polls this video has been missing from the list; 0 = listed. */
  missed: number
}

export interface TallyVideo {
  id: string
  planned: number
  done: number
}

export interface TallyStep {
  /** Tiers of videos that stayed gone for the grace — add to the base as done. */
  finished: number
  /** Snapshots: every listed video (missed 0) plus vanished ones still in grace. */
  next: Record<string, TallySnapshot>
  /** False when `next` equals `prevSeen` (so a caller can keep the old object). */
  changed: boolean
}

export function tallyStep(prevSeen: Record<string, TallySnapshot>, videos: TallyVideo[]): TallyStep {
  const live = new Set(videos.map((v) => v.id))
  const next: Record<string, TallySnapshot> = {}
  let finished = 0
  for (const [id, snap] of Object.entries(prevSeen)) {
    if (live.has(id)) continue
    const missed = snap.missed + 1
    if (missed >= TALLY_GRACE_POLLS) {
      if (snap.planned > 0) finished += snap.planned
      continue
    }
    next[id] = { ...snap, missed }
  }
  for (const v of videos) next[v.id] = { planned: v.planned, done: Math.min(v.done, v.planned), missed: 0 }
  const prevKeys = Object.keys(prevSeen)
  const nextKeys = Object.keys(next)
  const changed =
    prevKeys.length !== nextKeys.length ||
    nextKeys.some((k) => {
      const p = prevSeen[k]
      const n = next[k]
      return !p || p.planned !== n.planned || p.done !== n.done || p.missed !== n.missed
    })
  return { finished, next, changed }
}

/**
 * The live part of the header: listed videos from `videos`, plus vanished
 * videos still within the grace (their last numbers), so a video between two
 * tiers never makes the header dip.
 */
export function tallyLive(seen: Record<string, TallySnapshot>, videos: TallyVideo[]): { done: number; total: number } {
  let done = 0
  let total = 0
  const live = new Set<string>()
  for (const v of videos) {
    live.add(v.id)
    done += Math.min(v.done, v.planned)
    total += v.planned
  }
  for (const [id, snap] of Object.entries(seen)) {
    if (live.has(id)) continue
    done += Math.min(snap.done, snap.planned)
    total += snap.planned
  }
  return { done, total }
}
