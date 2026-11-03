/**
 * 7.19.0: the "FC<n>" label. 7.20.0: it names a Meta AD — the folder's
 * `metaNumber`, given by right-click → Generate Meta ID and carried by
 * every video under that folder (src/lib/meta-id.ts resolves it). It
 * started as a per-file number; that was retired the same week.
 *
 * Pure and browser-safe: the card, the table, Quick Look, the player's reel,
 * the search overlay, the download route and every ZIP route go through
 * these three functions, so the label, the filename prefix and what search
 * understands cannot drift apart.
 */

export const FC_ID_PREFIX = 'FC'

/** "FC12" for 12 (an ad folder's label); null when there is no Meta ID. */
export function fcIdLabel(fcNumber: number | null | undefined): string | null {
  if (typeof fcNumber !== 'number' || !Number.isInteger(fcNumber) || fcNumber < 1) return null
  return `${FC_ID_PREFIX}${fcNumber}`
}

/**
 * A code at the very start of a file name: "FC7676_" (7.19.0's per-file
 * IDs, which live downloads put on real files before they were retired),
 * "FC3_", "FC3E1V2_". Editors re-upload what they downloaded, so names
 * arrive carrying one — a different one on the 9:16 and the 4:5 of the
 * same edit.
 */
const LEADING_CODE = /^FC\d+(?:E\d+)?(?:V\d+)?_/i

/**
 * The downloaded file's name: "FC2E1V1_C1_Hypnotic-B-Roll-Fridge_Julie_Matei_916_V6.mp4".
 * A code already at the front is REPLACED, never stacked: a file
 * downloaded, kept and uploaded again carries only its current code
 * ("FC3E1V1_FC7676_VDA_…" was what 7.20.0's first cut produced). A file
 * with no code keeps its name exactly as uploaded.
 */
export function fcPrefixFileName(code: string | null | undefined, fileName: string): string {
  if (!code) return fileName
  return `${code}_${fileName.replace(LEADING_CODE, '')}`
}

/** 7.20.0: a video's full code — "FC2E1V1" (ad 2, edit 1, version 1). */
export function fcVideoCode(metaNumber: number, editNumber: number, version: number): string {
  return `${FC_ID_PREFIX}${metaNumber}E${editNumber}V${version}`
}

// The aspect ratios an export appends: 916, 9x16, 9:16, 9-16, 9_16, 45, 4x5,
// 11, 1x1, 169, 16x9, and the rarer 23 / 32 / 43 / 219. A whitelist, not
// "any digits": "C1", "H2", "EP03" and a year in a name must survive.
const RATIO_SEGMENT = /^(?:9[x:×-]?16|4[x:×-]?5|1[x:×-]?1|16[x:×-]?9|2[x:×-]?3|3[x:×-]?2|4[x:×-]?3|21[x:×-]?9)$/i
const RATIO_UNDERSCORED = /(^|_)(9_16|4_5|1_1|16_9|2_3|3_2|4_3|21_9)(?=_|$)/gi

/**
 * 7.20.0: which EDIT a card is, inside its ad folder. The 9:16, 4:5 and 1:1
 * exports of one edit carry the same name up to the ratio (Dragos: "only
 * the aspect ratio at the end changes"), so the key is the name UP TO its
 * last ratio part — what follows it is the export's tail and is allowed to
 * differ: the version ("_V7"), a date ("_Septembrie 2025" was on the 1:1
 * and the 4:5 of Olivia's H2 and not on its 9:16, which split one edit
 * into two E's). Also dropped: a leading FC code (7.19.0's "FC7676_"
 * differs on every re-uploaded file), the extension, a " (2)" duplicate
 * suffix and any version part before the ratio. Lower-cased. Equal keys
 * under one ad = one E. A name with no recognisable ratio part keeps all
 * of it except versions; a ratio glued to a word ("Matei916") is not
 * recognised, so that file gets an E of its own — never the wrong edit.
 */
export function editKeyFromName(name: string): string {
  let base = (name ?? '')
    .trim()
    .replace(LEADING_CODE, '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/\s*\(\d+\)$/, '')
  // "9_16" is two parts once split on "_"; mark it as one ratio part first.
  const MARK = '\u0000ratio'
  base = base.replace(RATIO_UNDERSCORED, (_m, pre: string) => `${pre}${MARK}`)
  let parts = base.split('_').map((p) => p.trim()).filter(Boolean)
  let lastRatio = -1
  parts.forEach((p, i) => {
    if (RATIO_SEGMENT.test(p) || p === MARK) lastRatio = i
  })
  if (lastRatio >= 0) parts = parts.slice(0, lastRatio)
  parts = parts.filter((p) => !RATIO_SEGMENT.test(p) && p !== MARK && !/^v\d+$/i.test(p))
  return parts.join('_').toLowerCase()
}

/**
 * What the search box means by a code. "FC2", "fc 2", "FC2E1", "FC2E1V2",
 * "fc2-e1-v2" and a bare "2" all ask for ad 2 (and, when given, edit 1 and
 * version 2); anything else is not a code query and the caller searches
 * names only. A bare number still searches names too (a filename can
 * contain "916"), so this only ADDS matches.
 */
export interface FcQuery {
  meta: number
  edit: number | null
  version: number | null
}

export function fcQueryFrom(query: string): FcQuery | null {
  const m = query.trim().match(/^(?:fc[\s_-]?)?(\d{1,9})(?:[\s_-]?e(\d{1,6}))?(?:[\s_-]?v(\d{1,6}))?$/i)
  if (!m) return null
  const meta = Number(m[1])
  if (meta < 1) return null
  return { meta, edit: m[2] ? Number(m[2]) : null, version: m[3] ? Number(m[3]) : null }
}
