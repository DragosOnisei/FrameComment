/**
 * 7.18.8: what a folder card may do on hover when a video has no storyboard.
 *
 * Hover-scrub is a sprite sheet (`storyboardPath`, one JPEG, ~100 KB). Rows
 * from before the storyboard step — and rows whose storyboard step failed —
 * fell back to seeking a low-res `<video>`: every seek fetches another byte
 * range of the 480p file. On a 37-minute 4K interview served from the
 * FrameComment Server bucket that was 4 MB per seek, dozens of seeks per
 * crossing, 108 MB for one hover (Dragos's DevTools), and the burst of
 * authenticated range requests pushed the rate limiter's Redis into
 * timeouts — 503s on media, and the preview showed nothing at all while
 * the one card WITH a sprite scrubbed fine. Two rules, pure so a script
 * exercises them:
 *
 *   - the `<video>` fallback is for SHORT clips only (`LEGACY_SCRUB_MAX_SECONDS`):
 *     a 2-minute preview is a few MB in all and seeks within what is
 *     already buffered; a long one is a download per seek.
 *   - a signed-in admin hovering a READY, encoded video without a sprite
 *     asks the worker, once per card per page, to build JUST the sprite
 *     (`storyboardOnly`, thumbnail untouched — a custom cover must survive).
 *     The next visit scrubs. Guests never trigger work.
 */

export const LEGACY_SCRUB_MAX_SECONDS = 180

export function legacyScrubAllowed(durationSeconds: number | null | undefined): boolean {
  return typeof durationSeconds === 'number' && durationSeconds > 0 && durationSeconds <= LEGACY_SCRUB_MAX_SECONDS
}

export interface StoryboardRequestInput {
  isVideo: boolean
  hasStoryboard: boolean
  status?: string | null
  completedTiers?: string[] | null
  /** The viewer holds an admin session (apiFetch can carry a token). */
  signedIn: boolean
}

export function shouldRequestStoryboard(input: StoryboardRequestInput): boolean {
  if (!input.isVideo || input.hasStoryboard || !input.signedIn) return false
  if (input.status !== 'READY') return false
  return Array.isArray(input.completedTiers) && input.completedTiers.length > 0
}
