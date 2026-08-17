/**
 * 6.13.0 — where the refresh token lives.
 *
 * It used to live in `localStorage`. That is the one place OWASP names
 * explicitly as unsafe for credentials: every script running on the origin can
 * read it, so a single XSS — in our own code or in any dependency — hands over
 * the whole session. At a 12-hour session that was a bad idea with a short
 * fuse. At 30 days it would be a bad idea with a long one.
 *
 * So the refresh token now travels in a cookie the browser will not show to
 * JavaScript:
 *
 *   HttpOnly     — `document.cookie` cannot see it; XSS cannot exfiltrate it.
 *   Secure       — HTTPS only. Skipped on plain-HTTP localhost, because a
 *                  Secure cookie is simply dropped there and nobody could log
 *                  in while developing.
 *   SameSite=Strict — never attached to a cross-site request, which is exactly
 *                  what CSRF needs to work. Strict costs nothing here: the
 *                  cookie is only ever read by same-origin fetches the app
 *                  itself makes, never by a top-level navigation. Arriving
 *                  from an email link still works — the page loads without the
 *                  cookie, and the refresh call it then makes is same-site.
 *   Path=/api/auth — it is only ever read by the refresh and logout routes, so
 *                  it is not attached to every image, video and API request.
 *                  Less exposure, and less overhead on the hot media path.
 *
 * The access token deliberately stays in memory, where it already was. That is
 * the current consensus shape: short-lived credential in memory, long-lived
 * credential in an HttpOnly cookie.
 *
 * CSRF, stated plainly: every authenticated endpoint reads a `Bearer` header,
 * never this cookie, so a cross-site form post cannot act on the user's
 * behalf — there is nothing for it to ride on. The two routes that DO read the
 * cookie are `/api/auth/refresh` and `/api/auth/logout`. Refresh returns the
 * new access token in a JSON body a cross-origin page cannot read, and logout
 * is idempotent: the worst a forged request achieves is signing you out.
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export const REFRESH_COOKIE_NAME = 'fc_admin_rt'
const REFRESH_COOKIE_PATH = '/api/auth'

/**
 * Secure cookies are dropped by browsers on plain HTTP, which would make local
 * development impossible. We relax the flag only when the request itself did
 * not arrive over TLS — never based on NODE_ENV, because a production install
 * behind a misconfigured proxy would then silently ship insecure cookies.
 */
function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  if (forwardedProto) return forwardedProto.split(',')[0].trim() === 'https'
  try {
    return new URL(request.url).protocol === 'https:'
  } catch {
    return true
  }
}

/** Read the refresh token the browser sent, if any. */
export function readRefreshCookie(request: NextRequest): string | null {
  const value = request.cookies.get(REFRESH_COOKIE_NAME)?.value
  return value && value.length > 0 ? value : null
}

/**
 * Attach a rotated refresh token. `maxAgeSeconds` should be what is left of
 * the session's ABSOLUTE window, so the cookie cannot outlive the session it
 * represents.
 */
export function setRefreshCookie(
  response: NextResponse,
  request: NextRequest,
  refreshToken: string,
  maxAgeSeconds: number,
): NextResponse {
  response.cookies.set({
    name: REFRESH_COOKIE_NAME,
    value: refreshToken,
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  })
  return response
}

/** Drop the cookie on logout, or whenever a session is refused. */
export function clearRefreshCookie(response: NextResponse, request: NextRequest): NextResponse {
  response.cookies.set({
    name: REFRESH_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: 0,
  })
  return response
}
