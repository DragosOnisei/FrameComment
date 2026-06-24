import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import {
  markAllNotificationsRead,
  markNotificationRead,
} from '@/lib/inapp-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 3.5.0+ POST /api/notifications/read
 *
 * Mark notifications read for the current admin. Body:
 *   { id: "<notificationId>" }  → mark that one read
 *   { all: true }               → mark all this admin's unread read
 *
 * Always scoped to the authenticated recipient so one admin can never
 * touch another's notifications.
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many requests. Please slow down.',
    },
    'notifications-read',
  )
  if (rl) return rl

  try {
    const body = await request.json().catch(() => ({}))
    if (body?.all === true) {
      await markAllNotificationsRead(auth.id)
      return NextResponse.json({ ok: true })
    }
    if (typeof body?.id === 'string' && body.id) {
      await markNotificationRead(auth.id, body.id)
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json(
      { error: 'Provide { id } or { all: true }' },
      { status: 400 },
    )
  } catch (error) {
    logError('[POST /api/notifications/read] failed:', error)
    return NextResponse.json(
      { error: 'Failed to update notifications' },
      { status: 500 },
    )
  }
}
