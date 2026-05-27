/**
 * 1.6.1+: returns the origin that share / project / folder links
 * should be minted against. Setup-specific reasoning:
 *
 *  - Editors usually browse the admin UI over the LAN
 *    (http://192.168.x.x:port) so uploads bypass Cloudflare and
 *    run at full ~100 MB/s through WireGuard.
 *  - Clients live anywhere on the internet and only have the
 *    public `https://framecomment.com` URL.
 *
 * If we minted share links from `window.location.origin` they'd
 * point at the LAN IP, which is unreachable for clients. So we
 * prefer the operator's configured `appDomain` (from
 * `/api/settings/theme`, mirrored into localStorage so it's
 * available synchronously), and fall back to the current origin
 * only when the admin hasn't set one yet.
 *
 * The localStorage key is shared with the `BrandLogo` hydration
 * code, so the public-share-origin shows up on the first share
 * action of a session if the admin opened the dashboard recently.
 */

const STORAGE_KEY = 'publicShareOrigin'

let cached: string | null = null

/** Strip a trailing slash so we can `${origin}/share/...` cleanly. */
function normalise(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Synchronous accessor — returns the cached or stored value, with
 * `window.location.origin` as the last-resort fallback. Safe on
 * server (returns '' when window is undefined) but should only be
 * called from client code that mints links.
 */
export function getPublicShareOrigin(): string {
  if (typeof window === 'undefined') return ''
  if (cached) return cached
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && stored.trim()) {
      cached = normalise(stored.trim())
      return cached
    }
  } catch {
    /* localStorage can throw in private-browsing — ignore. */
  }
  return window.location.origin
}

/**
 * Updates the cache + localStorage. Pass `null` to clear (e.g. when
 * the admin removes the appDomain setting and we should fall back
 * to `window.location.origin` again).
 */
export function setPublicShareOrigin(value: string | null): void {
  if (typeof window === 'undefined') return
  if (value && value.trim()) {
    cached = normalise(value.trim())
    try { window.localStorage.setItem(STORAGE_KEY, cached) } catch {}
  } else {
    cached = null
    try { window.localStorage.removeItem(STORAGE_KEY) } catch {}
  }
}

/**
 * Fire-and-forget refresh from the public theme endpoint. Call this
 * once on app mount (AccentColorProvider already loads
 * `/api/settings/theme` — easiest to wire there). Safe to call
 * multiple times; subsequent calls just rewrite the same cache.
 */
export async function refreshPublicShareOriginFromTheme(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const res = await fetch('/api/settings/theme')
    if (!res.ok) return
    const data = await res.json()
    if (typeof data?.appDomain === 'string' && data.appDomain.trim()) {
      setPublicShareOrigin(data.appDomain)
    } else {
      // The admin cleared the setting — clear the cache too so we
      // fall back to `window.location.origin` immediately.
      setPublicShareOrigin(null)
    }
  } catch {
    /* network blip — keep whatever we had cached. */
  }
}
