import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged, currentOrgId } from '@/lib/db'
import { requireApiOwner } from '@/lib/auth'
import { verifyPassword } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import {
  getOrgDangerState,
  isPlatformOrgContext,
  ORG_DELETION_GRACE_MS,
} from '@/lib/danger-zone'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.10 Danger Zone: POST /api/organization/delete — schedule THIS company's
 * deletion 30 days out. Owner only, password + exact company name required,
 * and only when the org holds ZERO projects (any state, Trash included).
 * The platform org can never be deleted. See lib/danger-zone.ts.
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiOwner(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 60 * 1000, maxRequests: 5, message: 'Too many attempts. Please wait.' },
    'org-delete',
  )
  if (limited) return limited

  try {
    if (isPlatformOrgContext()) {
      return NextResponse.json(
        { error: 'The platform company cannot be deleted.' },
        { status: 403 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const password = typeof body?.password === 'string' ? body.password : ''
    const companyName = typeof body?.companyName === 'string' ? body.companyName.trim() : ''
    /*
     * 6.25.0 — an optional parting word.
     *
     * Never gates the deletion: somebody closing their account has already
     * decided, and refusing to let them leave until they explain would be a
     * dark pattern in the one place a product should be most gracious. Capped
     * and trimmed here rather than trusted, because it is free text from a
     * client that is on its way out and has no reason to behave.
     */
    const rawReason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    const deletionReason = rawReason ? rawReason.slice(0, 1000) : null

    // Password re-check — a stolen session alone must not be enough.
    const user = (await prismaPrivileged.user.findUnique({
      where: { id: auth.id },
      select: { password: true } as any,
    })) as any
    if (!user || !password || !(await verifyPassword(password, user.password))) {
      await logSecurityEvent({
        type: 'ORG_DELETE_BAD_PASSWORD',
        severity: 'WARNING',
        ipAddress: getClientIpAddress(request),
        details: { organizationId: currentOrgId(), userId: auth.id },
        wasBlocked: true,
      }).catch(() => {})
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 403 })
    }

    const org = await getOrgDangerState()
    if (!org) return NextResponse.json({ error: 'Company not found.' }, { status: 404 })
    if (org.deletionScheduledAt) {
      return NextResponse.json({ error: 'Deletion is already scheduled.' }, { status: 409 })
    }
    // Typed-name barrier against impulsive clicks.
    if (companyName !== org.name.trim()) {
      return NextResponse.json(
        { error: 'Company name does not match. Type it exactly as shown in Settings.' },
        { status: 400 },
      )
    }

    // ZERO-projects invariant (any state, Trash included) — the anti-wipe
    // core: emptying a company takes at least a day per project, loudly.
    const projectCount = await (prismaPrivileged as any).project.count({
      where: { organizationId: currentOrgId() },
    })
    if (projectCount > 0) {
      return NextResponse.json(
        {
          error:
            `This company still has ${projectCount} project(s) (Trash included). ` +
            'For safety, every project must be deleted first — at most one per ' +
            '24 hours — before the company itself can be deleted.',
          projectCount,
        },
        { status: 409 },
      )
    }

    const deletionScheduledAt = new Date(Date.now() + ORG_DELETION_GRACE_MS)
    await (prismaPrivileged as any).organization.update({
      where: { id: currentOrgId() },
      data: { deletionScheduledAt, deletionRequestedById: auth.id, deletionReason } as any,
    })

    await logSecurityEvent({
      type: 'ORG_DELETE_SCHEDULED',
      severity: 'CRITICAL',
      ipAddress: getClientIpAddress(request),
      details: {
        organizationId: currentOrgId(), userId: auth.id, deletionScheduledAt,
        // Whether they explained, not what they said — the security log has a
        // wider audience than the one panel that needs the words.
        reasonGiven: !!deletionReason,
      },
      wasBlocked: false,
    }).catch(() => {})
    logMessage(`[danger-zone] org ${currentOrgId()} deletion scheduled for ${deletionScheduledAt.toISOString()} by ${auth.email}`)

    return NextResponse.json({ success: true, deletionScheduledAt })
  } catch (err) {
    logError('[org/delete] failed:', err)
    return NextResponse.json({ error: 'Failed to schedule deletion.' }, { status: 500 })
  }
}
