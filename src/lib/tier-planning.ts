/**
 * 2.2.4+ tier-planning helpers — extracted from
 * `worker/video-processor-helpers.ts::computeProgressiveTiers` so
 * we can call it from API routes (which mustn't import the worker
 * file because that pulls in ffmpeg + storage + every other
 * worker-side dep).
 *
 * Pure inputs:
 *   - sourceWidth / sourceHeight from the DB row (populated at
 *     upload time by the metadata probe; populated again at
 *     prepare-video time as a refresh).
 *   - previewResolution from the parent project ('auto' | '720p'
 *     | '1080p' | '2160p').
 *
 * Output: ordered tier ladder ['480p', '720p', ...]. ALWAYS
 * includes 480p (it's the fast first-playable tier the entire
 * pipeline is built around). Always returns a strictly-ascending
 * sequence of canonical tier slugs.
 *
 * Mirrors the worker logic 1:1 — including the 90% tolerance
 * for cinematic crops and the "auto floor at 720p" rule for
 * sub-720p sources. Any change to the tier ladder MUST be made
 * here AND in computeProgressiveTiers, or the smart-reprocess
 * endpoint will end up enqueueing tiers the worker won't accept
 * (or worse, fewer tiers than the worker would have produced on
 * a fresh upload).
 */

export type TierSlug = '480p' | '720p' | '1080p' | '2160p'

/**
 * Compute the ordered tier ladder a video SHOULD have if it were
 * re-encoded today, given its source dimensions and the project's
 * previewResolution cap. Returns [] when the inputs are clearly
 * bogus (zero dimensions) — the caller should fall back to a full
 * prepare-video in that case.
 */
export function computeExpectedTiers(
  sourceWidth: number,
  sourceHeight: number,
  previewResolution: string,
): TierSlug[] {
  if (sourceWidth <= 0 || sourceHeight <= 0) return []

  const shortSide = Math.min(sourceWidth, sourceHeight)
  // 1.9.4+ Phase A: 90% tolerance lets a 1920×1008 cinematic
  // master still count as "1080p". See computeProgressiveTiers
  // for the full justification.
  const meetsTier = (tierHeight: number) => shortSide >= tierHeight * 0.9

  let effectiveMax = previewResolution
  if (effectiveMax === 'auto') {
    if (meetsTier(2160)) effectiveMax = '2160p'
    else if (meetsTier(1080)) effectiveMax = '1080p'
    else if (meetsTier(720)) effectiveMax = '720p'
    else effectiveMax = '720p'
  }

  const tiers: TierSlug[] = ['480p']

  const wants720 =
    effectiveMax === '720p' || effectiveMax === '1080p' || effectiveMax === '2160p'
  if (wants720 && meetsTier(720)) tiers.push('720p')

  const wants1080 = effectiveMax === '1080p' || effectiveMax === '2160p'
  if (wants1080 && meetsTier(1080)) tiers.push('1080p')

  const wants2160 = effectiveMax === '2160p'
  if (wants2160 && meetsTier(2160)) tiers.push('2160p')

  return tiers
}

/**
 * Best-effort detection of which tiers a video has already
 * encoded. Looks at BOTH `completedTiers` (2.2.0+ JSON column,
 * source of truth for new uploads) AND the legacy `preview*Path`
 * columns (present on all rows since 1.0.0). A tier is considered
 * done if EITHER says so — this prevents false-negatives on
 * pre-2.2.0 rows that have a `preview1080Path` but no
 * `completedTiers` entry.
 */
export function detectCompletedTiers(row: {
  completedTiers?: unknown
  preview480Path?: string | null
  preview720Path?: string | null
  preview1080Path?: string | null
  preview2160Path?: string | null
}): TierSlug[] {
  const jsonDone = new Set<string>(
    Array.isArray(row.completedTiers) ? (row.completedTiers as string[]) : [],
  )

  // The legacy 1.0.x schema didn't have preview480Path — it was
  // added in 1.9.4+. Older rows that never went through the new
  // pipeline have no 480p preview at all, so we don't even bother
  // checking for one here (relying on the JSON column to surface
  // their 480p tier if/when they get reprocessed).
  if (row.preview480Path) jsonDone.add('480p')
  if (row.preview720Path) jsonDone.add('720p')
  if (row.preview1080Path) jsonDone.add('1080p')
  if (row.preview2160Path) jsonDone.add('2160p')

  // Return in canonical order so callers can rely on
  // `expected.filter(t => !done.includes(t))` producing a
  // consistently-ordered missing-tier array.
  const order: TierSlug[] = ['480p', '720p', '1080p', '2160p']
  return order.filter(t => jsonDone.has(t))
}
