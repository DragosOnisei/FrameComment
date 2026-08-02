import { NextRequest, NextResponse } from 'next/server'
import { prisma, orgSettingsWhere } from '@/lib/db'
import { requireApiManageSettings } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getStripe } from '@/lib/stripe'
import { chargeInstance, evaluateBillingHealth } from '@/lib/billing'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.7.1: POST /api/billing/retry — retry a failed monthly payment.
 *
 * Strategy (double-charge safe):
 *  1. If the LAST invoice is still OPEN in Stripe → pay THAT invoice (never
 *     mint a new one while an open one exists).
 *  2. If paying fails because the bank wants authentication (3DS/SCA — the
 *     usual reason an off-session charge dies), return the invoice's
 *     hosted payment page URL so the admin can complete it interactively.
 *  3. If the last invoice is gone/void/uncollectible → fall back to a fresh
 *     `chargeInstance()` for the period (same code path as the monthly run).
 *
 * On success the local billing state flips back to active and the dunning
 * clock clears (evaluateBillingHealth).
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiManageSettings(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 5, message: 'Too many retries. Please wait a moment.' },
    'billing-retry',
  )
  if (limited) return limited

  const stripe = getStripe()
  if (!stripe) {
    return NextResponse.json({ error: 'Stripe is not configured on this server.' }, { status: 400 })
  }

  try {
    const settings = (await prisma.settings.findUnique({
      where: orgSettingsWhere(),
    })) as any
    const customerId: string | null = settings?.stripeCustomerId ?? null
    if (!customerId) {
      return NextResponse.json({ error: 'No card connected yet.' }, { status: 400 })
    }

    const lastInvoiceId: string | null = settings?.lastInvoiceId ?? null
    let invoice = null as any
    if (lastInvoiceId) {
      invoice = await stripe.invoices.retrieve(lastInvoiceId).catch(() => null)
    }

    // Case 1: the failed invoice is still OPEN — pay exactly that one.
    if (invoice && invoice.status === 'open') {
      try {
        invoice = await stripe.invoices.pay(lastInvoiceId as string)
      } catch (payErr) {
        const fresh = await stripe.invoices.retrieve(lastInvoiceId as string).catch(() => null)
        if (fresh?.status === 'paid') {
          invoice = fresh // race: it actually went through
        } else {
          // Most common cause: the bank requires authentication (SCA/3DS),
          // which an off-session charge can't satisfy. Hand back the hosted
          // invoice page — paying there lets the admin complete the bank
          // challenge; the invoice.paid webhook then reconciles our state.
          const hostedUrl = fresh?.hosted_invoice_url ?? invoice?.hosted_invoice_url ?? null
          logError('[billing/retry] pay failed:', payErr)
          return NextResponse.json(
            {
              ok: false,
              requiresAction: !!hostedUrl,
              hostedInvoiceUrl: hostedUrl,
              error:
                payErr instanceof Error
                  ? payErr.message
                  : 'Payment failed. Your bank may require authentication.',
            },
            { status: 402 },
          )
        }
      }

      if (invoice.status === 'paid') {
        await prisma.settings
          .update({
            where: orgSettingsWhere(),
            data: {
              lastInvoiceStatus: 'paid',
              lastInvoiceAmount: invoice.amount_paid,
              lastChargedAt: new Date(),
              billingStatus: 'active',
            } as any,
          })
          .catch(() => {})
        await evaluateBillingHealth().catch(() => {})
        logMessage(`[billing/retry] invoice ${lastInvoiceId} paid on retry`)
        return NextResponse.json({
          ok: true,
          message: `Payment succeeded ($${((invoice.amount_paid ?? 0) / 100).toFixed(2)}).`,
        })
      }
    }

    // Already settled meanwhile (webhook raced us)?
    if (invoice && invoice.status === 'paid') {
      await evaluateBillingHealth().catch(() => {})
      return NextResponse.json({ ok: true, message: 'Invoice is already paid.' })
    }

    // Case 3: no payable invoice on file — run a fresh charge for the period
    // (exactly what the monthly cycle would do).
    const result = await chargeInstance()
    if (result.ok) {
      await evaluateBillingHealth().catch(() => {})
      return NextResponse.json({ ok: true, message: result.message })
    }
    let hostedUrl: string | null = null
    if (result.invoiceId) {
      const inv = await stripe.invoices.retrieve(result.invoiceId).catch(() => null)
      hostedUrl = inv?.hosted_invoice_url ?? null
    }
    return NextResponse.json(
      {
        ok: false,
        requiresAction: !!hostedUrl,
        hostedInvoiceUrl: hostedUrl,
        error: result.message,
      },
      { status: 402 },
    )
  } catch (err) {
    logError('[billing/retry] failed:', err)
    return NextResponse.json({ error: 'Retry failed. Please try again.' }, { status: 500 })
  }
}
