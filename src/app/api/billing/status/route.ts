import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { isStripeConfigured, isStripeTestMode } from '@/lib/stripe'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

/**
 * 3.7.0+: GET /api/billing/status
 *
 * Drives the Billing pane's connection state: whether Stripe is set up
 * on this server, whether we're in test mode, the saved card (brand +
 * last4, never the PAN), billing status, next charge date, and the last
 * invoice snapshot. Admin only.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  try {
    const settings = (await prisma.settings.findUnique({
      where: { id: 'default' },
    })) as any

    const last4: string | null = settings?.paymentMethodLast4 ?? null

    return NextResponse.json({
      configured: isStripeConfigured(),
      testMode: isStripeTestMode(),
      status: settings?.billingStatus ?? 'none',
      billingEmail: settings?.billingEmail ?? null,
      card: last4
        ? { brand: settings?.paymentMethodBrand ?? null, last4 }
        : null,
      nextBillingAt: settings?.nextBillingAt ?? null,
      lastInvoice: settings?.lastInvoiceId
        ? {
            id: settings.lastInvoiceId,
            amount: settings.lastInvoiceAmount ?? null,
            status: settings.lastInvoiceStatus ?? null,
            at: settings.lastChargedAt ?? null,
          }
        : null,
    })
  } catch (err) {
    logError('[billing/status]', err)
    return NextResponse.json(
      { error: 'Failed to load billing status.' },
      { status: 500 },
    )
  }
}
