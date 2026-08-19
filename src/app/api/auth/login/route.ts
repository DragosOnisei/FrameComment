import { NextRequest, NextResponse } from 'next/server'
import { verifyCredentials, issueAdminTokens } from '@/lib/auth'
import { setRefreshCookie } from '@/lib/auth-cookies'
import { checkRateLimit, incrementRateLimit, clearRateLimit } from '@/lib/rate-limit'
import { validateRequest, loginSchema, safeParseBody } from '@/lib/validation'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { enqueueExternalNotification } from '@/lib/external-notifications/enqueueExternalNotification'
import { getAppUrl } from '@/lib/url'
import { userIsPlatformAdmin } from '@/lib/platform'
import { prisma } from '@/lib/db'
import { prismaPrivileged } from '@/lib/db'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import crypto from 'crypto'
import { hashDeviceSignature } from '@/lib/device-signature'
import { recordAccessAttempt } from '@/lib/access-log'
export const runtime = 'nodejs'




// Prevent static generation for this route
export const dynamic = 'force-dynamic'

/**
 * Secure Login Endpoint
 * 
 * POST /api/auth/login
 * 
 * Security Features:
 * 1. Rate limiting on FAILED attempts only (6 failed attempts in 15 minutes)
 * 2. Successful logins clear the rate limit counter
 * 3. Input validation using Zod schema
 * 4. Secure password verification with bcrypt
 * 5. JWT tokens with short TTL (15 min access, 7 day refresh) returned explicitly in JSON
 * 
 * Rate Limiting Strategy:
 * - Only failed login attempts increment the counter
 * - Successful login clears the counter
 * - Prevents brute force attacks without blocking legitimate users
 * - 6 attempts allows for typos while preventing automated attacks
 */
export async function POST(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const authMessages = messages?.auth || {}

  try {
    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const body = parsed.data

    // Validate input first to get the email/username
    const validation = validateRequest(loginSchema, body)
    if (!validation.success) {
      // Don't count validation errors as failed login attempts
      // This prevents attackers from triggering rate limit with invalid input
      return NextResponse.json(
        { error: validation.error, details: validation.details },
        { status: 400 }
      )
    }
    
    const { email, password } = validation.data

    // Check rate limit TIED TO THE USERNAME/EMAIL being attempted
    // This prevents brute-force attacks via browser rotation
    const rateLimitCheck = await checkRateLimit(request, 'login', email)
    if (rateLimitCheck.limited) {
      const ipAddress = getClientIpAddress(request)

      await logSecurityEvent({
        type: 'ADMIN_LOGIN_RATE_LIMIT_HIT',
        severity: 'WARNING',
        ipAddress,
        details: {
          email,
          retryAfter: rateLimitCheck.retryAfter,
        },
        wasBlocked: true,
      })

      return NextResponse.json(
        {
          error: authMessages.tooManyFailedLoginAttempts || 'Too many failed login attempts for this account. Please try again later.',
          retryAfter: rateLimitCheck.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimitCheck.retryAfter || 900)
          }
        }
      )
    }

    // Verify credentials (supports both username and email)
    const user = await verifyCredentials(email, password)

    if (!user) {
      // FAILED LOGIN: Increment rate limit counter FOR THIS SPECIFIC USERNAME/EMAIL
      // This prevents attackers from bypassing via browser rotation
      const { lockedOut } = await incrementRateLimit(request, 'login', email)

      const ipAddress = getClientIpAddress(request)
      // 6.18.0: the founder's Security page reads from AccessAttempt, not from
      // SecurityEvent — a failed login belongs to no organization, so an
      // org-scoped table cannot hold it. Not awaited: recording an attack must
      // never slow down or break the thing being attacked.
      void recordAccessAttempt({
        request,
        kind: lockedOut ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
        identifier: email,
        succeeded: false,
        details: { lockedOut },
      })
      await logSecurityEvent({
        type: 'ADMIN_PASSWORD_LOGIN_FAILED',
        severity: 'WARNING',
        ipAddress,
        details: {
          email,
        },
        wasBlocked: false,
      })

      if (lockedOut) {
        // Lockout just triggered — send SECURITY_ALERT (not ADMIN_ACCESS)
        void enqueueExternalNotification({
          eventType: 'SECURITY_ALERT',
          title: authMessages.securityAlertTitle || 'Security Alert',
          body: authMessages.adminLoginLockedOutForEmailAfterTooManyAttempts?.replace('{email}', email)
            || `Admin login locked out for ${email} after too many failed attempts`,
          notifyType: 'failure',
          pushData: {
            email,
            ip: ipAddress,
            title: authMessages.securityAlertTitle || 'Security Alert',
            body: authMessages.adminLoginLockedOutForEmailAfterTooManyAttempts?.replace('{email}', email)
              || `Admin login locked out for ${email} after too many failed attempts`,
          },
        }).catch(() => {})
      } else {
        // Normal failed attempt — send ADMIN_ACCESS warning
        void enqueueExternalNotification({
          eventType: 'ADMIN_ACCESS',
          title: authMessages.failedLoginAttemptTitle || 'Failed Login Attempt',
          body: await (async () => {
            const baseUrl = await getAppUrl(request).catch(() => '')
            const fallbackLink = baseUrl ? `${baseUrl}/login` : null
            const referer = request.headers.get('referer') || ''
            const link = (() => {
              if (!baseUrl || !referer) return fallbackLink
              try {
                const ref = new URL(referer)
                if (ref.origin !== baseUrl) return fallbackLink
                if (ref.pathname !== '/login') return fallbackLink
                const returnUrl = ref.searchParams.get('returnUrl')
                if (!returnUrl) return fallbackLink
                return `${baseUrl}/login?returnUrl=${encodeURIComponent(returnUrl)}`
              } catch {
                return fallbackLink
              }
            })()

            return [
              authMessages.someoneTriedToLogInWithEmailViaPassword?.replace('{email}', email)
                || `Someone tried to log in with ${email} via password`,
              link ? `Link: ${link}` : null,
            ]
              .filter(Boolean)
              .join('\n')
          })(),
          notifyType: 'warning',
          pushData: {
            email,
            ip: ipAddress,
            title: authMessages.failedLoginAttemptTitle || 'Failed Login Attempt',
            body: authMessages.someoneTriedToLogInWithEmailViaPassword?.replace('{email}', email)
              || `Someone tried to log in with ${email} via password`,
          },
        }).catch(() => {})
      }

      return NextResponse.json(
        { error: authMessages.invalidUsernameEmailOrPassword || 'Invalid username/email or password' },
        { status: 401 }
      )
    }

    // SECURITY ENHANCEMENT: Check if user has passkeys configured
    // If passkeys are registered, require their use instead of password
    // 5.8.1 post-flip: pre-auth check — privileged (no org context yet).
    const passkeyCount = await prismaPrivileged.passkeyCredential.count({
      where: { userId: user.id },
    })

    if (passkeyCount > 0) {
      const ipAddress = getClientIpAddress(request)
      
      await logSecurityEvent({
        type: 'ADMIN_PASSWORD_LOGIN_BLOCKED_PASSKEY_REQUIRED',
        severity: 'WARNING',
        ipAddress,
        details: {
          userId: user.id,
          email: user.email,
          passkeyCount,
        },
        wasBlocked: true,
      })

      return NextResponse.json(
        { 
          error: authMessages.passkeyRequired || 'Passkey required',
          passkeyRequired: true,
          message: authMessages.passkeyRequiredMessage || 'This account has passkey authentication enabled. Please use your passkey to sign in for enhanced security.',
        },
        { status: 403 }
      )
    }

    // SUCCESSFUL LOGIN: Clear rate limit counter for this username/email
    // User successfully authenticated, reset failed attempt counter
    await clearRateLimit(request, 'login', email)

    const fingerprint = hashDeviceSignature(request.headers.get('user-agent'))
    const tokens = await issueAdminTokens(user, fingerprint)

    const ipAddress = getClientIpAddress(request)
    // Successes matter as much as failures here: "a login from a country you
    // have never worked from" is only visible if the successes are recorded
    // too, and an investor asking "how would you know if you were breached?"
    // deserves a better answer than "we log the failures".
    void recordAccessAttempt({
      request,
      kind: 'LOGIN_SUCCESS',
      identifier: user.email,
      succeeded: true,
      details: { userId: user.id },
    })
    await logSecurityEvent({
      type: 'ADMIN_PASSWORD_LOGIN_SUCCESS',
      severity: 'INFO',
      ipAddress,
      details: {
        userId: user.id,
        email: user.email,
      },
      wasBlocked: false,
    })

    void enqueueExternalNotification({
      eventType: 'ADMIN_ACCESS',
      title: authMessages.adminLogin || 'Admin Login',
      body: authMessages.userLoggedInViaPassword?.replace('{user}', user.name || user.email)
        || `${user.name || user.email} logged in via password`,
      notifyType: 'info',
      pushData: {
        email: user.email,
        ip: ipAddress,
        title: authMessages.adminLogin || 'Admin Login',
        body: authMessages.userLoggedInViaPassword?.replace('{user}', user.name || user.email)
          || `${user.name || user.email} logged in via password`,
      },
    }).catch(() => {})

    // 6.13.0: the refresh token is NOT in this body. It goes back as an
    // HttpOnly cookie the page's JavaScript cannot read — see lib/auth-cookies.
    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        // 6.2.0: lets the login page land the founder in the Founder area
        // instead of a projects list that belongs to no company.
        isPlatformAdmin: userIsPlatformAdmin(user as any),
      },
      tokens: {
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      },
    })
    return setRefreshCookie(response, request, tokens.refreshToken, tokens.refreshMaxAgeSeconds)
  } catch (error) {
    return NextResponse.json(
      { error: authMessages.errorOccurredDuringLogin || 'An error occurred during login' },
      { status: 500 }
    )
  }
}

/**
 * Store token fingerprint in Redis for theft detection
 */
