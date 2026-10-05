/**
 * 7.18.0: which rows keep the project / folder page polling.
 *
 * Both pages poll their data every few seconds while "something is still
 * being worked on", so a card lights up with its thumbnail or storyboard
 * without a manual refresh. The rule used to be written twice, inline, and
 * it only knew the worker's pipeline: UPLOADING / PROCESSING, or a READY
 * row whose tier ladder is unfinished.
 *
 * A DOCUMENT is marked READY by the upload route and gets its cover (top
 * of page one) from a worker job a second or two later — after the
 * upload-complete refresh has already happened. Without this rule the card
 * showed the kind's glyph until the next navigation. So a READY document
 * without a cover counts as still settling — but only for
 * `DOCUMENT_COVER_SETTLE_MS` after it was created: a render that failed
 * (worker down, a corrupt PDF) must not keep every visitor of that folder
 * polling at 4 s forever. The decision is pure so a script exercises it.
 */

export const DOCUMENT_COVER_SETTLE_MS = 2 * 60 * 1000

export interface LiveRefreshRow {
  status?: string | null
  mediaType?: string | null
  plannedTiers?: unknown
  completedTiers?: unknown
  thumbnailPath?: string | null
  thumbnailUrl?: string | null
  createdAt?: string | Date | null
}

export function isStillSettling(row: LiveRefreshRow, now: number = Date.now()): boolean {
  if (row.status === 'UPLOADING' || row.status === 'PROCESSING') return true
  // 3.5.x: status flips to READY at the first (SD) tier while the HD tiers
  // and the storyboard sprite are still being produced.
  const planned = Array.isArray(row.plannedTiers) ? row.plannedTiers : []
  const completed = Array.isArray(row.completedTiers) ? row.completedTiers : []
  if (planned.length > 0 && completed.length < planned.length) return true
  if (row.mediaType === 'DOCUMENT' && !row.thumbnailPath && !row.thumbnailUrl) {
    const created = row.createdAt ? new Date(row.createdAt).getTime() : NaN
    if (Number.isFinite(created) && now - created < DOCUMENT_COVER_SETTLE_MS) return true
  }
  return false
}

export function anyStillSettling(rows: readonly LiveRefreshRow[] | null | undefined, now?: number): boolean {
  return Array.isArray(rows) && rows.some((row) => isStillSettling(row, now))
}
