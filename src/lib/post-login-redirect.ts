/**
 * 7.5.0: come back to the link you were opening.
 *
 * An expired token — or the logout-everyone that a deploy can trigger —
 * used to bounce you to /login and, after signing back in, drop you on the
 * default projects page. The deep link you were actually opening (a video,
 * with its ?video=… and timestamp) was gone. The login page has understood
 * `?returnUrl=` for a long time; what was missing is that the FORCED
 * bounce (api-client's handleSessionExpired) never attached one, and the
 * soft bounce attached only the pathname, dropping query and hash.
 *
 * One module owns all three jobs — capturing the current location,
 * building the login URL, and validating the parameter on the way back —
 * because a second definition of "what is a safe return path" is how open
 * redirects are born. Browser-safe, pure except for reading
 * window.location at capture time.
 */

/** Where a round-trip through login should NOT return to: the auth pages
 *  themselves (looping), the marketing root, and the share/invite flows,
 *  which have their own authentication and never bounce here. */
const NEVER_RETURN_PREFIXES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/share',
]

/**
 * True when `path` is a same-app path we are willing to redirect to after
 * login. Rejects anything that could leave the origin: absolute URLs,
 * scheme-relative `//host`, and `/\host` — browsers normalize backslashes
 * to slashes in URLs, so `/\evil.com` becomes `//evil.com` after parsing,
 * which is exactly the hole a plain startsWith('/')-and-not-'//' check
 * leaves open. Also rejects the auth pages themselves (a returnUrl of
 * /login would loop) and anything absurdly long.
 */
export function isSafeReturnPath(path: string | null | undefined): path is string {
  if (!path || typeof path !== 'string') return false
  if (path.length > 2000) return false
  if (!/^\/(?![/\\])/.test(path)) return false
  const lower = path.toLowerCase()
  return !NEVER_RETURN_PREFIXES.some(
    (p) => lower === p || lower.startsWith(`${p}/`) || lower.startsWith(`${p}?`),
  )
}

/** The current location as a returnUrl candidate — path + query + hash —
 *  or null when there is nothing worth returning to (already on an auth
 *  page, on the marketing root, or not in a browser). */
export function captureReturnUrl(): string | null {
  if (typeof window === 'undefined') return null
  const { pathname, search, hash } = window.location
  if (pathname === '/') return null
  const full = `${pathname}${search}${hash}`
  return isSafeReturnPath(full) ? full : null
}

/** The login URL a forced session-expiry bounce should land on, carrying
 *  the interrupted location when there is one. */
export function loginUrlForExpiredSession(): string {
  const returnUrl = captureReturnUrl()
  return returnUrl
    ? `/login?sessionExpired=true&returnUrl=${encodeURIComponent(returnUrl)}`
    : '/login?sessionExpired=true'
}
