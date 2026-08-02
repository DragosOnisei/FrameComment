import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma, currentOrgId } from '@/lib/db'
import { requireApiManageUsers } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { canAssignRole, isAppRole } from '@/lib/permissions'
import { hashInviteToken, INVITE_TTL_MS } from '@/lib/team-invites'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.6 multi-tenant Phase 4: team-invite links (Owner + Admin only).
 *
 * POST — mint a link: random 32-byte token, sha256 stored, 7-day expiry.
 *        The RAW token appears exactly once, in this response; the UI builds
 *        `<origin>/invite/<token>` and copies it. It cannot be re-shown.
 * GET  — list the org's PENDING invites (not accepted, not expired) for the
 *        management modal, so links can be revoked.
 */

export async function POST(request: NextRequest) {
  const auth = await requireApiManageUsers(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many invite requests. Please slow down.' },
    'team-invites-create',
  )
  if (limited) return limited

  try {
    const body = await request.json().catch(() => ({}))
    const role = typeof body?.role === 'string' ? body.role : 'EDITOR'

    // Format + authorization: never OWNER, never above the actor's own level.
    if (!isAppRole(role) || !canAssignRole(auth.role, role)) {
      return NextResponse.json({ error: 'You cannot invite members with this role.' }, { status: 403 })
    }

    const rawToken = crypto.randomBytes(32).toString('base64url')
    const organizationId = (auth as any).organizationId ?? currentOrgId()

    const invite = await (prisma as any).teamInvite.create({
      data: {
        tokenHash: hashInviteToken(rawToken),
        role,
        invitedById: auth.id,
        invitedByName: auth.name || auth.email,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        // Explicit org (defense-in-depth over the column default).
        organizationId,
      },
      select: { id: true, role: true, expiresAt: true, createdAt: true },
    })

    return NextResponse.json({
      invite: {
        id: invite.id,
        role: invite.role,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      },
      // Relative on purpose — the client prefixes window.location.origin, so
      // the link is correct on the app domain without a settings read.
      path: `/invite/${rawToken}`,
    })
  } catch (error) {
    logError('[TEAM-INVITES] create failed:', error)
    return NextResponse.json({ error: 'Failed to create invite.' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireApiManageUsers(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'team-invites-list',
  )
  if (limited) return limited

  try {
    const organizationId = (auth as any).organizationId ?? currentOrgId()
    const invites = await (prisma as any).teamInvite.findMany({
      where: {
        // Explicit org filter (app-level isolation pre-flip; RLS post-flip).
        organizationId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        role: true,
        invitedByName: true,
        expiresAt: true,
        createdAt: true,
      },
    })
    return NextResponse.json({ invites })
  } catch (error) {
    logError('[TEAM-INVITES] list failed:', error)
    return NextResponse.json({ error: 'Failed to list invites.' }, { status: 500 })
  }
}
