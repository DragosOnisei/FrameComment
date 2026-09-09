import { NextRequest, NextResponse } from 'next/server'
import { getVapidPublicKey } from '@/lib/push-notifications'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'


export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/push/vapid-public-key
 * Returns the VAPID public key the browser subscribes with.
 *
 * 7.7.1: signed-in staff only. This used to be a public endpoint ("anyone can
 * request the public key"), and that is exactly why enabling push on
 * production has been broken since the RLS flip: with no session there is no
 * organisation context, the armed client runs the Settings lookup unarmed,
 * RLS hides the company's row, `getOrCreateVapidKeys` concludes there are no
 * keys, tries to insert a fresh pair, the insert is refused — and the route
 * answered 500 "Failed to get VAPID public key" to every Enable click (the
 * 7.7.0 entry bar, and the Settings button before it). Locally the database
 * runs as a superuser, RLS filters nothing, and the same code works — the
 * asymmetry CLAUDE.md warns about.
 *
 * Requiring the session fixes it and makes the answer correct: keys are per
 * company (one Settings row each), so the key must be the caller's company's
 * — an unauthenticated route could only ever have handed out org-1's. Both
 * callers (the entry bar and Settings) are signed-in staff.
 */
export async function GET(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const webPushMessages = messages?.settings?.webPush || {}

  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limit: 30 requests per minute per IP
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: webPushMessages.tooManyVapidKeyRequests || 'Too many requests. Please wait.' },
    'vapid-key'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const publicKey = await getVapidPublicKey()
    return NextResponse.json({ publicKey })
  } catch (error) {
    logError('[API] Failed to get VAPID public key:', error)
    return NextResponse.json(
      { error: webPushMessages.failedToGetVapidKey || 'Failed to get VAPID public key' },
      { status: 500 }
    )
  }
}
