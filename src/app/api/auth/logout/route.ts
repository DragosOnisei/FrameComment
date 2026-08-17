import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { parseBearerToken, revokePresentedTokens } from '@/lib/auth'
import { clearRefreshCookie, readRefreshCookie } from '@/lib/auth-cookies'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'




export const dynamic = 'force-dynamic'

/**
 * Stateless logout
 *
 * Expects:
 * - Authorization: Bearer <accessToken> (optional but revoked if present)
 * - X-Refresh-Token: Bearer <refreshToken> OR JSON body { refreshToken }
 */
export async function POST(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const authMessages = messages?.auth || {}

  try {
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: authMessages.tooManyLogoutAttempts || 'Too many logout attempts. Please try again later.'
    }, 'logout')
    if (rateLimitResult) return rateLimitResult

    const accessToken = parseBearerToken(request)
    const refreshToken = await extractRefreshToken(request)

    await revokePresentedTokens({ accessToken, refreshToken })

    return clearRefreshCookie(NextResponse.json({ success: true }), request)
  } catch (error) {
    logError('Logout error:', error)
    return clearRefreshCookie(NextResponse.json({ success: true }), request)
  }
}

async function extractRefreshToken(request: NextRequest): Promise<string | null> {
  // 6.13.0: the cookie is the browser's copy. Header/body are kept for the
  // device flow and for clients that still send them.
  const cookieToken = readRefreshCookie(request)
  if (cookieToken) return cookieToken

  let token = request.headers.get('x-refresh-token')
  if (token?.toLowerCase().startsWith('bearer ')) {
    token = token.slice(7)
  }
  if (token) return token

  try {
    const parsed = await request.json()
    return parsed?.refreshToken || null
  } catch {
    return null
  }
}
