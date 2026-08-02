import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma, prismaPrivileged, setOrgContextOn } from '@/lib/db'
import { enterOrgContext } from '@/lib/org-context'
import { issueAdminTokens, type AuthUser } from '@/lib/auth'
import { hashPassword } from '@/lib/encryption'
import { registerSchema } from '@/lib/validation'
import { rateLimit } from '@/lib/rate-limit'
import { logError, logMessage } from '@/lib/logging'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Same recipe as the login/refresh routes (sha256 → base64url of the UA). */
function fingerprintHash(userAgent: string): string {
  return crypto.createHash('sha256').update(userAgent).digest('base64url')
}

/**
 * 5.0 multi-tenant: POST /api/auth/register — public company registration.
 *
 * Creates, in ONE transaction:
 *   - the Organization (the tenant),
 *   - its first User as OWNER,
 *   - the org's own Settings + SecuritySettings rows,
 * then signs the user in (same token response shape as /api/auth/login).
 *
 * PRIVATE BETA GATE: registration only works when the REGISTER_INVITE_CODE
 * env var is set AND the request supplies the matching code. No env var =
 * registration completely disabled (404), which is the safe default until
 * Phase 3 (full per-org scoping) is complete — see MULTI_TENANT_MIGRATION.md.
 */

/** Constant-time-ish compare (pads to equal length first). */
function safeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length, 1)
  const ab = Buffer.alloc(max)
  const bb = Buffer.alloc(max)
  ab.write(a)
  bb.write(b)
  return crypto.timingSafeEqual(ab, bb) && a.length === b.length
}

/** "Acme Studio!" → "acme-studio-x7k2q4" (unique, URL-safe). */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const suffix = crypto.randomBytes(4).toString('hex').slice(0, 6)
  return base ? `${base}-${suffix}` : `org-${suffix}`
}

export async function POST(request: NextRequest) {
  const expectedCode = process.env.REGISTER_INVITE_CODE
  if (!expectedCode) {
    // Registration is not enabled on this instance.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Strict per-IP limit — registration is an unauthenticated write.
  const limited = await rateLimit(
    request,
    {
      windowMs: 60 * 60 * 1000,
      maxRequests: 10,
      message: 'Too many registration attempts. Please try again later.',
    },
    'register',
  )
  if (limited) return limited

  try {
    const body = await request.json().catch(() => null)
    const parsed = registerSchema.safeParse(body)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return NextResponse.json(
        { error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid input' },
        { status: 400 },
      )
    }
    const { companyName, name, email, password, inviteCode } = parsed.data

    if (!safeEqual(inviteCode, expectedCode)) {
      await logSecurityEvent({
        type: 'REGISTER_INVALID_INVITE_CODE',
        severity: 'WARNING',
        ipAddress: getClientIpAddress(request),
        details: { email },
        wasBlocked: true,
      }).catch(() => {})
      return NextResponse.json({ error: 'Invalid invite code' }, { status: 403 })
    }

    // Email is globally unique for now (one account per person across the
    // platform); per-org e-mail uniqueness is a later relaxation.
    const existing = await prisma.user.findFirst({
      where: { email },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'An account with this email already exists.' },
        { status: 409 },
      )
    }

    const passwordHash = await hashPassword(password)

    // `tx as any` below: the Organization model + organizationId fields are
    // newer than the sandbox's generated client; the Docker build (and the
    // operator's local `prisma generate`) type these fully.
    const orgId = `org_${crypto.randomBytes(12).toString('hex')}`

    // 5.9: platform defaults inherited by every new company (see the
    // settings.create below). Privileged read — this runs pre-arming.
    const platformDefaults = (await (prismaPrivileged as any).settings.findUnique({
      where: { id: 'default' },
      select: { appDomain: true, shortLinkDomain: true } as any,
    })) as any

    // Bind the new org to this request's async context AND arm the RLS
    // setting as the transaction's first statement — required post-flip so
    // the WITH CHECK policies accept these self-creating inserts.
    enterOrgContext(orgId)

    const user = await prisma.$transaction(async (txRaw) => {
      const tx = txRaw as any

      await setOrgContextOn(tx, orgId)

      await tx.organization.create({
        data: {
          id: orgId,
          name: companyName,
          slug: slugify(companyName),
          status: 'ACTIVE',
        },
      })

      const created = await tx.user.create({
        data: {
          email,
          name,
          password: passwordHash,
          role: 'OWNER',
          organizationId: orgId,
        },
        select: { id: true, email: true, name: true, role: true },
      })

      // The org's own Settings row (companyName pre-filled) and
      // SecuritySettings row. Explicit ids: the legacy singletons use
      // id='default' (owned by org-1), so new orgs get id = their org id.
      // 5.9: inherit the PLATFORM's domains (single-domain product — share
      // links and short links must work for tenants out of the box) and
      // default the storage backend to FrameComment Server (the managed
      // option a new company expects; they can switch in Settings).
      await tx.settings.create({
        data: {
          id: orgId,
          organizationId: orgId,
          companyName,
          appDomain: platformDefaults?.appDomain ?? null,
          shortLinkDomain: platformDefaults?.shortLinkDomain ?? null,
          activeStorageBackend: 'fc',
        } as any,
      })
      await tx.securitySettings.create({
        data: {
          id: `sec_${orgId}`,
          organizationId: orgId,
        },
      })

      return created
    })

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as string,
      organizationId: orgId,
    }

    const fingerprint = fingerprintHash(request.headers.get('user-agent') || 'unknown')
    const tokens = await issueAdminTokens(authUser, fingerprint)

    await logSecurityEvent({
      type: 'ORGANIZATION_REGISTERED',
      severity: 'INFO',
      ipAddress: getClientIpAddress(request),
      details: { organizationId: orgId, email: user.email, companyName },
      wasBlocked: false,
    }).catch(() => {})
    logMessage(`[REGISTER] New organization ${orgId} ("${companyName}") — owner ${user.email}`)

    // Same response shape as /api/auth/login so the client can reuse the
    // token-store flow.
    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      },
    })
  } catch (error) {
    logError('[REGISTER] failed:', error)
    return NextResponse.json(
      { error: 'Registration failed. Please try again.' },
      { status: 500 },
    )
  }
}
