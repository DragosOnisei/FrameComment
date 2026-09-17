/**
 * 7.12.0: which file a thumbnail (and storyboard) refresh should read.
 *
 * The regenerate job used to read the ORIGINAL, always. On a company whose
 * storage is the FrameComment Server bucket that means downloading the whole
 * master into the worker's /tmp first — for a 25-minute 4K interview that is
 * a file in the tens of gigabytes pulled down to grab frame zero and a hundred
 * 192×108 tiles, and /tmp on the worker is a memory disk that cannot hold it.
 * The job died on disk space (or ran for many minutes), and every later click
 * on "Regenerate thumbnail" was deduplicated against that failed job (see
 * `addJobReplacingFinished` in queue.ts). The video sat without a cover.
 *
 * The encoded tiers are the same picture, a fraction of the size, already in
 * the same storage. So: read the original only when it is on local disk (no
 * copy needed); otherwise read a tier — 720p first, because the thumbnail is
 * capped at 1280×720 anyway, so nothing is lost; then 1080p; then 480p (soft,
 * but a cover); then 2160p (still smaller than most masters); and only when no
 * tier exists at all fall back to downloading the original.
 *
 * Pure, so the order is exercised by a script before release.
 */

export type ThumbnailTier = '720p' | '1080p' | '480p' | '2160p'

export interface ThumbnailSourceInput {
  /** The master is readable straight from a local disk (no download). */
  localOriginal: boolean
  /** Storage paths of the encoded tiers, null/undefined when not produced. */
  tiers: Partial<Record<ThumbnailTier, string | null | undefined>>
}

export type ThumbnailSource =
  | { kind: 'original'; reason: 'local' | 'no-tiers' }
  | { kind: 'tier'; tier: ThumbnailTier; path: string }

/** Preference order when the master would have to be downloaded. */
export const THUMBNAIL_TIER_ORDER: readonly ThumbnailTier[] = ['720p', '1080p', '480p', '2160p']

export function pickThumbnailSource(input: ThumbnailSourceInput): ThumbnailSource {
  if (input.localOriginal) return { kind: 'original', reason: 'local' }
  for (const tier of THUMBNAIL_TIER_ORDER) {
    const path = input.tiers[tier]
    if (typeof path === 'string' && path.trim() !== '') {
      return { kind: 'tier', tier, path }
    }
  }
  return { kind: 'original', reason: 'no-tiers' }
}
