import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma, prismaPrivileged, setOrgContextOn } from '@/lib/db'
import { enterOrgContext } from '@/lib/org-context'
import { issueAdminTokens, type AuthUser } from '@/lib/auth'
import { setRefreshCookie } from '@/lib/auth-cookies'
import { hashPassword } from '@/lib/encryption'
import { acceptInviteSchema } from '@/lib/validation'
import { rateLimit } from '@/lib/rate-limit'
import { hashInviteToken, looksLikeInviteToken } from '@/lib/team-invites'
import { logError, logMessage } from '@/lib/logging'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { hashDeviceSignature } from '@/lib/device-signature'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Same recipe as login/refresh/register (sha256 → base64url of the UA). */

/**
 * 5.6 Phase 4: POST /api/invite/[token]/accept — PUBLIC.
 *
 * Creates the invited team member INSIDE the invite's organization with the
 * invite's role, marks the invite used, and signs the person in (login-shaped
 * response, same as /api/auth/register).
 *
 * Safety properties:
 *  - the ROLE and the ORG come exclusively from the stored invite row — the
 *    request body can never influence either;
 *  - single-use is transaction-enforced: `updateMany(... acceptedAt: null)`
 *    claiming 0 rows rolls the user creation back (two racing accepts → one
 *    account);
 *  - email is globally unique (checked + DB constraint);
 *  - the whole tx arms the org context first, so post-flip the WITH CHECK
 *    policies accept these inserts into the invite's org.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // Strict per-IP limit — unauthenticated account creation.
  const limited = await rateLimit(
    request,
    { windowMs: 60 * 60 * 1000, maxRequests: 10, message: 'Too many attempts. Please try again later.' },
    'invite-accept',
  )
  if (limited) return limited

  try {
    const { token } = await params
    if (!looksLikeInviteToken(token)) {
      return NextResponse.json({ error: 'Invite not found.' }, { status: 404 })
    }

    const body = await request.json().catch(() => null)
    const parsed = acceptInviteSchema.safeParse(body)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return NextResponse.json(
        { error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid input' },
        { status: 400 },
      )
    }
    const { name, email, password } = parsed.data

    // Resolve the invite (privileged: the invitee has no org context yet).
    const invite = (await (prismaPrivileged as any).teamInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: { id: true, role: true, expiresAt: true, acceptedAt: true, organizationId: true },
    })) as any
    if (!invite || !invite.organizationId) {
      return NextResponse.json({ error: 'Invite not found.' }, { status: 404 })
    }
    if (invite.acceptedAt) {
      return NextResponse.json({ error: 'This invite has already been used.' }, { status: 410 })
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'This invite has expired.' }, { status: 410 })
    }

    const org = (await (prismaPrivileged as any).organization.findUnique({
      where: { id: invite.organizationId },
      select: { id: true, name: true, status: true },
    })) as any
    if (!org || org.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'Invite not found.' }, { status: 404 })
    }

    // Email is globally unique — checked across ALL orgs (privileged), the
    // same rule /api/auth/register applies.
    const existing = await prismaPrivileged.user.findFirst({
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
    const orgId: string = invite.organizationId

    enterOrgContext(orgId)

    const user = await prisma.$transaction(async (txRaw) => {
      const tx = txRaw as any
      await setOrgContextOn(tx, orgId)

      const created = await tx.user.create({
        data: {
          email,
          name,
          password: passwordHash,
          // Role comes from the INVITE, never the request.
          role: invite.role,
          organizationId: orgId,
        },
        select: { id: true, email: true, name: true, role: true },
      })

      // Single-use claim: only succeeds if nobody else claimed it meanwhile.
      const claimed = await tx.teamInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date(), acceptedById: created.id },
      })
      if (claimed.count === 0) {
        throw new Error('INVITE_ALREADY_USED')
      }

      return created
    })

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as string,
      organizationId: orgId,
    }
    const fingerprint = hashDeviceSignature(request.headers.get('user-agent'))
    const tokens = await issueAdminTokens(authUser, fingerprint)

    await logSecurityEvent({
      type: 'TEAM_INVITE_ACCEPTED',
      severity: 'INFO',
      ipAddress: getClientIpAddress(request),
      details: { organizationId: orgId, email: user.email, role: user.role, inviteId: invite.id },
      wasBlocked: false,
    }).catch(() => {})
    logMessage(`[INVITE] ${user.email} joined ${orgId} ("${org.name}") as ${user.role}`)

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tokens: {
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      },
    })
    return setRefreshCookie(response, request, tokens.refreshToken, tokens.refreshMaxAgeSeconds)
  } catch (error) {
    if (error instanceof Error && error.message === 'INVITE_ALREADY_USED') {
      return NextResponse.json({ error: 'This invite has already been used.' }, { status: 410 })
    }
    // Unique-constraint race on email (two simultaneous accepts with the
    // same address) — present it as the normal conflict.
    if ((error as { code?: string })?.code === 'P2002') {
      return NextResponse.json(
        { error: 'An account with this email already exists.' },
        { status: 409 },
      )
    }
    logError('[INVITE] accept failed:', error)
    return NextResponse.json({ error: 'Failed to join. Please try again.' }, { status: 500 })
  }
}
