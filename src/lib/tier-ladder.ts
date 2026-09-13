/**
 * 7.9.0: the quality ladder, as a pure function.
 *
 * `computeProgressiveTiers` in the worker decided which tiers a source gets
 * (480p always, then up to the project cap, gated by the source's short
 * side with a 10% tolerance for cinematic crops). That decision is made
 * only when `prepare-video` runs — which left the processing banner blind
 * for every video still waiting in the queue: no ladder, so zero tiers in
 * the total, so "2 / 8" for four uploads became "4 / 12" as the worker
 * reached each one. The logic now lives here, with no ffmpeg or database
 * behind it, so the status API can name the ladder from the first second
 * — from the dimensions the browser read before uploading, or from the cap
 * when it could not. The worker keeps calling the same function, so what
 * the banner predicts is what the worker will do.
 */

export type QualityTier = '480p' | '720p' | '1080p' | '2160p'

export const TIER_LADDER: readonly QualityTier[] = ['480p', '720p', '1080p', '2160p']

/**
 * Tiers for a source whose SHORT side is `shortSide` pixels, under the
 * project's `previewResolution` ("auto" | "720p" | "1080p" | "2160p").
 * Identical to the pre-7.9.0 worker logic, tier for tier.
 */
export function planTierSlugs(shortSide: number, maxResolution: string): QualityTier[] {
  // Cinematic / cropped sources (1920×1008 letterbox, 1920×800 ultrawide)
  // are not downgraded for missing a tier's height by a few pixels.
  const meetsTier = (tierHeight: number) => shortSide >= tierHeight * 0.9

  // "auto" means "climb to whatever the input actually is".
  let effectiveMax = maxResolution
  if (effectiveMax === 'auto') {
    if (meetsTier(2160)) effectiveMax = '2160p'
    else if (meetsTier(1080)) effectiveMax = '1080p'
    else effectiveMax = '720p' // floor — still a 720p tier above 480p for sub-720p sources
  }

  // Always 480p first — the fastest path to a playable preview.
  const tiers: QualityTier[] = ['480p']
  const wants720 = effectiveMax === '720p' || effectiveMax === '1080p' || effectiveMax === '2160p'
  if (wants720 && meetsTier(720)) tiers.push('720p')
  const wants1080 = effectiveMax === '1080p' || effectiveMax === '2160p'
  if (wants1080 && meetsTier(1080)) tiers.push('1080p')
  if (effectiveMax === '2160p' && meetsTier(2160)) tiers.push('2160p')
  return tiers
}

/**
 * The ladder for a video the worker has not looked at yet.
 *
 * With dimensions (the browser probes the file before uploading since 7.9.0,
 * `/api/videos` stores them) this is exactly what `prepare-video` will decide.
 * Without them, assume a source tall enough for the cap; under "auto" assume
 * a 1080p master, the common case — the worker corrects the total the
 * moment it probes the file, which is a far smaller jump than from zero.
 */
export function predictTierSlugs(
  width: number | null | undefined,
  height: number | null | undefined,
  maxResolution: string,
): QualityTier[] {
  const w = width ?? 0
  const h = height ?? 0
  if (w > 0 && h > 0) return planTierSlugs(Math.min(w, h), maxResolution)
  const assumedShortSide =
    maxResolution === '2160p' ? 2160 : maxResolution === '720p' ? 720 : 1080
  return planTierSlugs(assumedShortSide, maxResolution)
}
