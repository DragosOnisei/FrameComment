'use client'

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from '@/lib/token-store'

interface User {
  id: string
  email: string
  name: string | null
  // 2.5.1+: inline data: URL for the profile avatar (null when the
  // user hasn't uploaded one yet — UI falls back to initials).
  avatarUrl?: string | null
  role: string
}

interface AuthContextType {
  user: User | null
  loading: boolean
  login: () => void
  logout: () => Promise<void>
  isAuthenticated: boolean
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: () => {},
  logout: async () => {},
  isAuthenticated: false,
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

  const refreshWithToken = useCallback(async (refreshToken: string) => {
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
      clearTokens()
      return false
    }
  }, [])

  const bootstrap = useCallback(async () => {
    setLoading(true)
    const refreshToken = getRefreshToken()
    const hasAccess = getAccessToken()

    if (!hasAccess && refreshToken) {
      await refreshWithToken(refreshToken)
    }

    await checkAuth()
  }, [checkAuth, refreshWithToken])

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
      router.push(`/login?returnUrl=${encodeURIComponent(pathname || '/')}`)
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
      const refreshToken = getRefreshToken()
      const accessToken = getAccessToken()

      await fetch('/api/auth/logout', { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(refreshToken ? { 'X-Refresh-Token': `Bearer ${refreshToken}` } : {}),
        },
        body: JSON.stringify({ refreshToken }),
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
    router.push(`/login?returnUrl=${encodeURIComponent(pathname || '/')}`)
  }

  // SECURITY: Show loading state while checking auth OR when unauthenticated (before redirect)
  // This prevents content flash - NO content should render until auth is confirmed
  if (requireAuth && (loading || !user)) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
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
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
