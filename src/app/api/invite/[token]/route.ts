import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { enterOrgContext } from '@/lib/org-context'
import { rateLimit } from '@/lib/rate-limit'
import { hashInviteToken, looksLikeInviteToken } from '@/lib/team-invites'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.6 Phase 4: GET /api/invite/[token] — PUBLIC invite landing info.
 *
 * The invitee has no account yet, so this resolves the raw token (hashed)
 * through the privileged client — the same sanctioned pattern as share-slug
 * resolution (lib/share-org.ts). Returns just enough for the landing page:
 * company name + the role they'll get. Enumeration-safe: invalid, revoked,
 * used and expired tokens are indistinguishable except used/expired ones,
 * which get honest statuses so the person knows to ask for a fresh link.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'invite-info',
  )
  if (limited) return limited

  try {
    const { token } = await params
    if (!looksLikeInviteToken(token)) {
      return NextResponse.json({ error: 'Invite not found.' }, { status: 404 })
    }

    const invite = (await (prismaPrivileged as any).teamInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        id: true,
        role: true,
        expiresAt: true,
        acceptedAt: true,
        organizationId: true,
      },
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

    enterOrgContext(invite.organizationId)

    const org = (await (prismaPrivileged as any).organization.findUnique({
      where: { id: invite.organizationId },
      select: { name: true, status: true },
    })) as any
    if (!org || org.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'Invite not found.' }, { status: 404 })
    }

    // Prefer the Branding company name (Settings.companyName — what the
    // operator actually edits) over Organization.name: installs seeded
    // before branding was set had the two drift ("Join Studio" bug).
    const settingsRow = (await (prismaPrivileged as any).settings.findFirst({
      where: { organizationId: invite.organizationId },
      select: { companyName: true },
    })) as any

    return NextResponse.json({
      companyName: settingsRow?.companyName?.trim() || org.name,
      role: invite.role,
      expiresAt: invite.expiresAt,
    })
  } catch (error) {
    logError('[INVITE] info failed:', error)
    return NextResponse.json({ error: 'Failed to load invite.' }, { status: 500 })
  }
}
