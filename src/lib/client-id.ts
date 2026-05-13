/**
 * Per-tab client id (1.0.7+).
 *
 * Anonymous share visitors (NONE auth mode) share the same
 * server-side `editorSessionId` when they sit behind the same IP
 * address — that includes two incognito windows on the same laptop.
 * To tell them apart for things like the `Client 1` / `Client 2`
 * numbered labels and per-author edit/delete checks, we mint a small
 * UUID on first use and stash it in `sessionStorage`. The browser
 * then sends it as `X-Framecomment-Client-Id` on every comment-
 * related request, and the server uses it as the authoritative
 * session id for that browser tab.
 *
 * Why sessionStorage and not localStorage: Chrome incognito windows
 * share a single private profile's `localStorage`, so two reviewers
 * opening the same share link in two incognito windows on the same
 * laptop would end up with the same id — defeating the whole point.
 * `sessionStorage` is always scoped to a single tab, which gives us
 * one identity per tab and survives page reloads. The id resets if
 * the tab is closed, which is acceptable: the same person can post
 * fresh comments tomorrow under a new label and the agency-use case
 * (different reviewers, different browsers) still works perfectly.
 */

const STORAGE_KEY = 'framecomment.clientId'
let cached: string | null = null

function makeId(): string {
  // Avoid the `crypto.randomUUID` API in older browsers — synthesise
  // a v4-ish UUID by hand using whatever entropy is available.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    try {
      return crypto.randomUUID()
    } catch {
      // fall through
    }
  }
  const rand = (n: number) => Math.floor(Math.random() * n)
  const hex = (n: number) => rand(0x10000 << (n * 4)).toString(16)
  return `${hex(2)}${hex(2)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(2)}${hex(2)}${hex(2)}`
}

/**
 * Read (or lazily create) the client id. Always returns a non-empty
 * string in the browser; returns an empty string on the server so
 * SSR doesn't try to touch sessionStorage.
 */
export function getClientId(): string {
  if (typeof window === 'undefined') return ''
  if (cached) return cached
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY)
    if (existing && existing.length > 0) {
      cached = existing
      return existing
    }
  } catch {
    // sessionStorage may throw in strict sandboxes — fall through.
  }
  const fresh = makeId()
  try {
    window.sessionStorage.setItem(STORAGE_KEY, fresh)
  } catch {
    // ignore — we'll still return the in-memory value for this tab
  }
  cached = fresh
  return fresh
}

/**
 * Add `X-Framecomment-Client-Id` to a `HeadersInit` (mutable record
 * form). The caller still controls everything else on the headers
 * object — this just slots in the client id without overwriting.
 */
export function withClientIdHeader(
  headers: Record<string, string> = {},
): Record<string, string> {
  const id = getClientId()
  if (!id) return headers
  return { ...headers, 'X-Framecomment-Client-Id': id }
}
