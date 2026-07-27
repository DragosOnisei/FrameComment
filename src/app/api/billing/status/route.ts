import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { canManageSettings } from '@/lib/permissions'
import { getStripe, isStripeConfigured, isStripeTestMode } from '@/lib/stripe'
import {
  computeBillingUsage,
  isOverFreeTier,
  evaluateBillingHealth,
  businessDaysBetween,
  graceDeadline,
  FREE_TIER,
  GRACE_BUSINESS_DAYS,
} from '@/lib/billing'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.7.0+ / 3.8.0+: GET /api/billing/status
 *
 * Drives the Billing pane + the admin billing wall: Stripe config +
 * test-mode, the saved card, billing status, next charge, last invoice,
 * the free-tier state, and the dunning state (grace days left /
 * suspended). Admin only.
 *
 * Side effects (safe, idempotent):
 *  - If a stored Stripe customer no longer exists in the CURRENT mode
 *    (e.g. a test customer after switching to live keys), the local
 *    billing state is reset so the UI shows "Connect Stripe" fresh.
 *  - Refreshes the dunning state so the wall reflects reality without
 *    waiting for the daily job.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const stripe = getStripe()
    let settings = (await prisma.settings.findUnique({
      where: { id: 'default' },
    })) as any

    // Reset local billing state if the stored customer doesn't exist in
    // the current Stripe mode (test→live switch drops the test customer).
    if (stripe && settings?.stripeCustomerId) {
      try {
        const cust = await stripe.customers.retrieve(settings.stripeCustomerId)
        if ((cust as any)?.deleted) throw new Error('customer deleted')
      } catch {
        await prisma.settings
          .update({
            where: { id: 'default' },
            data: {
              stripeCustomerId: null,
              paymentMethodBrand: null,
              paymentMethodLast4: null,
              billingStatus: 'none',
              nextBillingAt: null,
              billingIssueSince: null,
              billingSuspended: false,
            } as any,
          })
          .catch(() => {})
      }
    }

    // Refresh dunning + re-read.
    await evaluateBillingHealth().catch(() => {})
    settings = (await prisma.settings.findUnique({
      where: { id: 'default' },
    })) as any

    const usage = await computeBillingUsage()
    const last4: string | null = settings?.paymentMethodLast4 ?? null
    const issueSince: Date | null = settings?.billingIssueSince ?? null
    const graceDaysLeft = issueSince
      ? Math.max(
          0,
          GRACE_BUSINESS_DAYS -
            businessDaysBetween(new Date(issueSince), new Date()),
        )
      : null
    // Precise lockout moment so the UI can show a live HH:MM:SS countdown on
    // the final grace day.
    const graceEndsAt = issueSince
      ? graceDeadline(new Date(issueSince)).toISOString()
      : null

    // 4.3.0+: the suspension wall needs the `suspended` flag for EVERY internal
    // role (Editor/Marketing/Producer included — they're locked out too when the
    // account is suspended). But the financial details (card, invoices, billing
    // email, next charge) are Owner/Admin only. Non-managers get just the wall
    // essentials so nothing sensitive leaks.
    if (!canManageSettings(authResult.role)) {
      return NextResponse.json({
        suspended: !!settings?.billingSuspended,
        graceDaysLeft,
        graceEndsAt,
      })
    }

    return NextResponse.json({
      configured: isStripeConfigured(),
      testMode: isStripeTestMode(),
      status: settings?.billingStatus ?? 'none',
      billingEmail: settings?.billingEmail ?? null,
      card: last4
        ? { brand: settings?.paymentMethodBrand ?? null, last4 }
        : null,
      hasCard: !!last4,
      nextBillingAt: settings?.nextBillingAt ?? null,
      lastInvoice: settings?.lastInvoiceId
        ? {
            id: settings.lastInvoiceId,
            amount: settings.lastInvoiceAmount ?? null,
            status: settings.lastInvoiceStatus ?? null,
            at: settings.lastChargedAt ?? null,
          }
        : null,
      // Free tier + dunning
      freeTier: { users: FREE_TIER.users, gib: FREE_TIER.gib },
      overFreeTier: isOverFreeTier(usage),
      suspended: !!settings?.billingSuspended,
      issueSince,
      graceDaysLeft,
      graceEndsAt,
    })
  } catch (err) {
    logError('[billing/status]', err)
    return NextResponse.json(
      { error: 'Failed to load billing status.' },
      { status: 500 },
    )
  }
}
