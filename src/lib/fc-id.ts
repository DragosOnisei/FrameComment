/**
 * 7.19.0: the video ID, "FC<n>".
 *
 * Every VIDEO row carries `fcNumber`, assigned by Postgres at insert from a
 * per-company counter (migration `video_fc_id`): FC1 is the company's first
 * upload, FC2 the next, one per file, so every version of a stack has its
 * own. Images, audio and documents carry none (Dragos's call), nor does a
 * legacy row without a company — every helper here answers "nothing" for
 * those rather than inventing a label.
 *
 * Pure and browser-safe: the card, the table, Quick Look, the player's reel,
 * the search overlay, the download route and both ZIP routes all go through
 * these three functions, so the label, the filename prefix and what search
 * understands cannot drift apart.
 */

export const FC_ID_PREFIX = 'FC'

/** "FC453" for 453; null when the row has no number. */
export function fcIdLabel(fcNumber: number | null | undefined): string | null {
  if (typeof fcNumber !== 'number' || !Number.isInteger(fcNumber) || fcNumber < 1) return null
  return `${FC_ID_PREFIX}${fcNumber}`
}

/**
 * The downloaded file's name: "FC453_C3_VDA_Adam_Edits_MATEI_916_V4.mp4".
 * A file whose row has no number keeps its name unchanged, and a name that
 * already starts with this exact label is not prefixed twice (a file
 * downloaded, kept, and uploaded again as a new version gets its NEW number
 * in front — "FC460_FC453_…" — which is the truth about it; only the same
 * number is folded).
 */
export function fcPrefixFileName(fcNumber: number | null | undefined, fileName: string): string {
  const label = fcIdLabel(fcNumber)
  if (!label) return fileName
  if (fileName.toUpperCase().startsWith(`${label}_`)) return fileName
  return `${label}_${fileName}`
}

/**
 * What the search box means by an ID. "FC453", "fc453", "FC 453", "FC-453"
 * and a bare "453" all ask for number 453; anything else is not an ID
 * query and the caller searches names only. A bare number still searches
 * names too (a filename can contain "916"), so this only ADDS a match.
 */
export function fcNumberFromQuery(query: string): number | null {
  const m = query.trim().match(/^(?:fc[\s_-]?)?(\d{1,9})$/i)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 ? n : null
}
