/**
 * 6.13.0 — the browser keeps ONE credential, in memory, and nothing on disk.
 *
 * Until now the refresh token was written to `localStorage` so a PWA could
 * survive being closed. It worked, and it was the wrong trade: anything that
 * can run JavaScript on this origin can read `localStorage`, so one XSS — ours
 * or a dependency's — was a full account takeover, for as long as the refresh
 * token lived. Raising sessions to 30 days would have made that window a
 * month.
 *
 * The refresh token now lives in an HttpOnly cookie set by the server (see
 * `lib/auth-cookies.ts`). This module never sees it and cannot: that is the
 * point. The browser attaches it automatically to `/api/auth/*`, so persistence
 * across app restarts still works — cookies with a Max-Age outlive a closed
 * PWA exactly like `localStorage` did.
 *
 * What is left here is the access token, held in memory only. It dies with the
 * tab, which is fine: on the next load `attemptRefresh()` trades the cookie for
 * a fresh one.
 */

let inMemoryAccessToken: string | null = null

type TokenChangeListener = (tokens: { accessToken: string | null }) => void
const listeners = new Set<TokenChangeListener>()

/**
 * 6.13.0: one-time cleanup. Anyone upgrading has a refresh token sitting in
 * localStorage from the old scheme; it is dead weight now (the server no
 * longer accepts it from a browser) and it is exactly the thing we just
 * decided must not be there. Remove it on first load rather than leaving a
 * stale credential lying around in people's browsers indefinitely.
 */
const LEGACY_STORAGE_KEY = 'framecomment_refresh_token'
if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Private mode / storage disabled — nothing to clean up.
  }
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken
}

/**
 * `refreshToken` is accepted and ignored on purpose: the login/refresh routes
 * no longer return one, and keeping the parameter means the call sites did not
 * all have to change in the same commit as the security fix.
 */
export function setTokens(tokens: { accessToken: string; refreshToken?: string }) {
  inMemoryAccessToken = tokens.accessToken
  notifyListeners()
}

export function updateAccessToken(accessToken: string) {
  inMemoryAccessToken = accessToken
  notifyListeners()
}

export function clearTokens() {
  inMemoryAccessToken = null
  notifyListeners()
}

export function subscribe(listener: TokenChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyListeners() {
  const snapshot = { accessToken: inMemoryAccessToken }
  listeners.forEach(fn => fn(snapshot))
}
