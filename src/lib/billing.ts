import type Stripe from 'stripe'
import { prisma } from '@/lib/db'
import { getStripe } from '@/lib/stripe'
import { logError, logMessage } from '@/lib/logging'
import { legacyBackend } from '@/lib/storage-backends'

// Stripe types `unit_amount_decimal` / `quantity_decimal` as a branded
// `Decimal`, but the API accepts a plain numeric string ("2500" cents,
// "1.53" quantity). Small helper to satisfy the type without casts.
const decimal = (value: number) =>
  String(value) as unknown as Stripe.Decimal

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

/** Free allowance — usage up to this is always free and needs no card.
 *  Billing SUBTRACTS it: you pay only for users/GB ABOVE the tier. */
export const FREE_TIER = { users: 1, gib: 10 } as const

/** Grace window (business days) before an unresolved billing issue
 *  suspends the admin. */
export const GRACE_BUSINESS_DAYS = 5

const BYTES_PER_GIB = 1024 ** 3

export interface BillingUsage {
  userCount: number
  storageBytes: number
}

/**
 * 4.2.0+ (Phase 3): Prisma `where` matching files physically stored on the
 * FrameComment Server backend ('fc'). Per-GB storage is billed ONLY for these
 * — Local / R2 / AWS are the customer's own storage and cost per user only.
 *
 * A file counts as fc when its storageBackend is 'fc', OR its storageLocations
 * list contains 'fc' (kept on fc after a transfer), OR — on an instance whose
 * legacy env backend is fc (STORAGE_PROVIDER=s3) — its storageBackend is NULL
 * (pre-4.2.0 rows that resolve to fc).
 */
export function fcStorageWhere(): any {
  const or: any[] = [
    { storageBackend: 'fc' },
    { storageLocations: { contains: 'fc' } },
  ]
  if (legacyBackend() === 'fc') or.push({ storageBackend: null })
  return { OR: or }
}

/**
 * Running totals that drive both the Billing pane and the monthly invoice.
 *
 * Storage counts ONLY bytes stored on the FrameComment Server backend (see
 * fcStorageWhere) across the three places the app keeps bytes:
 *   - Video.originalFileSize  (the master uploads — the bulk)
 *   - VideoAsset.fileSize      (comment attachments, project files…)
 *   - ProjectUpload.fileSize   (reverse-share / client uploads)
 * Local/R2/AWS bytes are the customer's own and are NOT billed per-GB.
 * Users = every row in the User table (always billed per-user). Both include
 * Trash on purpose. `(prisma as any)` so a stale generated client (missing the
 * storageBackend/storageLocations fields) still accepts the where filter.
 */
export async function computeBillingUsage(): Promise<BillingUsage> {
  const where = fcStorageWhere()
  const [userCount, videoSum, videoAssetSum, projectUploadSum] =
    await Promise.all([
      prisma.user.count(),
      (prisma as any).video.aggregate({ _sum: { originalFileSize: true }, where }),
      (prisma as any).videoAsset.aggregate({ _sum: { fileSize: true }, where }),
      (prisma as any).projectUpload.aggregate({ _sum: { fileSize: true }, where }),
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

/** Total storage across ALL backends (display context in the Billing pane —
 *  what the customer holds vs. what is actually billed per-GB). */
export async function computeTotalStorageBytes(): Promise<number> {
  const [videoSum, videoAssetSum, projectUploadSum] = await Promise.all([
    prisma.video.aggregate({ _sum: { originalFileSize: true } }),
    prisma.videoAsset.aggregate({ _sum: { fileSize: true } }),
    prisma.projectUpload.aggregate({ _sum: { fileSize: true } }),
  ])
  const master = videoSum._sum.originalFileSize ? Number(videoSum._sum.originalFileSize) : 0
  const asset = videoAssetSum._sum.fileSize ? Number(videoAssetSum._sum.fileSize) : 0
  const upload = projectUploadSum._sum.fileSize ? Number(projectUploadSum._sum.fileSize) : 0
  return master + asset + upload
}

export interface BillableBreakdown {
  avgUsers: number
  avgGiB: number
  billableUsers: number
  billableGiB: number
  userCents: number
  storageCents: number
  totalCents: number
}

/** Apply the free-tier allowance to (averaged) usage and price it. Only
 *  users/GB ABOVE the free tier are billed. Quantities can be fractional
 *  (a period average), which the invoice renders via `quantity_decimal`
 *  — e.g. "1.53 × $25.00". */
export function computeBillable(
  avgUsers: number,
  avgStorageBytes: number,
): BillableBreakdown {
  const avgGiB = avgStorageBytes / BYTES_PER_GIB
  const billableUsers = Math.max(0, avgUsers - FREE_TIER.users)
  const billableGiB = Math.max(0, avgGiB - FREE_TIER.gib)
  const userCents = Math.round(
    billableUsers * BILLING_PRICING.perUserPerMonthCents,
  )
  const storageCents = Math.round(
    billableGiB * BILLING_PRICING.perGibPerMonthCents,
  )
  return {
    avgUsers,
    avgGiB,
    billableUsers,
    billableGiB,
    userCents,
    storageCents,
    totalCents: userCents + storageCents,
  }
}

/** True when CURRENT usage exceeds the free tier → a card is required. */
export function isOverFreeTier(usage: BillingUsage): boolean {
  return (
    usage.userCount > FREE_TIER.users ||
    usage.storageBytes / BYTES_PER_GIB > FREE_TIER.gib
  )
}

/** Record today's usage snapshot once per calendar day (idempotent —
 *  the unique(day) index + create-if-missing guards double inserts). */
export async function recordDailySnapshotIfNeeded(): Promise<void> {
  const day = new Date()
  day.setUTCHours(0, 0, 0, 0)
  const existing = await (prisma as any).billingSnapshot
    .findUnique({ where: { day } })
    .catch(() => null)
  if (existing) return
  const usage = await computeBillingUsage()
  await (prisma as any).billingSnapshot
    .create({
      data: {
        day,
        userCount: usage.userCount,
        storageBytes: BigInt(Math.round(usage.storageBytes)),
      },
    })
    .catch(() => {}) // ignore unique-violation race
}

/** Average user count + storage bytes over the daily snapshots on/after
 *  `since`. Falls back to current usage when no snapshots exist yet. */
export async function computeAveragedUsage(
  since: Date,
): Promise<{ avgUsers: number; avgStorageBytes: number; days: number }> {
  const sinceDay = new Date(since)
  sinceDay.setUTCHours(0, 0, 0, 0)
  const snaps: Array<{ userCount: number; storageBytes: bigint }> =
    await (prisma as any).billingSnapshot
      .findMany({ where: { day: { gte: sinceDay } } })
      .catch(() => [])
  if (!snaps.length) {
    const usage = await computeBillingUsage()
    return {
      avgUsers: usage.userCount,
      avgStorageBytes: usage.storageBytes,
      days: 0,
    }
  }
  const totalUsers = snaps.reduce((s, r) => s + r.userCount, 0)
  const totalBytes = snaps.reduce((s, r) => s + Number(r.storageBytes), 0)
  return {
    avgUsers: totalUsers / snaps.length,
    avgStorageBytes: totalBytes / snaps.length,
    days: snaps.length,
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
    // Prorate: average usage over the period since the last charge,
    // then subtract the free tier — only the excess is billed.
    const periodStart = settings.lastChargedAt
      ? new Date(settings.lastChargedAt)
      : new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    const avg = await computeAveragedUsage(periodStart)
    const bill = computeBillable(avg.avgUsers, avg.avgStorageBytes)
    const totalCents = bill.totalCents

    if (totalCents <= 0) {
      // Within the free tier for the whole period — nothing to charge.
      return {
        ok: true,
        message: 'Within free tier — nothing to charge.',
        amountCents: 0,
      }
    }

    // Create the invoice FIRST, then attach the line items to it
    // EXPLICITLY via `invoice: invoiceId`. Relying on Stripe's
    // "pending invoice items auto-attach on invoice creation" produced
    // $0 invoices on this account's API version — the items weren't
    // pulled in. Attaching to the specific invoice id is reliable.
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'charge_automatically',
      auto_advance: false,
      description: 'FrameComment usage',
    })
    const invoiceId = invoice.id as string

    // Users above the free tier. `quantity_decimal` carries the
    // fractional period-average → invoice shows e.g. "1.53 × $25.00".
    if (bill.billableUsers > 0) {
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoiceId,
        quantity_decimal: decimal(Number(bill.billableUsers.toFixed(6))),
        unit_amount_decimal: decimal(BILLING_PRICING.perUserPerMonthCents),
        currency: BILLING_PRICING.currency,
        description: `Users over free tier (${FREE_TIER.users} free)`,
      })
    }
    // Storage GB above the free tier × $0.10.
    if (bill.billableGiB > 0) {
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoiceId,
        quantity_decimal: decimal(Number(bill.billableGiB.toFixed(4))),
        unit_amount_decimal: decimal(BILLING_PRICING.perGibPerMonthCents),
        currency: BILLING_PRICING.currency,
        description: `Storage GB over free tier (${FREE_TIER.gib} GB free)`,
      })
    }
    // Finalizing a `charge_automatically` invoice that has a default
    // card makes Stripe attempt payment IMMEDIATELY — so the invoice
    // may already be 'paid' by the time finalize returns. Only call
    // pay() if it's still open, and treat an "already paid" race as the
    // success it is (previously this surfaced a bogus "Invoice is
    // already paid" error even though the charge went through).
    const finalized = await stripe.invoices.finalizeInvoice(invoiceId)
    let invoiceObj = finalized
    if (finalized.status !== 'paid') {
      try {
        invoiceObj = await stripe.invoices.pay(invoiceId)
      } catch (payErr) {
        const fresh = await stripe.invoices.retrieve(invoiceId)
        if (fresh.status !== 'paid') throw payErr
        invoiceObj = fresh
      }
    }
    const wasPaid = invoiceObj.status === 'paid'

    await prisma.settings.update({
      where: { id: 'default' },
      data: {
        lastInvoiceId: invoiceId,
        lastInvoiceAmount: totalCents,
        lastInvoiceStatus: invoiceObj.status ?? 'paid',
        lastChargedAt: new Date(),
        billingStatus: wasPaid ? 'active' : 'past_due',
      } as any,
    })
    logMessage(
      `[billing] invoice ${invoiceId} → ${invoiceObj.status} (${(totalCents / 100).toFixed(2)} ${BILLING_PRICING.currency})`,
    )
    return {
      ok: wasPaid,
      message: wasPaid
        ? `Charged $${(totalCents / 100).toFixed(2)}`
        : `Invoice ${invoiceObj.status}`,
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

/** Whole business days (Mon–Fri) elapsed between two dates. */
export function businessDaysBetween(from: Date, to: Date): number {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  let count = 0
  while (d < end) {
    d.setDate(d.getDate() + 1)
    const wd = d.getDay()
    if (wd !== 0 && wd !== 6) count++
  }
  return count
}

/**
 * Dunning state machine. An "issue" is either a failed payment
 * (past_due) OR being over the free tier with no card connected. When
 * an issue starts we stamp `billingIssueSince`; once it's unresolved
 * for GRACE_BUSINESS_DAYS the admin is suspended (billing wall). Both
 * flags clear the moment the issue resolves (card added + paid, or
 * usage drops back under the free tier). Idempotent — safe to run
 * every day and on demand from the status endpoint.
 */
export async function evaluateBillingHealth(): Promise<void> {
  const settings = (await prisma.settings.findUnique({
    where: { id: 'default' },
  })) as any
  if (!settings) return

  const usage = await computeBillingUsage()
  const overTier = isOverFreeTier(usage)
  const hasCard = !!settings.paymentMethodLast4
  const pastDue = settings.billingStatus === 'past_due'
  const hasIssue = pastDue || (overTier && !hasCard)

  const issueSince: Date | null = settings.billingIssueSince ?? null
  const suspended: boolean = !!settings.billingSuspended

  if (!hasIssue) {
    // Resolved — clear the clock + lift any suspension.
    if (issueSince || suspended) {
      await prisma.settings.update({
        where: { id: 'default' },
        data: { billingIssueSince: null, billingSuspended: false } as any,
      })
    }
    return
  }

  if (!issueSince) {
    // Start the grace clock.
    await prisma.settings.update({
      where: { id: 'default' },
      data: { billingIssueSince: new Date() } as any,
    })
    return
  }

  if (
    !suspended &&
    businessDaysBetween(new Date(issueSince), new Date()) >= GRACE_BUSINESS_DAYS
  ) {
    await prisma.settings.update({
      where: { id: 'default' },
      data: { billingSuspended: true } as any,
    })
    logMessage(
      '[billing] admin suspended — billing unresolved > 5 business days',
    )
  }
}
