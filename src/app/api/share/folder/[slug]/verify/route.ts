import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
import crypto from 'crypto'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { getMaxAuthAttempts, getShareTokenTtlSeconds } from '@/lib/settings'
import { getRedis } from '@/lib/redis'
import { signShareToken } from '@/lib/auth'
import { safeParseBody } from '@/lib/validation'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * POST /api/share/folder/[slug]/verify
 *
 * Password-gate verification for folder shares (1.0.6+). Mirrors the
 * project share /verify endpoint exactly — same constant-time
 * compare, same Redis-backed lockout after N failed attempts, same
 * decrypted-on-the-fly password comparison.
 *
 * On success: signs a share token scoped to (projectId, folderId)
 * and returns it. The client stashes the token in memory and sends
 * it as `Authorization: Bearer …` on subsequent calls.
 */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32))
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

function rateLimitKey(request: NextRequest, slug: string): string {
  const ip = getClientIpAddress(request)
  const hash = crypto
    .createHash('sha256')
    .update(`${ip}:${slug}`)
    .digest('hex')
    .slice(0, 16)
  return `ratelimit:share-folder-verify-failed:${slug}:${hash}`
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params
    const redis = getRedis()
    const key = rateLimitKey(request, slug)
    const MAX_FAILED = await getMaxAuthAttempts()

    // Lockout check — short-circuit if the caller is currently
    // locked out from prior failures.
    const lockoutData = await redis.get(key)
    if (lockoutData) {
      const { lockoutUntil } = JSON.parse(lockoutData)
      const now = Date.now()
      if (lockoutUntil && lockoutUntil > now) {
        const retryAfter = Math.ceil((lockoutUntil - now) / 1000)
        return NextResponse.json(
          { error: 'Too many failed password attempts. Please try again later.', retryAfter },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } },
        )
      }
    }

    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const password: unknown = (parsed.data as any)?.password
    if (typeof password !== 'string' || password.length === 0) {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 })
    }

    const folder = await prisma.folder.findUnique({
      where: { slug },
      select: {
        id: true,
        projectId: true,
        sharePassword: true,
        authMode: true,
      },
    })
    if (!folder) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // The folder must actually be in PASSWORD mode — bail out on
    // NONE (no password to check) or OTP/BOTH (not supported yet).
    if (folder.authMode !== 'PASSWORD') {
      return NextResponse.json(
        { error: 'Folder is not password-protected' },
        { status: 400 },
      )
    }
    if (!folder.sharePassword) {
      return NextResponse.json(
        { error: 'Folder password is not configured' },
        { status: 500 },
      )
    }

    let isValid = false
    try {
      const decrypted = decrypt(folder.sharePassword)
      isValid = constantTimeCompare(password, decrypted)
    } catch (err) {
      logError('[share-folder verify] decrypt failed:', err)
      isValid = false
    }

    if (!isValid) {
      const now = Date.now()
      const existing = await redis.get(key)
      let count = 1
      let firstAttempt = now
      if (existing) {
        const data = JSON.parse(existing)
        if (now - data.firstAttempt > RATE_LIMIT_WINDOW_MS) {
          count = 1
          firstAttempt = now
        } else {
          count = data.count + 1
          firstAttempt = data.firstAttempt
        }
      }
      const lockoutUntil = count >= MAX_FAILED ? now + RATE_LIMIT_WINDOW_MS : undefined
      const entry = { count, firstAttempt, lastAttempt: now, lockoutUntil }
      const ttl = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
      await redis.setex(key, ttl, JSON.stringify(entry))

      // Reuse the existing security-event log type — the share token
      // is just a generic identifier of which share was attacked.
      await logSecurityEvent({
        type: 'FAILED_PASSWORD_ATTEMPT',
        severity: count >= MAX_FAILED ? 'CRITICAL' : 'WARNING',
        projectId: folder.projectId,
        ipAddress: getClientIpAddress(request),
        details: {
          shareToken: slug,
          folderId: folder.id,
          attemptNumber: count,
          maxAttempts: MAX_FAILED,
        },
        wasBlocked: false,
      })

      if (count >= MAX_FAILED) {
        const retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
        return NextResponse.json(
          { error: 'Too many failed password attempts. Please try again later.', retryAfter },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } },
        )
      }
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Success — clear lockout and mint a folder-scoped share token.
    await redis.del(key)
    const ttl = await getShareTokenTtlSeconds()
    const shareToken = signShareToken({
      shareId: slug,
      projectId: folder.projectId,
      folderId: folder.id,
      permissions: ['view', 'comment', 'download'],
      guest: false,
      authMode: folder.authMode,
      ttlSeconds: ttl,
    })

    await logSecurityEvent({
      type: 'PASSWORD_ACCESS',
      severity: 'INFO',
      projectId: folder.projectId,
      ipAddress: getClientIpAddress(request),
      details: { shareToken: slug, folderId: folder.id },
      wasBlocked: false,
    })

    return NextResponse.json({ success: true, shareToken })
  } catch (error) {
    logError('[POST /api/share/folder/[slug]/verify] failed:', error)
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }
}
