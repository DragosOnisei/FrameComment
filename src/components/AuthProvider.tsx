'use client'

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'
import { captureReturnUrl } from '@/lib/post-login-redirect'
import { useRouter, usePathname } from 'next/navigation'
import { apiFetch, attemptRefresh } from '@/lib/api-client'
import { clearTokens, getAccessToken } from '@/lib/token-store'

interface User {
  id: string
  email: string
  // 6.0.2: optional alternative login handle (email works too). Carried in
  // the session so the Profile page seeds the real value.
  username?: string | null
  name: string | null
  // 2.5.1+: inline data: URL for the profile avatar (null when the
  // user hasn't uploaded one yet — UI falls back to initials).
  avatarUrl?: string | null
  role: string
  // 6.2.0: TRUE only for the founder (OWNER of the platform organization).
  // Gates the Founder area and its redirect.
  isPlatformAdmin?: boolean
  isPlatformOrg?: boolean
}

interface AuthContextType {
  user: User | null
  loading: boolean
  login: () => void
  logout: () => Promise<void>
  isAuthenticated: boolean
  /** 3.2.x: patch the in-memory user (e.g. after a profile avatar
   *  change) so it propagates everywhere immediately — sidebar chip,
   *  user list, etc. — without a full session re-fetch. */
  updateUser: (partial: Partial<User>) => void
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: () => {},
  logout: async () => {},
  isAuthenticated: false,
  updateUser: () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

interface AuthProviderProps {
  children: ReactNode
  requireAuth?: boolean
}

export function AuthProvider({ children, requireAuth = false }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const pathname = usePathname()

  const checkAuth = useCallback(async () => {
    try {
      const response = await apiFetch('/api/auth/session')
      if (response.ok) {
        const data = await response.json()
        if (data.authenticated && data.user) {
          setUser(data.user)
          // 1.7.0+: persist the user id in localStorage so per-
          // user UI preferences (folder grid/table view, etc.)
          // can be read SYNCHRONOUSLY by lazy `useState` inits on
          // the very first render — without this they'd flash the
          // default while waiting for the auth fetch to resolve.
          try {
            if (typeof window !== 'undefined' && data.user?.id) {
              window.localStorage.setItem('last_admin_user_id', data.user.id)
            }
          } catch {
            /* localStorage disabled — fall through */
          }
          return
        }
      }
      setUser(null)
    } catch (error) {
      setUser(null)
    } finally{
      setLoading(false)
    }
  }, [])

  const bootstrap = useCallback(async () => {
    setLoading(true)
    // Only mint a fresh access token when we don't already have one in
    // memory. `attemptRefresh()` is the SHARED, de-duplicated refresh
    // (the very same in-flight lock `apiFetch` uses on a 401), so a
    // bootstrap refresh can never race a concurrent apiFetch refresh.
    // That race used to send the SAME refresh token twice; the server
    // rotates + reuse-detects refresh tokens, so the second (stale)
    // one tripped "token reuse → revoke ALL user tokens", nuking the
    // session and producing the /api/auth/refresh + /session 401 storm.
    if (!getAccessToken()) {
      await attemptRefresh()
    }
    await checkAuth()
  }, [checkAuth])

  useEffect(() => {
    // 2.5.0+: bootstrap once on mount, NOT on every pathname change.
    // The previous `[bootstrap, pathname]` dep array re-flipped
    // `loading` to true on every internal navigation, which made the
    // full-screen `Loading…` gate (below) flash between every page.
    // Session tokens are validated on every `apiFetch` request via
    // the access-token header, so we don't need to re-verify the
    // session on the client just because the URL changed.
    bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (requireAuth && !loading && !user) {
      // 7.5.0: full location (path + query + hash), same as login() below —
      // the ?video=… of a deep link is the part worth coming back to.
      {
        const returnUrl = captureReturnUrl()
        router.push(returnUrl ? `/login?returnUrl=${encodeURIComponent(returnUrl)}` : '/login')
      }
    }
  }, [requireAuth, loading, user, pathname, router])

  /**
   * Secure Logout Function
   * 
   * Client-side logout procedure:
   * 1. Call POST /api/auth/logout with credentials
   * 2. Clear local application state immediately
   * 3. Clear any localStorage/sessionStorage (if used)
   * 4. Perform hard redirect to clear all cached state
   * 5. Handle errors gracefully (still logout locally)
   * 
   * Security considerations:
   */
  async function logout() {
    try {
      const accessToken = getAccessToken()

      // 6.13.0: the refresh token rides along as an HttpOnly cookie, so there
      // is nothing to put in the body — the server reads it and clears it.
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({}),
      })
    } catch (error) {
      // Continue with local logout even if API call fails
    }

    // Step 2: Clear local application state immediately
    // Don't wait for server response - fail secure
    setUser(null)

    // Step 3: Clear any client-side storage (defense in depth)
    try {
      clearTokens()
      localStorage.removeItem('framecomment_preferences')
      sessionStorage.clear()
    } catch (storageError) {
      // Storage might not be available in some contexts - silent fail
    }

    // Step 4: Hard redirect to login page
    // Using window.location.href instead of router.push because:
    // - Forces full page reload (clears all React state)
    // - Clears any cached authenticated pages
    // - Triggers middleware check immediately
    // - More reliable than soft navigation
    window.location.href = '/login'
  }

  function login() {
    // 7.5.0: capture the FULL location (path + query + hash), not just the
    // pathname — a deep link's ?video=… is the part worth coming back to.
    const returnUrl = captureReturnUrl()
    router.push(returnUrl ? `/login?returnUrl=${encodeURIComponent(returnUrl)}` : '/login')
  }

  // SECURITY: Show loading state while checking auth OR when unauthenticated (before redirect)
  // This prevents content flash - NO content should render until auth is confirmed.
  //
  // 3.2.0+: Frosted-glass card on spotlight background with a subtle
  // spinning ring. Visually matches the share page's `if (!project)`
  // and "Loading video…" cards exactly, so on routes where Auth
  // wraps Share (admin previewing a share link), the transition
  // Auth → Share renders as ONE continuous loading screen instead of
  // the old "flat black + Loading…" flash → "tiny dark Loading
  // video…" card flash.
  // 3.2.x: shallow-merge a partial into the cached user so avatar /
  // name changes made on the Profile page show up instantly across the
  // app (sidebar, user list) without waiting for a session re-fetch.
  const updateUser = (partial: Partial<User>) =>
    setUser((prev) => (prev ? { ...prev, ...partial } : prev))

  if (requireAuth && (loading || !user)) {
    return (
      <div
        className="spotlight-bg-tr flex-1 min-h-0 h-screen lg:fixed lg:inset-0 flex items-center justify-center p-4"
        style={{ height: '100dvh' }}
      >
        <div
          className="rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white px-8 py-7 flex items-center gap-4"
          style={{
            backgroundColor: 'rgba(22, 37, 51, 0.62)',
            backgroundImage:
              'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            transform: 'translate3d(0, 0, 0)',
            willChange: 'backdrop-filter, transform',
            isolation: 'isolate',
          }}
        >
          <div className="h-5 w-5 rounded-full border-2 border-white/20 border-t-white/85 animate-spin" />
          <p className="text-sm font-medium text-white/85">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout,
        isAuthenticated: !!user,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
