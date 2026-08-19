import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import crypto from 'crypto'
import { parseBearerToken, refreshAdminTokens, revokePresentedTokens } from '@/lib/auth'
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '@/lib/auth-cookies'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'
import { hashDeviceSignature, hashLegacyUserAgent } from '@/lib/device-signature'
import { recordAccessAttempt } from '@/lib/access-log'

export const runtime = 'nodejs'




export const dynamic = 'force-dynamic'

/**
 * Secure Token Refresh Endpoint
 *
 * JWT Security Best Practices Implemented:
 *
 * 1. REFRESH TOKEN ROTATION
 *    - Each refresh generates NEW refresh token
 *    - Old refresh token is immediately revoked
 *    - Prevents token replay attacks
 *
 * 2. FINGERPRINT VALIDATION
 *    - Validates User-Agent consistency
 *    - Detects token theft across devices
 *    - Optional: Can add IP address validation
 *
 * 3. AUTOMATIC REVOCATION ON SUSPICIOUS ACTIVITY
 *    - If stolen token is reused, revoke ALL user tokens
 *    - Forces re-authentication everywhere
 *    - Mitigates token theft impact
 *
 * 4. SHORT-LIVED ACCESS TOKENS
 *    - Access token: 15 minutes
 *    - Refresh token: 3 days
 *    - Limits exposure window
 *
 * 5. Explicit bearer tokens only (no implicit browser credentials)
 */
export async function POST(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const authMessages = messages?.auth || {}

  try {
    // 6.13.0: the browser sends the refresh token as an HttpOnly cookie. The
    // Bearer header is still accepted for the OAuth device flow, whose client
    // is not a browser and has no cookie jar of ours.
    const presentedToken = readRefreshCookie(request) || parseBearerToken(request)
    if (!presentedToken) {
      return NextResponse.json(
        { error: authMessages.noRefreshTokenProvided || 'No refresh token provided' },
        { status: 401 }
      )
    }

    const tokenHash = hashToken(presentedToken)

    // Rate limit per refresh token hash to reduce brute-force/rotation abuse
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 8,
      message: authMessages.tooManyRefreshAttempts || 'Too many refresh attempts. Please wait a moment.',
    }, `auth-refresh:${tokenHash}`)
    if (rateLimitResult) return rateLimitResult

    const userAgent = request.headers.get('user-agent')
    const tokens = await refreshAdminTokens({
      refreshToken: presentedToken,
      fingerprintHash: hashDeviceSignature(userAgent),
      // Accepted once, for sessions minted before 6.17.0 — see the helper.
      legacyFingerprintHash: hashLegacyUserAgent(userAgent),
    })

    if (!tokens) {
      // 6.18.0: a refusal here is one of the few genuinely hostile-looking
      // signals the app produces — a token that no longer matches its device,
      // or one replayed after rotation. Worth a row on the Security page even
      // though we cannot tell from here which of the two it was; the server
      // log distinguishes them.
      void recordAccessAttempt({
        request,
        kind: 'TOKEN_REPLAY',
        succeeded: false,
        details: { stage: 'refresh-refused' },
      })
      await revokePresentedTokens({ refreshToken: presentedToken })
      // Drop the cookie too — leaving a dead token in the jar means every
      // page load retries a refresh that can never succeed.
      const refused = NextResponse.json(
        { error: authMessages.invalidOrExpiredRefreshToken || 'Invalid or expired refresh token' },
        { status: 401 },
      )
      return clearRefreshCookie(refused, request)
    }

    const response = NextResponse.json({
      success: true,
      tokens: {
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        // 6.13.0: when this session ends no matter how active it stays.
        absoluteExpiresAt: tokens.absoluteExpiresAt,
      }
    })
    return setRefreshCookie(response, request, tokens.refreshToken, tokens.refreshMaxAgeSeconds)
  } catch (error) {
    logError('[AUTH] Token refresh error:', error)
    return NextResponse.json(
      { error: authMessages.tokenRefreshFailed || 'Token refresh failed' },
      { status: 500 }
    )
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url')
}

