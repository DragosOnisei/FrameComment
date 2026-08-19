import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged, currentOrgId } from '@/lib/db'
import { requireApiOwner } from '@/lib/auth'
import { verifyPassword } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import { getOrgDangerState } from '@/lib/danger-zone'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.10 Danger Zone: POST /api/organization/delete/cancel — any Owner can
 * stop a pending company deletion (password required) at any point in the
 * 30-day window. This is what makes the long countdown meaningful: the real
 * owner always has time to notice and pull the plug on an attacker.
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiOwner(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 60 * 1000, maxRequests: 10, message: 'Too many attempts. Please wait.' },
    'org-delete-cancel',
  )
  if (limited) return limited

  try {
    const body = await request.json().catch(() => ({}))
    const password = typeof body?.password === 'string' ? body.password : ''

    const user = (await prismaPrivileged.user.findUnique({
      where: { id: auth.id },
      select: { password: true } as any,
    })) as any
    if (!user || !password || !(await verifyPassword(password, user.password))) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 403 })
    }

    const org = await getOrgDangerState()
    if (!org?.deletionScheduledAt) {
      return NextResponse.json({ error: 'No deletion is scheduled.' }, { status: 409 })
    }

    await (prismaPrivileged as any).organization.update({
      where: { id: currentOrgId() },
      // 6.25.0: the reason goes with the cancellation. A note about why someone
      // was leaving, kept against a company that stayed, is a record of a bad
      // afternoon presented later as a fact about the customer.
      data: { deletionScheduledAt: null, deletionRequestedById: null, deletionReason: null } as any,
    })

    await logSecurityEvent({
      type: 'ORG_DELETE_CANCELLED',
      severity: 'INFO',
      ipAddress: getClientIpAddress(request),
      details: { organizationId: currentOrgId(), userId: auth.id },
      wasBlocked: false,
    }).catch(() => {})
    logMessage(`[danger-zone] org ${currentOrgId()} deletion CANCELLED by ${auth.email}`)

    return NextResponse.json({ success: true })
  } catch (err) {
    logError('[org/delete/cancel] failed:', err)
    return NextResponse.json({ error: 'Failed to cancel deletion.' }, { status: 500 })
  }
}
