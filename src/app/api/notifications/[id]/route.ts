import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { deleteNotification } from '@/lib/inapp-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.x DELETE /api/notifications/:id
 *
 * Permanently remove one of the current admin's notifications (the per-row
 * trash button in the bell). Always scoped to the authenticated recipient so
 * one admin can never delete another's notifications.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many requests. Please slow down.',
    },
    'notifications-delete',
  )
  if (rl) return rl

  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Missing notification id' }, { status: 400 })
    }
    await deleteNotification(auth.id, id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[DELETE /api/notifications/:id] failed:', error)
    return NextResponse.json(
      { error: 'Failed to delete notification' },
      { status: 500 },
    )
  }
}
