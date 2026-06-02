import { clearTokens, getAccessToken, getRefreshToken, setTokens } from './token-store'
import { logError } from './logging'

let isRedirecting = false
let refreshInFlight: Promise<boolean> | null = null

/**
 * 2.2.0+: transparent 429 backoff caps.
 *
 * Admin stress-tested by clicking rapidly into folders and back out
 * 8 times in a row. Each navigation mounts a fresh page → fires a
 * fresh `/api/projects/[id]` (or `/api/folders/[id]`). The per-IP +
 * session rate limiter (60 req/min for project reads, similar for
 * folders) starts returning 429 around request #6-8. Before this,
 * the page's catch path swallowed the throw, the finally set
 * loading=false, and the user saw a "Project not found" card —
 * which only cleared after 60s when the rate-limit window slid past.
 *
 * Now `apiFetch` transparently re-tries on 429 up to MAX_429_RETRIES
 * times. Each retry waits the larger of:
 *   - Retry-After header (server's hint, in seconds; the
 *     `lib/rate-limit.ts` middleware sets this), capped at 5s
 *   - Exponential backoff (1s, 2s, 4s) capped at 5s
 *
 * By the time even one retry succeeds the user has usually already
 * landed on the destination page; the staler-fetch guards in the
 * page components drop the result if it's no longer relevant.
 *
 * 3 retries × 5s max = ~15s total worst-case wait. That's well below
 * the 60s rate-limit window, so we never give up before the limit
 * resets. If the server is genuinely overloaded the request fails
 * cleanly with a real 429 the caller can render — no more silent
 * "Project not found" mis-attribution.
 */
const MAX_429_RETRIES = 3

function delayBeforeRetry(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSec = parseInt(retryAfterHeader || '', 10)
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, 5000)
  }
  // 1s, 2s, 4s — capped at 5s per attempt.
  return Math.min(1000 * Math.pow(2, attempt), 5000)
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const requestInit = withAuthHeader(init)

  try {
    let response = await fetch(input, requestInit)

    // Reset redirect flag on successful responses so future 401s are handled
    if (response.ok) {
      isRedirecting = false
    }

    if (response.status === 401) {
      const refreshed = await attemptRefresh()
      if (refreshed) {
        const retryResponse = await fetch(input, withAuthHeader(init))
        if (retryResponse.status !== 401) {
          return retryResponse
        }
      }

      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const isSharePage = typeof window !== 'undefined' && window.location.pathname.startsWith('/share/')
      const isAuthEndpoint = url.includes('/api/auth')
      if (!isSharePage && !isAuthEndpoint && !isRedirecting) {
        handleSessionExpired()
      }
    }

    // 2.2.0+: 429 transparent retry — see the comment block above
    // MAX_429_RETRIES for the full rationale.
    let attempt429 = 0
    while (response.status === 429 && attempt429 < MAX_429_RETRIES) {
      const delayMs = delayBeforeRetry(attempt429, response.headers.get('Retry-After'))
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      attempt429++
      response = await fetch(input, withAuthHeader(init))
      if (response.ok) {
        isRedirecting = false
      }
    }

    return response
  } catch (error) {
    logError('[API] Request failed:', error)
    throw error
  }
}

export async function apiJson<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
  const response = await apiFetch(input, init)

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }

  return response.json()
}

export async function apiPost<T = any>(
  url: string,
  data: any,
  init?: RequestInit
): Promise<T> {
  return apiJson<T>(url, {
    ...init,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(data),
  })
}

export async function apiPatch<T = any>(
  url: string,
  data: any,
  init?: RequestInit
): Promise<T> {
  return apiJson<T>(url, {
    ...init,
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    body: JSON.stringify(data),
  })
}

export async function apiDelete<T = any>(
  url: string,
  init?: RequestInit
): Promise<T> {
  return apiJson<T>(url, {
    ...init,
    method: 'DELETE',
    headers: {
      ...init?.headers,
    },
  })
}

function withAuthHeader(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers || {})
  // Only inject the stored admin token when no Authorization header was
  // explicitly provided.  Share-page uploads pass their own bearer token;
  // overwriting it with a stale admin token would break auth.
  if (!headers.has('Authorization')) {
    const token = getAccessToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
  }
  return { ...init, headers }
}

export async function attemptRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight

  const refreshToken = getRefreshToken()
  if (!refreshToken) return false

  refreshInFlight = (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${refreshToken}`,
        },
      })

      if (!response.ok) {
        clearTokens()
        return false
      }

      const data = await response.json()
      if (data?.tokens?.accessToken && data?.tokens?.refreshToken) {
        setTokens({
          accessToken: data.tokens.accessToken,
          refreshToken: data.tokens.refreshToken,
        })
        return true
      }

      clearTokens()
      return false
    } catch (error) {
      logError('[API] Failed to refresh token:', error)
      clearTokens()
      return false
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

function handleSessionExpired() {
  if (isRedirecting) return
  isRedirecting = true

  try {
    clearTokens()
    localStorage.removeItem('framecomment_preferences')
    sessionStorage.clear()
  } catch (error) {
    // ignore
  }

  if (typeof window !== 'undefined') {
    window.location.href = '/login?sessionExpired=true'
  }
}
