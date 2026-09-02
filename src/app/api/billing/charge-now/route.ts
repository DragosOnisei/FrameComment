import { NextRequest, NextResponse } from 'next/server'
import { requireApiManageSettings } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getStripe } from '@/lib/stripe'
import { chargeInstance, evaluateBillingHealth } from '@/lib/billing'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.4.3: POST /api/billing/charge-now — charge the card on file for the
 * CURRENT usage, unconditionally minting a fresh invoice.
 *
 * Built 2026-09-02, when the September invoice under-collected ($392.70
 * against a Billing page showing $574.30 — the old average-over-the-period
 * bug, fixed the same release): the wrong payment was refunded in the
 * Stripe dashboard and this route re-collected the correct amount. KEPT
 * afterwards on purpose — re-collecting a refunded month will happen again.
 * 7.4.4: the "Retry payment" button that calls this is hidden by default;
 * it renders only when the Billing page is opened with ?retry-payment=1
 * (an accidental press would double-charge, so it stays out of sight).
 *
 * This deliberately does NOT reuse /api/billing/retry: retry short-circuits
 * with "Invoice is already paid" when the last invoice is paid — and a
 * refunded invoice still reads paid in Stripe, so retry would refuse
 * exactly the situation this exists for.
 *
 * The amount is whatever computeCurrentBillable says at this moment — the
 * number on the Billing pane — and chargeInstance's verification gate
 * checks the draft line-by-line before any money moves, same as the
 * monthly cycle. The regular billing anchor (nextBillingAt) is untouched.
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiManageSettings(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 3, message: 'Too many charge attempts. Please wait a moment.' },
    'billing-charge-now',
  )
  if (limited) return limited

  const stripe = getStripe()
  if (!stripe) {
    return NextResponse.json({ error: 'Stripe is not configured on this server.' }, { status: 400 })
  }

  try {
    const result = await chargeInstance()
    if (result.ok) {
      await evaluateBillingHealth().catch(() => {})
      logMessage(`[billing/charge-now] ${result.message} (invoice ${result.invoiceId ?? 'n/a'})`)
      return NextResponse.json({ ok: true, message: result.message })
    }
    // Same 3DS handling as the dunning retry: when the bank demands
    // authentication, hand back the hosted invoice page so the admin can
    // complete the challenge; the invoice.paid webhook reconciles state.
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
    logError('[billing/charge-now] failed:', err)
    return NextResponse.json({ error: 'Charge failed. Please try again.' }, { status: 500 })
  }
}
