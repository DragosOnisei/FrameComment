import {
  getAccessToken,
  getRefreshToken,
  setTokens,
} from '@/lib/token-store'

/**
 * 3.8.x: detect a logged-in admin on the PUBLIC share pages.
 *
 * Why this exists: share pages (`/share/[token]`, `/share/folder/...`)
 * intentionally do NOT mount <AuthProvider>, so the normal auth
 * bootstrap never runs there. The access token lives only in memory
 * (`token-store`), so on a fresh page load — exactly what happens when
 * an admin clicks a share link — `getAccessToken()` is null even though
 * the admin is logged in. The REFRESH token, however, persists in
 * localStorage. So we mirror AuthProvider.refreshWithToken: if there's
 * no access token but there is a refresh token, mint a fresh access
 * token first, THEN check the session.
 *
 * Everything here is fail-closed to `false` and uses manual fetch (never
 * apiFetch) so a 401 can't bounce a genuine guest to /login. A guest —
 * no refresh token at all — short-circuits to false immediately.
 */
export async function detectLoggedInAdmin(): Promise<boolean> {
  if (typeof window === 'undefined') return false

  let accessToken = getAccessToken()

  // No in-memory access token (fresh load) → try to mint one from the
  // persisted refresh token, same flow the AuthProvider uses.
  if (!accessToken) {
    const refreshToken = getRefreshToken()
    if (!refreshToken) return false // genuine guest
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${refreshToken}` },
      })
      if (!res.ok) return false
      const data = await res.json().catch(() => null)
      if (data?.tokens?.accessToken && data?.tokens?.refreshToken) {
        setTokens({
          accessToken: data.tokens.accessToken,
          refreshToken: data.tokens.refreshToken,
        })
        accessToken = data.tokens.accessToken as string
      } else {
        return false
      }
    } catch {
      return false
    }
  }

  if (!accessToken) return false

  try {
    const res = await fetch('/api/auth/session', {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => null)
    return !!body?.authenticated
  } catch {
    return false
  }
}
