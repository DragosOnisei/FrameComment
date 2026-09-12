import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { sendTestNotification } from '@/lib/push-notifications'
import { rateLimit } from '@/lib/rate-limit'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { logError } from '@/lib/logging'


export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/push/test
 * Send a test push notification to a specific subscription
 */
export async function POST(request: NextRequest) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const webPushMessages = messages?.settings?.webPush || {}

  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limit: 10 test notifications per minute per admin
  const rateLimitResult = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: webPushMessages.tooManyTestNotifications || 'Too many test notifications. Please wait.' },
    'push-test',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json()
    const { subscriptionId } = body

    if (!subscriptionId) {
      return NextResponse.json(
        { error: webPushMessages.missingSubscriptionId || 'Missing subscriptionId' },
        { status: 400 }
      )
    }

    const result = await sendTestNotification(subscriptionId)

    if (result.success) {
      // 7.8.1: the push service's status code, so Settings can show "accepted
      // (HTTP 201)" as the first of three steps and place a failure precisely.
      return NextResponse.json({ success: true, statusCode: result.statusCode ?? null })
    } else {
      return NextResponse.json(
        {
          error: result.error || webPushMessages.failedToSendTestNotification || 'Failed to send test notification',
          statusCode: result.statusCode ?? null,
        },
        { status: 502 }
      )
    }
  } catch (error) {
    logError('[API] Failed to send test notification:', error)
    return NextResponse.json(
      { error: webPushMessages.failedToSendTestNotification || 'Failed to send test notification' },
      { status: 500 }
    )
  }
}
