import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { logError, logMessage } from '@/lib/logging'

/**
 * 3.7.0+: usage-based billing.
 *
 * Pricing lives here as the single source of truth (the /usage route +
 * the monthly invoice both read it):
 *   $25.00 / user / month
 *   $0.10  / GiB  / month   (storage counts EVERYTHING the app holds,
 *                            including soft-deleted projects in Trash)
 *
 * Money model: one card saved on file (via Stripe Checkout setup), then
 * a Stripe Invoice generated + charged automatically each month for the
 * computed total. Amounts vary month to month, which is exactly why we
 * bill via a fresh invoice each cycle rather than a fixed subscription.
 */

export const BILLING_PRICING = {
  currency: 'usd',
  perUserPerMonth: 25, // dollars
  perGibPerMonth: 0.1, // dollars
  perUserPerMonthCents: 2500,
  perGibPerMonthCents: 10,
} as const

const BYTES_PER_GIB = 1024 ** 3

export interface BillingUsage {
  userCount: number
  storageBytes: number
}

/**
 * Running totals that drive both the Billing pane and the monthly
 * invoice. Storage sums the three places the app keeps bytes:
 *   - Video.originalFileSize  (the master uploads — the bulk)
 *   - VideoAsset.fileSize      (comment attachments, project files…)
 *   - ProjectUpload.fileSize   (reverse-share / client uploads)
 * Users = every row in the User table. Both include Trash on purpose.
 */
export async function computeBillingUsage(): Promise<BillingUsage> {
  const [userCount, videoSum, videoAssetSum, projectUploadSum] =
    await Promise.all([
      prisma.user.count(),
      prisma.video.aggregate({ _sum: { originalFileSize: true } }),
      prisma.videoAsset.aggregate({ _sum: { fileSize: true } }),
      prisma.projectUpload.aggregate({ _sum: { fileSize: true } }),
    ])

  const masterBytes = videoSum._sum.originalFileSize
    ? Number(videoSum._sum.originalFileSize)
    : 0
  const assetBytes = videoAssetSum._sum.fileSize
    ? Number(videoAssetSum._sum.fileSize)
    : 0
  const uploadBytes = projectUploadSum._sum.fileSize
    ? Number(projectUploadSum._sum.fileSize)
    : 0

  return {
    userCount,
    storageBytes: masterBytes + assetBytes + uploadBytes,
  }
}

/** The two invoice line items (in cents) for a usage snapshot. */
export function computeLineItems(usage: BillingUsage) {
  const gib = usage.storageBytes / BYTES_PER_GIB
  const userCents = usage.userCount * BILLING_PRICING.perUserPerMonthCents
  // $0.10/GiB → 10 cents × GiB, rounded to the nearest cent.
  const storageCents = Math.round(gib * BILLING_PRICING.perGibPerMonthCents)
  return {
    gib,
    userCents,
    storageCents,
    totalCents: userCents + storageCents,
  }
}

/**
 * Next monthly charge date. We add one calendar month and clamp the
 * day to ≤ 28 so a card connected on the 31st doesn't skip February.
 */
export function addOneMonth(from: Date): Date {
  const d = new Date(from)
  const day = Math.min(d.getUTCDate(), 28)
  d.setUTCDate(1) // avoid rollover while we change the month
  d.setUTCMonth(d.getUTCMonth() + 1)
  d.setUTCDate(day)
  return d
}

/**
 * Run one billing cycle for the singleton instance IF it's due.
 * Idempotent-ish: bumps nextBillingAt after each attempt so a crash
 * mid-cycle won't double-charge on the very next minute (the worker
 * calls this every minute). Safe no-op when Stripe/billing isn't set
 * up. Returns a short status string for logs.
 */
export interface ChargeResult {
  ok: boolean
  message: string
  invoiceId?: string
  amountCents?: number
}

/**
 * Charge the instance for its CURRENT usage right now: build the two
 * invoice line items, create + finalize a Stripe invoice, and pay it
 * off-session on the saved default card. Used by both the monthly cycle
 * and the (test-mode-only) "Test charge now" button. Requires a Stripe
 * customer with a default payment method (i.e. a card was connected).
 */
export async function chargeInstance(): Promise<ChargeResult> {
  const stripe = getStripe()
  if (!stripe) return { ok: false, message: 'Stripe is not configured.' }

  const settings = (await prisma.settings.findUnique({
    where: { id: 'default' },
  })) as any
  const customerId: string | null = settings?.stripeCustomerId ?? null
  if (!customerId) {
    return { ok: false, message: 'No card connected yet.' }
  }

  try {
    const usage = await computeBillingUsage()
    const { gib, userCents, storageCents, totalCents } = computeLineItems(usage)

    if (totalCents <= 0) {
      return { ok: true, message: 'Total is $0 — nothing to charge.', amountCents: 0 }
    }

    // Pending invoice items auto-attach to the next invoice we create.
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: userCents,
      currency: BILLING_PRICING.currency,
      description: `Users — ${usage.userCount} × $${BILLING_PRICING.perUserPerMonth.toFixed(2)}`,
    })
    if (storageCents > 0) {
      await stripe.invoiceItems.create({
        customer: customerId,
        amount: storageCents,
        currency: BILLING_PRICING.currency,
        description: `Storage — ${gib.toFixed(2)} GB × $${BILLING_PRICING.perGibPerMonth.toFixed(2)}/GB`,
      })
    }

    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'charge_automatically',
      auto_advance: false,
      description: 'FrameComment usage',
    })
    const invoiceId = invoice.id as string
    await stripe.invoices.finalizeInvoice(invoiceId)
    // Charge the customer's default payment method off-session.
    const paid = await stripe.invoices.pay(invoiceId)

    await prisma.settings.update({
      where: { id: 'default' },
      data: {
        lastInvoiceId: invoiceId,
        lastInvoiceAmount: totalCents,
        lastInvoiceStatus: paid.status ?? 'paid',
        lastChargedAt: new Date(),
        billingStatus: paid.status === 'paid' ? 'active' : 'past_due',
      } as any,
    })
    logMessage(
      `[billing] charged ${(totalCents / 100).toFixed(2)} ${BILLING_PRICING.currency} (invoice ${invoiceId})`,
    )
    return {
      ok: true,
      message: `Charged $${(totalCents / 100).toFixed(2)}`,
      invoiceId,
      amountCents: totalCents,
    }
  } catch (err) {
    // Payment/charge failed — mark past_due. Webhooks also reconcile.
    logError('[billing] charge failed:', err)
    await prisma.settings
      .update({
        where: { id: 'default' },
        data: { billingStatus: 'past_due' } as any,
      })
      .catch(() => {})
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Charge failed.',
    }
  }
}

/**
 * Run one billing cycle for the singleton instance IF it's due.
 * Advances nextBillingAt BEFORE charging so a crash mid-cycle won't
 * double-charge on the next minute (the worker calls this every
 * minute). Safe no-op when Stripe/billing isn't set up.
 */
export async function runBillingCycleIfDue(): Promise<string> {
  const stripe = getStripe()
  if (!stripe) return 'skip: stripe not configured'

  const settings = (await prisma.settings.findUnique({
    where: { id: 'default' },
  })) as any
  if (!settings) return 'skip: no settings'

  const customerId: string | null = settings.stripeCustomerId ?? null
  const status: string = settings.billingStatus ?? 'none'
  const nextAt: Date | null = settings.nextBillingAt ?? null

  if (!customerId) return 'skip: no customer'
  if (status === 'none') return 'skip: not active'
  if (!nextAt || new Date(nextAt).getTime() > Date.now()) return 'skip: not due'

  // Advance the anchor first (idempotency against per-minute retries).
  await prisma.settings.update({
    where: { id: 'default' },
    data: { nextBillingAt: addOneMonth(new Date(nextAt)) } as any,
  })

  const result = await chargeInstance()
  return result.ok ? `ok: ${result.message}` : `error: ${result.message}`
}
