import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { getStripe } from '@/lib/stripe'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.7.0+: POST /api/billing/checkout
 *
 * Starts a Stripe Checkout session in `setup` mode so the admin can
 * save a card on file. We create (or reuse) the instance's Stripe
 * Customer first, then return the hosted Checkout URL for the client
 * to redirect to. The card is captured entirely by Stripe (no PAN
 * ever touches this server). On completion, the `checkout.session.
 * completed` webhook stores the card + marks billing active.
 *
 * Admin only.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult
  const admin = authResult

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

    // Base URL for the redirect back into Settings. Prefer the admin's
    // configured domain; fall back to the request origin.
    const origin =
      (settings?.appDomain && String(settings.appDomain).replace(/\/+$/, '')) ||
      new URL(request.url).origin

    const email: string | undefined = settings?.billingEmail || admin.email || undefined

    // Reuse the existing Stripe Customer, or create one.
    let customerId: string | null = settings?.stripeCustomerId ?? null
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: settings?.companyName || 'FrameComment',
        metadata: { app: 'framecomment' },
      })
      customerId = customer.id
      await prisma.settings.update({
        where: { id: 'default' },
        data: {
          stripeCustomerId: customerId,
          billingEmail: email ?? null,
        } as any,
      })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      payment_method_types: ['card'],
      success_url: `${origin}/admin/settings?billing=success`,
      cancel_url: `${origin}/admin/settings?billing=cancel`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    logError('[billing/checkout]', err)
    return NextResponse.json(
      { error: 'Failed to start Stripe Checkout.' },
      { status: 500 },
    )
  }
}
