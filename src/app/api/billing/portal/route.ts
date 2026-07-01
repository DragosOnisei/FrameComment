import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getStripe } from '@/lib/stripe'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.7.0+: POST /api/billing/portal
 *
 * Opens the Stripe Billing Portal so the admin can update/remove the
 * saved card and view past invoices — all hosted by Stripe. Requires a
 * Stripe Customer to already exist (i.e. a card was connected once).
 *
 * Admin only.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const stripe = getStripe()
  if (!stripe) {
    return NextResponse.json(
      { error: 'Stripe is not configured on this server.' },
      { status: 400 },
    )
  }

  try {
    const settings = (await prisma.settings.findUnique({
      where: { id: 'default' },
    })) as any
    const customerId: string | null = settings?.stripeCustomerId ?? null
    if (!customerId) {
      return NextResponse.json(
        { error: 'No payment method connected yet.' },
        { status: 400 },
      )
    }

    const origin =
      (settings?.appDomain && String(settings.appDomain).replace(/\/+$/, '')) ||
      new URL(request.url).origin

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/admin/settings?billing=portal`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    logError('[billing/portal]', err)
    return NextResponse.json(
      { error: 'Failed to open the billing portal.' },
      { status: 500 },
    )
  }
}
