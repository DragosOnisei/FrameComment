import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
import crypto from 'crypto'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { getMaxAuthAttempts } from '@/lib/settings'
import { getRedis } from '@/lib/redis'
import { signShareToken } from '@/lib/auth'
import { getShareTokenTtlSeconds } from '@/lib/settings'
import { trackSharePageAccess, readAnalyticsConsent } from '@/lib/share-access-tracking'
import { enqueueExternalNotification } from '@/lib/external-notifications/enqueueExternalNotification'
import { safeParseBody } from '@/lib/validation'
import jwt from 'jsonwebtoken'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'
import { lockoutDurationMs, nextConsecutiveLockouts, LOCKOUT_DECAY_MS, type LockoutEntry } from '@/lib/auth-lockout'

export const runtime = 'nodejs'




// 1.5.8: replaced the flat 15-min window with progressive backoff
// (15 min → 1h → 4h on consecutive lockouts inside 24h). The
// attempt-counting "window" is now driven by the lockout decay
// constant so consecutive-lockout tracking survives across the
// full backoff range.
const ATTEMPT_WINDOW_MS = LOCKOUT_DECAY_MS

/**
 * Constant-time string comparison to prevent timing attacks
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal, false otherwise
 */
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')

  // If lengths differ, still compare dummy buffers to maintain constant time
  if (bufA.length !== bufB.length) {
    // Compare two equal-length dummy buffers to maintain timing
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32))
    return false
  }

  return crypto.timingSafeEqual(bufA, bufB)
}

function getIdentifier(request: NextRequest, token: string): string {
  const ip = getClientIpAddress(request)
  
  const hash = crypto
    .createHash('sha256')
    .update(`${ip}:${token}`)
    .digest('hex')
    .slice(0, 16)
  
  return `ratelimit:share-verify-failed:${token}:${hash}`
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const locale = await getConfiguredLocale().catch(() => 'en')
    const messages = await loadLocaleMessages(locale).catch(() => null)
    const shareMessages = messages?.share
    const notificationsText = messages?.notificationsText
    const redis = getRedis()
    const rateLimitKey = getIdentifier(request, token)

    // Get max auth attempts from settings
    const MAX_FAILED_ATTEMPTS = await getMaxAuthAttempts()

    // Check if currently locked out from too many failed attempts
    const lockoutData = await redis.get(rateLimitKey)
    if (lockoutData) {
      const { count, lockoutUntil } = JSON.parse(lockoutData)
      const now = Date.now()

      if (lockoutUntil && lockoutUntil > now) {
        const retryAfter = Math.ceil((lockoutUntil - now) / 1000)

        // Log security event for rate limit hit
        const ipAddress = getClientIpAddress(request)

        await logSecurityEvent({
          type: 'PASSWORD_RATE_LIMIT_HIT',
          severity: 'WARNING',
          ipAddress,
          details: {
            shareToken: token,
            failedAttempts: count,
            retryAfter,
          },
          wasBlocked: true,
        })

        return NextResponse.json(
          { error: shareMessages?.tooManyPasswordAttempts || 'Too many failed password attempts. Please try again later.', retryAfter },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        )
      }
    }
    
    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const { password } = parsed.data

    if (!password) {
      return NextResponse.json({ error: shareMessages?.passwordRequiredShort || 'Password is required' }, { status: 400 })
    }

    const project = await prisma.project.findUnique({
      where: { slug: token },
      select: {
        id: true,
        title: true,
        sharePassword: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: shareMessages?.accessDenied || 'Access denied' }, { status: 403 })
    }

    if (!project.sharePassword) {
      return NextResponse.json({ success: true })
    }

    // Decrypt the stored password and compare with provided password using constant-time comparison
    let isValid = false
    try {
      const decryptedPassword = decrypt(project.sharePassword)
      // Use constant-time comparison to prevent timing attacks
      isValid = constantTimeCompare(password, decryptedPassword)
    } catch (error) {
      logError('Error decrypting password:', error)
      // If decryption fails, password is invalid
      isValid = false
    }

    if (!isValid) {
      // FAILED attempt — progressive backoff.
      // - track attempts in a 24h window
      // - on 5th failure, start a lockout sized by `consecutiveLockouts`
      //   (15 min → 1h → 4h)
      // - consecutiveLockouts auto-resets after 24h of quiet
      const now = Date.now()
      const existingData = await redis.get(rateLimitKey)
      const prev: LockoutEntry | null = existingData ? JSON.parse(existingData) : null

      let count = 1
      let firstAttempt = now
      let consecutiveLockouts = prev?.consecutiveLockouts ?? 0
      let lastLockoutAt = prev?.lastLockoutAt

      // Long-stale entry → start fresh (the 24h window for both
      // attempt counting and consecutive-lockout decay).
      if (prev && now - prev.firstAttempt <= ATTEMPT_WINDOW_MS) {
        // If a lockout already expired, reset the count so the next
        // 5 attempts start a new tier (1st window inside the
        // backoff sequence). Otherwise just increment.
        const lockoutHasExpired = prev.lockoutUntil && now >= prev.lockoutUntil
        if (lockoutHasExpired) {
          count = 1
          firstAttempt = now
        } else {
          count = (prev.count || 0) + 1
          firstAttempt = prev.firstAttempt
        }
      }

      // Decide if this attempt crosses into a new lockout. Compute
      // both lockoutUntil and the (possibly bumped) consecutive
      // counter together so the entry stays consistent.
      let lockoutUntil: number | undefined
      if (count >= MAX_FAILED_ATTEMPTS) {
        consecutiveLockouts = nextConsecutiveLockouts(prev, now)
        lockoutUntil = now + lockoutDurationMs(consecutiveLockouts)
        lastLockoutAt = now
      }

      const rateLimitEntry: LockoutEntry = {
        count,
        firstAttempt,
        lastAttempt: now,
        lockoutUntil,
        consecutiveLockouts,
        lastLockoutAt,
      }

      // TTL covers the full decay window so we can resurrect
      // consecutive-lockout history when an attacker comes back
      // hours later.
      const ttlSeconds = Math.ceil(ATTEMPT_WINDOW_MS / 1000)
      await redis.setex(rateLimitKey, ttlSeconds, JSON.stringify(rateLimitEntry))

      // Log security event for failed password attempt
      const ipAddress = getClientIpAddress(request)

      await logSecurityEvent({
        type: 'FAILED_PASSWORD_ATTEMPT',
        severity: count >= MAX_FAILED_ATTEMPTS ? 'CRITICAL' : 'WARNING',
        projectId: project.id,
        ipAddress,
        details: {
          shareToken: token,
          attemptNumber: count,
          maxAttempts: MAX_FAILED_ATTEMPTS,
        },
        wasBlocked: false,
      })

      // If this was the 5th failed attempt, return rate limit error.
      // 1.5.8: lockout duration now varies by tier (15 min / 1h /
      // 4h) — read it off the entry we just wrote instead of using
      // a fixed window constant.
      if (count >= MAX_FAILED_ATTEMPTS) {
        const retryAfter = Math.ceil(((lockoutUntil ?? now) - now) / 1000)

        // Log additional event for lockout
        await logSecurityEvent({
          type: 'PASSWORD_LOCKOUT',
          severity: 'CRITICAL',
          projectId: project.id,
          ipAddress,
          details: {
            shareToken: token,
            failedAttempts: count,
            lockoutDuration: retryAfter,
          },
          wasBlocked: true,
        })

        void enqueueExternalNotification({
          eventType: 'SECURITY_ALERT',
          title: notificationsText?.securityAlertTitle || 'Security Alert',
          body: (notificationsText?.sharePasswordLockoutBody || 'Share password locked out on {projectTitle} after too many failed attempts')
            .replace('{projectTitle}', project.title),
          notifyType: 'failure',
          pushData: {
            projectTitle: project.title,
            projectId: project.id,
            title: notificationsText?.securityAlertTitle || 'Security Alert',
            body: (notificationsText?.sharePasswordLockoutBody || 'Share password locked out on {projectTitle} after too many failed attempts')
              .replace('{projectTitle}', project.title),
          },
        }).catch((notificationError) => {
          logError('[SHARE VERIFY] Failed to enqueue external lockout notification:', notificationError)
        })

        return NextResponse.json(
          { error: shareMessages?.tooManyPasswordAttempts || 'Too many failed password attempts. Please try again later.', retryAfter },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        )
      }

      return NextResponse.json({ error: shareMessages?.accessDenied || 'Access denied' }, { status: 403 })
    }

    // SUCCESS - clear any existing rate limit data
    await redis.del(rateLimitKey)

    const shareTokenTtl = await getShareTokenTtlSeconds()
    const shareToken = signShareToken({
      shareId: token,
      projectId: project.id,
      permissions: ['view', 'comment', 'download'],
      guest: false,
      ttlSeconds: shareTokenTtl,
    })

    // Log successful password-based access
    await logSecurityEvent({
      type: 'PASSWORD_ACCESS',
      severity: 'INFO',
      projectId: project.id,
      ipAddress: getClientIpAddress(request),
      details: {
        shareToken: token,
      },
      wasBlocked: false,
    })

    // Track share page access for analytics (GDPR: respect consent header)
    const shareTokenPayload = jwt.decode(shareToken) as any
    if (shareTokenPayload?.sessionId) {
      await trackSharePageAccess({
        projectId: project.id,
        accessMethod: 'PASSWORD',
        sessionId: shareTokenPayload.sessionId,
        request,
        analyticsConsent: readAnalyticsConsent(request),
      })
    }

    return NextResponse.json({ success: true, shareToken })
  } catch (error) {
    logError('Error verifying share password:', error)
    const locale = await getConfiguredLocale().catch(() => 'en')
    const messages = await loadLocaleMessages(locale).catch(() => null)
    return NextResponse.json({ error: messages?.share?.accessDenied || 'Access denied' }, { status: 403 })
  }
}
