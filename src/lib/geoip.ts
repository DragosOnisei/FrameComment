/**
 * 6.18.0 — where an IP address is, resolved without telling anyone we asked.
 *
 * The obvious implementation is an HTTP call to ip-api or ipinfo. It is also
 * the wrong one for this product. Every lookup would ship a visitor's IP to a
 * third party — under GDPR that is a transfer of personal data to a processor
 * we would have to name in the privacy policy and sign a DPA with, for the
 * privilege of drawing a flag. It would also break every air-gapped install,
 * rate-limit under exactly the traffic spike we most want to measure (a
 * password-spraying bot), and put a network round-trip on the login path.
 *
 * So the database is local. MaxMind's GeoLite2 is a file we read from disk;
 * nothing leaves the machine. It needs a free licence key to download and a
 * monthly refresh to stay accurate, and both of those are configuration, not
 * code — see the graceful degradation below.
 *
 * DEGRADATION IS THE POINT. This is a self-hosted product; most installs will
 * never configure a GeoIP database, and a Security page that throws or hangs
 * because a file is missing would be worse than one without flags. Every
 * function here returns null rather than failing, and the UI shows the IP
 * without a flag. Geography is decoration on top of the data that matters.
 *
 * Cloudflare's `CF-IPCountry` header is consulted first when present, because
 * an install already behind Cloudflare gets accurate country data for free and
 * should not be made to download anything.
 */

import fs from 'fs'
import path from 'path'
import { logError, logMessage } from './logging'
import { countryNameOf } from './country'

export interface GeoLocation {
  /** ISO-3166 alpha-2, uppercase. */
  country: string | null
  countryName: string | null
  city: string | null
  /** Autonomous system, e.g. "AS15169 Google LLC". Null unless the ASN DB exists. */
  asn: string | null
}

const EMPTY: GeoLocation = { country: null, countryName: null, city: null, asn: null }

/**
 * Where the .mmdb files live. Overridable because the sensible location
 * differs between a Docker volume, a TrueNAS dataset and a developer's laptop.
 */
const GEOIP_DIR = process.env.GEOIP_DB_DIR || '/app/geoip'

type CityReader = { get: (ip: string) => any } | null
type AsnReader = { get: (ip: string) => any } | null

let cityReader: CityReader = null
let asnReader: AsnReader = null
let loadAttempted = false

/**
 * Private, loopback and link-local addresses have no country and never will.
 * Checking here keeps them out of the database entirely rather than storing
 * rows with a null country that look like lookup failures.
 */
export function isPrivateAddress(ip: string): boolean {
  if (!ip) return true
  const v = ip.trim().toLowerCase()
  if (v === '::1' || v === '127.0.0.1' || v === 'localhost' || v === 'unknown') return true
  if (v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.')) return true
  if (v.startsWith('172.')) {
    const second = Number.parseInt(v.split('.')[1] ?? '', 10)
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true
  }
  // Unique-local and link-local IPv6.
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true
  return false
}

/**
 * Open the databases once. Deliberately lazy and deliberately silent about a
 * missing file: "not configured" is the expected state for most installs, not
 * an error worth shouting about on every request.
 */
async function ensureReaders(): Promise<void> {
  if (loadAttempted) return
  loadAttempted = true

  const cityPath = path.join(GEOIP_DIR, 'GeoLite2-City.mmdb')
  const countryPath = path.join(GEOIP_DIR, 'GeoLite2-Country.mmdb')
  const asnPath = path.join(GEOIP_DIR, 'GeoLite2-ASN.mmdb')

  try {
    // Imported dynamically so a build that never resolves an IP does not pay
    // for the module, and so a broken install degrades to "no flags" instead
    // of failing at import time.
    const maxmind = await import('maxmind')
    const open = (maxmind as any).open ?? (maxmind as any).default?.open

    // City includes country, so prefer it; fall back to the smaller Country DB.
    const primary = fs.existsSync(cityPath) ? cityPath : fs.existsSync(countryPath) ? countryPath : null
    if (primary) {
      cityReader = await open(primary)
      logMessage(`[GEOIP] Loaded ${path.basename(primary)}`)
    }
    if (fs.existsSync(asnPath)) {
      asnReader = await open(asnPath)
      logMessage('[GEOIP] Loaded GeoLite2-ASN.mmdb')
    }
    if (!primary && !asnReader) {
      logMessage(`[GEOIP] No database in ${GEOIP_DIR} — access records will have no country. See docs/SECURITY-CENTRE.md`)
    }
  } catch (error) {
    logError('[GEOIP] Could not open the database; continuing without geography:', error)
  }
}

/** Resolve an address. Never throws; returns nulls when it cannot say. */
export async function lookupIp(ip: string): Promise<GeoLocation> {
  if (!ip || isPrivateAddress(ip)) return EMPTY
  await ensureReaders()
  if (!cityReader && !asnReader) return EMPTY

  const result: GeoLocation = { ...EMPTY }
  try {
    const city = cityReader?.get(ip)
    if (city) {
      result.country = city?.country?.iso_code || city?.registered_country?.iso_code || null
      result.countryName =
        city?.country?.names?.en || city?.registered_country?.names?.en || null
      result.city = city?.city?.names?.en || null
    }
  } catch {
    // A malformed address is not worth a log line on every bot request.
  }
  try {
    const asn = asnReader?.get(ip)
    if (asn?.autonomous_system_number) {
      const org = asn.autonomous_system_organization
      result.asn = org
        ? `AS${asn.autonomous_system_number} ${org}`
        : `AS${asn.autonomous_system_number}`
    }
  } catch {
    // Same.
  }
  return result
}

/** Is a local database actually available? Surfaced by the security scan. */
export async function geoipStatus(): Promise<{
  available: boolean
  directory: string
  city: boolean
  asn: boolean
}> {
  await ensureReaders()
  return {
    available: !!cityReader,
    directory: GEOIP_DIR,
    city: !!cityReader,
    asn: !!asnReader,
  }
}

/**
 * 6.24.0 — the geography of one request, from the best source available.
 *
 * `CF-IPCountry` beats the local database whenever it is present: Cloudflare
 * resolved the address at the edge, for free, and an install with no MaxMind
 * database has nothing else to go on — which is the common case, since the
 * database is a manual download.
 *
 * Extracted because the sign-in log had this logic inline and the share-open
 * path was about to grow a second copy. Two copies of a rule is how the mail
 * stage ended up reading a variable the app does not use.
 */
export async function resolveRequestGeo(
  ip: string,
  cfCountryHeader?: string | null,
): Promise<GeoLocation> {
  const geo = await lookupIp(ip)
  const cf = (cfCountryHeader || '').trim().toUpperCase()
  // 'XX' is Cloudflare's "I could not tell", not a country.
  const usable = cf.length === 2 && cf !== 'XX' && /^[A-Z]{2}$/.test(cf)
  const country = usable ? cf : geo.country
  return {
    ...geo,
    country,
    // The stored name comes from the local database; when the country came
    // from the header instead there is no name, so derive one rather than
    // leaving every row in the UI with a flag and no words.
    countryName: countryNameOf(country, geo.countryName),
  }
}

// Re-exported so existing importers keep working; the implementation moved to
// `country.ts`, which the browser can import without pulling in MaxMind.
export { countryFlag } from './country'
