import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { prisma, prismaPrivileged, orgSettingsWhere } from '@/lib/db'
import { enterOrgContext } from '@/lib/org-context'
import { getStripe, getStripeWebhookSecret } from '@/lib/stripe'
import { addOneMonth } from '@/lib/billing'
import { logError, logMessage } from '@/lib/logging'

/**
 * 5.7 Phase 5: webhooks are UNAUTHENTICATED (signature-verified instead),
 * so the org can't come from a session — it comes from the Stripe CUSTOMER.
 * The checkout route saves stripeCustomerId onto the org's Settings row
 * BEFORE Stripe ever calls us, so this lookup always resolves for events
 * we care about. Arms the org context; returns false when unknown (event
 * for a customer we've never seen — safely ignored).
 */
async function armOrgForStripeCustomer(
  customerId: string | null | undefined,
): Promise<boolean> {
  if (!customerId) return false
  try {
    const row = (await (prismaPrivileged as any).settings.findFirst({
      where: { stripeCustomerId: customerId },
      select: { organizationId: true },
    })) as any
    if (!row?.organizationId) return false
    enterOrgContext(row.organizationId)
    return true
  } catch (err) {
    logError('[billing/webhook] customer -> org resolution failed:', err)
    return false
  }
}

function eventCustomerId(obj: { customer?: string | { id: string } | null }): string | null {
  return typeof obj.customer === 'string' ? obj.customer : obj.customer?.id ?? null
}

export const runtime = 'nodejs'
// Stripe needs the raw, unparsed body to verify the signature.
export const dynamic = 'force-dynamic'

/**
 * 3.7.0+: POST /api/billing/webhook
 *
 * Stripe → us. NOT behind admin auth (Stripe can't send our tokens);
 * instead every event is verified with the webhook signing secret, so
 * only genuinely Stripe-signed payloads are trusted.
 *
 * Events we act on:
 *   checkout.session.completed  → a card was saved: set it as the
 *                                 customer's default, store brand/last4,
 *                                 mark billing active, schedule cycle 1.
 *   invoice.paid                → record the paid invoice, keep active.
 *   invoice.payment_failed      → mark past_due (surfaces in the UI).
 */
export async function POST(request: NextRequest) {
  const stripe = getStripe()
  const secret = getStripeWebhookSecret()
  if (!stripe || !secret) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 400 })
  }

  const sig = request.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  const raw = await request.text()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret)
  } catch (err) {
    logError('[billing/webhook] signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.mode !== 'setup') break
        const customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id
        const setupIntentId =
          typeof session.setup_intent === 'string'
            ? session.setup_intent
            : session.setup_intent?.id
        if (!customerId || !setupIntentId) break

        // 5.7: scope everything below to the customer's ORGANIZATION.
        if (!(await armOrgForStripeCustomer(customerId))) {
          logMessage(`[billing/webhook] unknown customer ${customerId} — ignored`)
          break
        }

        const si = await stripe.setupIntents.retrieve(setupIntentId)
        const pmId =
          typeof si.payment_method === 'string'
            ? si.payment_method
            : si.payment_method?.id
        if (!pmId) break

        // Make the saved card the default for future invoices.
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: pmId },
        })
        const pm = await stripe.paymentMethods.retrieve(pmId)

        const existing = (await prisma.settings.findUnique({
          where: orgSettingsWhere(),
        })) as any
        await prisma.settings.update({
          where: orgSettingsWhere(),
          data: {
            stripeCustomerId: customerId,
            paymentMethodBrand: pm.card?.brand ?? null,
            paymentMethodLast4: pm.card?.last4 ?? null,
            billingStatus: 'active',
            // Schedule the first automatic charge a month out (keep an
            // already-set anchor if one exists).
            nextBillingAt: existing?.nextBillingAt ?? addOneMonth(new Date()),
          } as any,
        })
        logMessage('[billing/webhook] card saved, billing active')
        break
      }

      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice
        // 5.7.2: only OUR invoices (metadata app=framecomment). The same
        // Stripe account can bill other products — their paid invoices used
        // to overwrite lastInvoiceId/billingStatus here (seen live: a
        // foreign paid invoice masked a genuinely failed FrameComment
        // charge, so Retry reported "already paid").
        if (inv.metadata?.app !== 'framecomment') break
        if (!(await armOrgForStripeCustomer(eventCustomerId(inv)))) break
        await prisma.settings
          .update({
            where: orgSettingsWhere(),
            data: {
              lastInvoiceId: inv.id,
              lastInvoiceAmount: inv.amount_paid,
              lastInvoiceStatus: 'paid',
              lastChargedAt: new Date(),
              billingStatus: 'active',
            } as any,
          })
          .catch(() => {})
        break
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice
        // 5.7.2: only OUR invoices — see invoice.paid above.
        if (inv.metadata?.app !== 'framecomment') break
        if (!(await armOrgForStripeCustomer(eventCustomerId(inv)))) break
        await prisma.settings
          .update({
            where: orgSettingsWhere(),
            data: {
              lastInvoiceId: inv.id,
              lastInvoiceStatus: 'failed',
              billingStatus: 'past_due',
            } as any,
          })
          .catch(() => {})
        logMessage('[billing/webhook] invoice payment failed → past_due')
        break
      }

      default:
        break
    }
  } catch (err) {
    logError('[billing/webhook] handler error:', err)
    // 500 so Stripe retries delivery.
    return NextResponse.json({ error: 'Handler error' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
