/**
 * 6.17.0 — the device signature a refresh token is bound to.
 *
 * This lives in one file for a reason that is not tidiness. Four routes mint or
 * check this value — login, register, invite-accept and refresh — and each had
 * its own private copy of the hash. They agreed only by coincidence, and the
 * failure mode when they stop agreeing is silent and total: login stores one
 * value, refresh computes another, the mismatch is read as theft, and the
 * user's entire session family is revoked on their first refresh. One
 * definition, imported everywhere, makes that divergence impossible.
 *
 * WHY IT IS COARSE
 *
 * 6.13.0 hashed the raw User-Agent. That string carries the browser's version
 * number, and browsers update themselves silently — the new build takes effect
 * on relaunch, which is exactly what happens when someone closes a laptop at
 * night and opens it in the morning. Their signature changed overnight through
 * no action of their own, the refresh was read as "this token is being used
 * from a different device", and every session died. A routine Chrome update
 * was indistinguishable from a stolen token, and the response to theft is
 * maximal by design.
 *
 * So the signature is now what actually identifies the machine — browser
 * family and operating system — with every version number stripped. A token
 * used from a different browser or a different OS still fails, which is the
 * case the check exists for. A token used from the same browser one point
 * release later does not, which was never a threat.
 *
 * Coarser on purpose. Device binding is the fourth line of defence, behind
 * token rotation, replay detection and the absolute 30-day session cap. It is
 * not worth locking people out of their own account to tighten a backstop.
 */

import crypto from 'crypto'

/** Browser family + OS, e.g. `chrome:macos`. No version numbers, ever. */
export function deviceSignature(userAgent: string): string {
  const ua = (userAgent || 'unknown').toLowerCase()

  // Order matters. Edge and Opera both claim to be Chrome, and Chrome claims
  // to be Safari — check the most specific marker first or everything
  // collapses into one bucket.
  const browser =
    ua.includes('edg/') ? 'edge'
    : ua.includes('opr/') || ua.includes('opera') ? 'opera'
    : ua.includes('firefox/') ? 'firefox'
    : ua.includes('chrome/') || ua.includes('chromium/') ? 'chrome'
    : ua.includes('safari/') ? 'safari'
    : 'other'

  const platform =
    ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod') ? 'ios'
    : ua.includes('android') ? 'android'
    : ua.includes('mac os x') || ua.includes('macintosh') ? 'macos'
    : ua.includes('windows') ? 'windows'
    : ua.includes('cros') ? 'chromeos'
    : ua.includes('linux') ? 'linux'
    : 'other'

  return `${browser}:${platform}`
}

/** What gets stored and compared. Hashed so a Redis dump holds no UA strings. */
export function hashDeviceSignature(userAgent: string | null | undefined): string {
  return crypto
    .createHash('sha256')
    .update(deviceSignature(userAgent || 'unknown'))
    .digest('base64url')
}

/**
 * The pre-6.17.0 fingerprint: a hash of the raw User-Agent.
 *
 * Kept only so a session created before this release survives the upgrade. On
 * the first refresh after deploying, every stored fingerprint is still the old
 * raw-UA hash and would mismatch the new coarse one — logging out every signed-
 * in user at once, which is precisely the failure this release exists to stop.
 * We accept the legacy value when it matches the same device, and the rotation
 * immediately stores the new form, so each session upgrades itself once and
 * this path stops being used.
 */
export function hashLegacyUserAgent(userAgent: string | null | undefined): string {
  return crypto
    .createHash('sha256')
    .update(userAgent || 'unknown')
    .digest('base64url')
}
