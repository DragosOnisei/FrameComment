import { NextRequest, NextResponse } from 'next/server'
import { prisma, currentOrgId } from '@/lib/db'
import { requireApiManageUsers } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.6 multi-tenant Phase 4: DELETE /api/team-invites/[id] — revoke an invite
 * link (Owner + Admin). Revocation = row deletion: the link 404s immediately.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiManageUsers(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'team-invites-revoke',
  )
  if (limited) return limited

  try {
    const { id } = await params
    const organizationId = (auth as any).organizationId ?? currentOrgId()

    // deleteMany + org in the WHERE: an id from another company deletes
    // nothing (0 rows) instead of throwing or, worse, working.
    const result = await (prisma as any).teamInvite.deleteMany({
      where: { id, organizationId },
    })
    if (result.count === 0) {
      return NextResponse.json({ error: 'Invite not found.' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('[TEAM-INVITES] revoke failed:', error)
    return NextResponse.json({ error: 'Failed to revoke invite.' }, { status: 500 })
  }
}
