import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiManageUsers } from '@/lib/auth'
import { getActiveGraceTransfer } from '@/lib/ownership'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.3.0+: current ownership-transfer state, for the grace banner + the
 * User Management screen. Owner/Admin only. Returns whether a transfer is in
 * its 30-day window and, if so, who's involved and how long remains — plus
 * whether the viewer is the grace (previous) owner or the new owner.
 */
export async function GET(request: NextRequest) {
  const auth = await requireApiManageUsers(request)
  if (auth instanceof Response) return auth

  try {
    const t = await getActiveGraceTransfer()
    if (!t) {
      return NextResponse.json({ active: false }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const users = await prisma.user.findMany({
      where: { id: { in: [t.fromUserId, t.toUserId] } },
      select: { id: true, name: true, email: true },
    })
    const from = users.find((u) => u.id === t.fromUserId)
    const to = users.find((u) => u.id === t.toUserId)
    const graceEndsAt = new Date(t.graceEndsAt)
    const daysRemaining = Math.max(
      0,
      Math.ceil((graceEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    )
    return NextResponse.json(
      {
        active: true,
        transfer: {
          fromUserId: t.fromUserId,
          toUserId: t.toUserId,
          fromName: from?.name || from?.email || 'Previous owner',
          toName: to?.name || to?.email || 'New owner',
          graceEndsAt: graceEndsAt.toISOString(),
          daysRemaining,
          viewerIsGraceOwner: auth.id === t.fromUserId,
          viewerIsNewOwner: auth.id === t.toUserId,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    logError('[ownership] status failed:', error)
    return NextResponse.json({ error: 'Failed to read ownership status' }, { status: 500 })
  }
}
