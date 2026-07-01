import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { isStripeTestMode } from '@/lib/stripe'
import { chargeInstance } from '@/lib/billing'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.7.0+: POST /api/billing/test-charge
 *
 * Fires an immediate charge for the current usage so the full
 * invoice → pay flow can be validated without waiting for the monthly
 * anchor date. HARD-GATED to Stripe TEST mode (sk_test_…) so it can
 * never move real money — returns 403 on a live key. Admin only.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  if (!isStripeTestMode()) {
    return NextResponse.json(
      { error: 'Test charge is only available with a Stripe test key.' },
      { status: 403 },
    )
  }

  try {
    const result = await chargeInstance()
    return NextResponse.json(result, { status: result.ok ? 200 : 400 })
  } catch (err) {
    logError('[billing/test-charge]', err)
    return NextResponse.json(
      { ok: false, message: 'Test charge failed.' },
      { status: 500 },
    )
  }
}
