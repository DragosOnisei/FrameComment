import { formatDateTime } from './utils'

/**
 * Who delivered a version and when — the line that sits under the filename.
 *
 * 7.1.0: lifted out of ThumbnailReel so the comparison overlay can show the
 * same line. Dragos asked for the two to be identical, and "identical" written
 * twice is the thing this codebase keeps paying for: the compare-mode bug fixed
 * in 7.0.1 was two places choosing a video's file by rules that agreed until
 * they quietly did not. One derivation, several callers.
 *
 * 1.2.0+ (original rationale): `createdAt` on Video is the row's insertion
 * time, which is when the original file was uploaded — so it answers "how long
 * passed between v1, v2 and v3", which is what a reviewer is actually asking.
 */
export interface VideoUploadMeta {
  /** Absolute date + time, or null when the row has no usable timestamp. */
  uploadedAtLabel: string | null
  /**
   * 6.3.0: who delivered this version. Reads whatever the payload happens to
   * carry — the admin player has the uploader relation, the client share view
   * does not, so on a share link this stays null and the line is date-only
   * rather than wrong.
   */
  uploaderName: string | null
  /** Compact relative tag ("Just now", "5 Minutes ago", "2 Days ago"). */
  relativeUploadedLabel: string | null
}

/**
 * Compact relative-time tag, Frame.io style — keeps the line short even when
 * the timestamp is years old.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, because this is
 * read during render: a component that reads the clock while rendering is
 * impure, and passing the moment in keeps that decision at the call site where
 * it can be seen.
 */
function relativeLabel(uploadedAt: Date, now: number): string {
  const diffMs = now - uploadedAt.getTime()
  if (diffMs < 0) return 'Just now'
  const sec = Math.floor(diffMs / 1000)
  if (sec < 45) return 'Just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} ${min === 1 ? 'Minute' : 'Minutes'} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} ${hr === 1 ? 'Hour' : 'Hours'} ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} ${day === 1 ? 'Day' : 'Days'} ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo} ${mo === 1 ? 'Month' : 'Months'} ago`
  const yr = Math.floor(day / 365)
  return `${yr} ${yr === 1 ? 'Year' : 'Years'} ago`
}

/**
 * @param video Any row carrying `createdAt` and, when available, the uploader
 *              relation. Deliberately loose: the admin payload, the tokenized
 *              share payload and the comparison overlay's `Video` rows are all
 *              different shapes of the same thing.
 * @param now   Milliseconds to measure the relative label against.
 */
export function videoUploadMeta(video: unknown, now: number): VideoUploadMeta {
  const v = video as any
  const raw = v?.createdAt
  const uploadedAt: Date | null = raw
    ? raw instanceof Date
      ? raw
      : new Date(raw)
    : null
  const usable = !!uploadedAt && !isNaN(uploadedAt.getTime())

  return {
    uploadedAtLabel: usable ? formatDateTime(uploadedAt as Date) : null,
    uploaderName:
      v?.createdBy?.name ||
      v?.createdBy?.username ||
      v?.createdBy?.email ||
      v?.uploaderName ||
      null,
    relativeUploadedLabel: usable ? relativeLabel(uploadedAt as Date, now) : null,
  }
}

/**
 * The single line the player and the comparison overlay both print:
 * "Dragos · 24-08-2026 22:54 (22 Hours ago)", degrading to just the date when
 * the payload does not name an uploader.
 */
export function formatUploadMetaLine(meta: VideoUploadMeta): string | null {
  if (!meta.uploadedAtLabel) return null
  const relative = meta.relativeUploadedLabel
    ? ` (${meta.relativeUploadedLabel})`
    : ''
  return `${meta.uploadedAtLabel}${relative}`
}
