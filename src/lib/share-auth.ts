import { getAccessToken } from '@/lib/token-store'
import { attemptRefresh } from '@/lib/api-client'

/**
 * 3.8.x: detect a logged-in admin on the PUBLIC share pages.
 *
 * Why this exists: share pages (`/share/[token]`, `/share/folder/...`)
 * intentionally do NOT mount <AuthProvider>, so the normal auth
 * bootstrap never runs there. The access token lives only in memory
 * (`token-store`), so on a fresh page load — exactly what happens when
 * an admin clicks a share link — `getAccessToken()` is null even though
 * the admin is logged in. The REFRESH token, however, persists in
 * localStorage. So if there's no access token we mint one via the shared
 * `attemptRefresh()` (the same de-duplicated refresh apiFetch uses),
 * THEN check the session.
 *
 * Everything here is fail-closed to `false` and uses manual fetch (never
 * apiFetch) so a 401 can't bounce a genuine guest to /login. A guest —
 * no refresh token at all — short-circuits to false immediately.
 */
export async function detectLoggedInAdmin(): Promise<boolean> {
  if (typeof window === 'undefined') return false

  let accessToken = getAccessToken()

  // No in-memory access token (fresh load) → mint one from the persisted
  // refresh token via the SHARED, de-duplicated refresh (`attemptRefresh`
  // — the same in-flight lock apiFetch + AuthProvider use). This is what
  // stops this call from sending the refresh token concurrently with
  // another path and tripping the server's refresh-token-reuse
  // revocation (which would revoke ALL the admin's tokens). A genuine
  // guest has no refresh token, so attemptRefresh returns false at once.
  if (!accessToken) {
    const ok = await attemptRefresh()
    if (!ok) return false
    accessToken = getAccessToken()
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
