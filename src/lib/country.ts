/**
 * 6.24.0 — country codes to something a person can read.
 *
 * Separate from `geoip.ts` on purpose: that module pulls in the MaxMind reader
 * and touches the filesystem, so a client component importing it would drag a
 * database library into the browser bundle. These two functions are pure string
 * work and are needed on both sides — the server writes flags into log rows, the
 * founder page renders them with a tooltip.
 */

/**
 * The flag emoji for an ISO-3166 alpha-2 code.
 *
 * Regional indicator symbols: two letters mapped into U+1F1E6..U+1F1FF, which
 * fonts render as a flag when they sit together. A white flag stands for
 * "unknown", never for a specific country — a wrong flag on a security page is
 * worse than an honest blank.
 */
export function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '🏳️'
  const upper = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return '🏳️'
  return String.fromCodePoint(...[...upper].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)))
}

/**
 * The English name for an ISO-3166 alpha-2 code.
 *
 * `Intl.DisplayNames` ships with the runtime, so this needs no country table to
 * maintain and no dependency to audit — and it matters here specifically:
 * `countryName` is only ever filled in from a local MaxMind database, so an
 * install that gets its geography from Cloudflare's `CF-IPCountry` header (which
 * is a code and nothing else) has the code and no name. A tooltip built purely
 * on the stored name would be empty on exactly those installs, which is most of
 * them.
 *
 * `stored` wins when present: it came from the database that resolved the
 * address, and second-guessing it here would be inventing disagreement.
 */
export function countryNameOf(
  code: string | null | undefined,
  stored?: string | null,
): string | null {
  if (stored) return stored
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase())
    // `of()` echoes the input back when it does not recognise it, which would
    // put "ZZ" in a tooltip as though it were a place.
    return name && name.toUpperCase() !== code.toUpperCase() ? name : null
  } catch {
    return null
  }
}

/**
 * The tooltip text for a flag: "Romania", or "Unknown location".
 *
 * Falls back to the raw code only when it is a plausible one. Echoing anything
 * else back — a stray single letter, or Cloudflare's `XX` placeholder — would
 * put a string in front of the reader that looks like a country and is not.
 */
export function countryLabel(
  code: string | null | undefined,
  stored?: string | null,
): string {
  const named = countryNameOf(code, stored)
  if (named) return named
  const upper = (code || '').toUpperCase()
  return /^[A-Z]{2}$/.test(upper) && upper !== 'XX' ? upper : 'Unknown location'
}
