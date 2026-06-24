import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { listNotifications } from '@/lib/inapp-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 3.5.0+ GET /api/notifications
 *
 * The admin bell's data source. Returns this admin's recent in-app
 * notifications (newest first) plus the unread count for the badge.
 * Also serves as the polling fallback when the live SSE stream can't
 * be established (e.g. a reverse proxy buffering text/event-stream).
 */
export async function GET(request: NextRequest) {
  const auth = await requireApiAdmin(request)
  if (auth instanceof Response) return auth

  // Generous limit — the bell polls this as a fallback.
  const rl = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many requests. Please slow down.',
    },
    'notifications-list',
  )
  if (rl) return rl

  try {
    const { notifications, unreadCount } = await listNotifications(auth.id, 30)
    return NextResponse.json({ notifications, unreadCount })
  } catch (error) {
    logError('[GET /api/notifications] failed:', error)
    return NextResponse.json(
      { error: 'Failed to load notifications', notifications: [], unreadCount: 0 },
      { status: 500 },
    )
  }
}
