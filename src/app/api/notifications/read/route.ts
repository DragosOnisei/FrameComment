import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import {
  markAllNotificationsRead,
  markAllNotificationsUnread,
  markNotificationRead,
  markNotificationUnread,
} from '@/lib/inapp-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 3.5.0+ POST /api/notifications/read
 *
 * Toggle read state for the current admin's notifications. Body:
 *   { id: "<notificationId>" }             → mark that one read
 *   { id: "<notificationId>", read: false } → mark that one UNread
 *   { all: true }                          → mark all read
 *   { all: true, read: false }             → mark all UNread
 *
 * `read` defaults to true (mark-read) for backwards compatibility. Always
 * scoped to the authenticated recipient so one admin can never touch
 * another's notifications.
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
    // read defaults to true; only an explicit `read: false` means mark-unread.
    const markUnread = body?.read === false
    if (body?.all === true) {
      if (markUnread) await markAllNotificationsUnread(auth.id)
      else await markAllNotificationsRead(auth.id)
      return NextResponse.json({ ok: true })
    }
    if (typeof body?.id === 'string' && body.id) {
      if (markUnread) await markNotificationUnread(auth.id, body.id)
      else await markNotificationRead(auth.id, body.id)
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
