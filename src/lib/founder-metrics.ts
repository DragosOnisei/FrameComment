/**
 * 6.5.0 Founder dashboard — platform-wide metrics.
 *
 * Every number here is computed from data the app already stores; nothing is
 * estimated or padded. Where a figure is genuinely partial (invoice history
 * lives in Stripe, not locally) the shape says so instead of pretending.
 *
 * Reads go through `prismaPrivileged` on purpose: this is the one surface that
 * legitimately crosses tenant boundaries, and it is reachable only behind
 * `requirePlatformAdmin`. The platform's own organization is excluded from
 * customer and revenue figures — it is the operator, not a customer.
 */

import { prismaPrivileged } from './db'
import { platformOrgId } from './platform'
import { BILLING_PRICING, FREE_TIER, computeBillable, fcStorageWhere } from './billing'

export interface FounderMetrics {
  range: { from: string; to: string }
  companies: {
    total: number
    active: number
    suspended: number
    newInRange: number
    /** Card on file AND billing active — i.e. actually chargeable today. */
    paying: number
    /** Usage above the free tier, so the next invoice is > $0. */
    onPaidTier: number
    onFreeTier: number
  }
  users: { total: number; newInRange: number }
  revenue: {
    /** Sum of what every active company would be invoiced today, in cents. */
    mrrCents: number
    /** The same figure split by what actually drives it, so the dashboard can
     *  say "$X from seats, $Y from storage" instead of one opaque number. */
    mrrUserCents: number
    mrrStorageCents: number
    /** Billable quantities behind the split (free tier already subtracted). */
    billableUsers: number
    billableGiB: number
    /** Cents actually invoiced inside the range, from the last invoice we
     *  recorded per company. Partial by construction — see `revenueNote`. */
    invoicedInRangeCents: number
    revenueNote: string
    currency: string
    /** Published pricing + free allowance, so the UI never hardcodes them. */
    pricing: {
      perUserPerMonthCents: number
      perGibPerMonthCents: number
      freeUsers: number
      freeGib: number
    }
  }
  storage: { totalBytes: number; billableBytes: number }
  activity: {
    uploads: number
    comments: number
    projectsCreated: number
  }
  /** History for the chart, from the daily billing snapshots. Sparse by
   *  nature: a company is snapshotted only on days its billing was read. The
   *  headline figures above are measured live instead. */
  series: Array<{ day: string; users: number; storageBytes: number; mrrCents: number }>
  companiesTable: Array<{
    id: string
    name: string
    createdAt: string
    status: string
    users: number
    storageBytes: number
    billingStatus: string
    hasCard: boolean
    lastInvoiceCents: number | null
    lastChargedAt: string | null
    estimatedMonthlyCents: number
    /** Where the estimate comes from, per company. */
    estimatedUserCents: number
    estimatedStorageCents: number
    billableUsers: number
    billableGiB: number
    /** 'paid' = usage above the free allowance, so it gets an invoice.
     *  'free' = inside the allowance, nothing to charge. This is about the
     *  PLAN, not about whether a card is attached — `hasCard`/`billingStatus`
     *  still carry that, and the UI flags a paid company with no card. */
    tier: 'free' | 'paid'
    /**
     * 6.25.0 — the departure, when there is one.
     *
     * `deletionScheduledAt` is the moment the data is wiped, not the moment it
     * was requested: the 30-day grace is already baked into the stored value,
     * so days-remaining is a plain subtraction from now — the same arithmetic
     * the tenant's own countdown banner uses, deliberately, so the two can
     * never disagree about how long is left.
     */
    deletionScheduledAt: string | null
    deletionReason: string | null
    /** Who to call: the account holder now, and who pressed the button. */
    ownerEmail: string | null
    ownerName: string | null
    deletionRequestedByEmail: string | null
  }>
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function computeFounderMetrics(
  from: Date,
  to: Date,
): Promise<FounderMetrics> {
  // ── Companies ────────────────────────────────────────────────────────────
  // `isPlatform: false` is the filter; the id is a belt-and-braces guard for a
  // database where the flag was never set (e.g. a restore from before Faza 0).
  const platformId = platformOrgId()
  const orgs = (await (prismaPrivileged as any).organization.findMany({
    where: { isPlatform: false, id: { not: platformId } },
    select: {
      id: true, name: true, status: true, createdAt: true,
      // 6.25.0: a company on its way out looked exactly like a healthy one in
      // this table — same row, same revenue, no hint that it will be gone in a
      // fortnight. Since the countdown is a chance to save the account, the
      // dashboard has to be the place it is noticed.
      deletionScheduledAt: true, deletionRequestedById: true, deletionReason: true,
    },
    orderBy: { createdAt: 'asc' },
  })) as Array<{
    id: string; name: string; status: string; createdAt: Date
    deletionScheduledAt: Date | null
    deletionRequestedById: string | null
    deletionReason: string | null
  }>

  /*
   * Who to call.
   *
   * Two lookups rather than a join, because `deletionRequestedById` is a bare
   * String with no relation — and only for companies that are actually leaving,
   * so a platform with a thousand tenants and no departures pays nothing.
   *
   * The owner is resolved separately from the requester: they are usually the
   * same person, but ownership can have moved since, and the person worth
   * calling is whoever holds the account now.
   */
  const leavingOrgs = orgs.filter((o) => o.deletionScheduledAt)
  const contactByOrg = new Map<string, { ownerEmail: string | null; ownerName: string | null; requestedByEmail: string | null }>()
  if (leavingOrgs.length > 0) {
    const owners = (await (prismaPrivileged as any).user.findMany({
      where: { organizationId: { in: leavingOrgs.map((o) => o.id) }, role: 'OWNER' },
      select: { id: true, email: true, name: true, organizationId: true, createdAt: true },
      // Oldest wins: an ownership transfer leaves two OWNER rows for its 30-day
      // grace window, and the original holder is the account of record.
      orderBy: { createdAt: 'asc' },
    })) as Array<{ id: string; email: string; name: string | null; organizationId: string; createdAt: Date }>

    const requesterIds = leavingOrgs.map((o) => o.deletionRequestedById).filter(Boolean) as string[]
    const requesters = requesterIds.length
      ? ((await (prismaPrivileged as any).user.findMany({
          where: { id: { in: requesterIds } },
          select: { id: true, email: true },
        })) as Array<{ id: string; email: string }>)
      : []
    const requesterEmail = new Map(requesters.map((u) => [u.id, u.email]))

    for (const org of leavingOrgs) {
      const owner = owners.find((u) => u.organizationId === org.id) || null
      contactByOrg.set(org.id, {
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.name ?? null,
        requestedByEmail: org.deletionRequestedById
          ? requesterEmail.get(org.deletionRequestedById) ?? null
          : null,
      })
    }
  }

  const orgIds = orgs.map((o) => o.id)
  const activeOrgs = orgs.filter((o) => o.status === 'ACTIVE')

  // ── Settings (billing + card state) per company ───────────────────────────
  const settingsRows = (await (prismaPrivileged as any).settings.findMany({
    where: { organizationId: { in: orgIds } },
    select: {
      organizationId: true,
      billingStatus: true,
      paymentMethodLast4: true,
      lastInvoiceAmount: true,
      lastInvoiceStatus: true,
      lastChargedAt: true,
      billingSuspended: true,
    },
  })) as Array<{
    organizationId: string | null
    billingStatus: string | null
    paymentMethodLast4: string | null
    lastInvoiceAmount: number | null
    lastInvoiceStatus: string | null
    lastChargedAt: Date | null
    billingSuspended: boolean | null
  }>
  const settingsByOrg = new Map(settingsRows.map((s) => [s.organizationId ?? '', s]))

  const paying = settingsRows.filter(
    (s) => !!s.paymentMethodLast4 && s.billingStatus === 'active',
  ).length

  // ── Users ────────────────────────────────────────────────────────────────
  const [userTotal, newUsers, usersByOrg] = await Promise.all([
    (prismaPrivileged as any).user.count({ where: { organizationId: { in: orgIds } } }),
    (prismaPrivileged as any).user.count({
      where: { organizationId: { in: orgIds }, createdAt: { gte: from, lte: to } },
    }),
    (prismaPrivileged as any).user.groupBy({
      by: ['organizationId'],
      where: { organizationId: { in: orgIds } },
      _count: { id: true },
    }) as Promise<Array<{ organizationId: string | null; _count: { id: number } }>>,
  ])
  const userCountByOrg = new Map(
    usersByOrg.map((r) => [r.organizationId ?? '', r._count.id]),
  )

  // ── Storage: the same three tables billing sums, but platform-wide ───────
  const [videoBytes, assetBytes, uploadBytes, docBytes] = await Promise.all([
    (prismaPrivileged as any).video.aggregate({
      where: { organizationId: { in: orgIds } },
      _sum: { originalFileSize: true },
    }),
    (prismaPrivileged as any).videoAsset.aggregate({
      where: { organizationId: { in: orgIds } },
      _sum: { fileSize: true },
    }),
    (prismaPrivileged as any).projectUpload.aggregate({
      where: { organizationId: { in: orgIds } },
      _sum: { fileSize: true },
    }),
    (prismaPrivileged as any).folderDocument.aggregate({
      where: { organizationId: { in: orgIds } },
      _sum: { size: true },
    }),
  ])
  const totalBytes =
    Number(videoBytes?._sum?.originalFileSize ?? 0) +
    Number(assetBytes?._sum?.fileSize ?? 0) +
    Number(uploadBytes?._sum?.fileSize ?? 0) +
    Number(docBytes?._sum?.size ?? 0)

  // ── Current billable usage, measured live ────────────────────────────────
  //
  // 6.7.0 — this used to read the latest BillingSnapshot, and it was wrong.
  // Snapshots are written by `recordDailySnapshotIfNeeded`, which only runs
  // when a company's billing status is READ. A customer who hasn't opened
  // their Billing pane in weeks has a weeks-old snapshot, so the founder
  // dashboard reported $6 of storage for a company whose own Billing pane
  // said $270. The dashboard now measures the same thing the invoice will:
  // current fc-backend bytes and current user count, per company.
  //
  // Snapshots keep exactly one job: the historical series for the chart.
  const fcScope = { AND: [fcStorageWhere(), { organizationId: { in: orgIds } }] }
  const [fcVideos, fcAssets, fcUploads] = await Promise.all([
    (prismaPrivileged as any).video.groupBy({
      by: ['organizationId'],
      where: fcScope,
      _sum: { originalFileSize: true },
    }) as Promise<Array<{ organizationId: string | null; _sum: { originalFileSize: bigint | null } }>>,
    (prismaPrivileged as any).videoAsset.groupBy({
      by: ['organizationId'],
      where: fcScope,
      _sum: { fileSize: true },
    }) as Promise<Array<{ organizationId: string | null; _sum: { fileSize: bigint | null } }>>,
    (prismaPrivileged as any).projectUpload.groupBy({
      by: ['organizationId'],
      where: fcScope,
      _sum: { fileSize: true },
    }) as Promise<Array<{ organizationId: string | null; _sum: { fileSize: bigint | null } }>>,
  ])

  const fcBytesByOrg = new Map<string, number>()
  const addBytes = (orgId: string | null, n: number) => {
    const key = orgId ?? ''
    fcBytesByOrg.set(key, (fcBytesByOrg.get(key) ?? 0) + n)
  }
  for (const r of fcVideos) addBytes(r.organizationId, Number(r._sum.originalFileSize ?? 0))
  for (const r of fcAssets) addBytes(r.organizationId, Number(r._sum.fileSize ?? 0))
  for (const r of fcUploads) addBytes(r.organizationId, Number(r._sum.fileSize ?? 0))

  const usageByOrg = new Map<string, { userCount: number; storageBytes: number }>()
  for (const org of orgs) {
    usageByOrg.set(org.id, {
      userCount: userCountByOrg.get(org.id) ?? 0,
      storageBytes: fcBytesByOrg.get(org.id) ?? 0,
    })
  }

  // ── Snapshots: history only, for the chart ───────────────────────────────
  const snapshots = (await (prismaPrivileged as any).billingSnapshot.findMany({
    where: { organizationId: { in: orgIds }, day: { gte: from, lte: to } },
    select: { organizationId: true, day: true, userCount: true, storageBytes: true },
    orderBy: { day: 'asc' },
  })) as Array<{
    organizationId: string | null
    day: Date
    userCount: number
    storageBytes: bigint
  }>

  let mrrCents = 0
  let mrrUserCents = 0
  let mrrStorageCents = 0
  let billableUsersTotal = 0
  let billableGiBTotal = 0
  let billableBytes = 0
  const estimatedByOrg = new Map<
    string,
    { totalCents: number; userCents: number; storageCents: number; billableUsers: number; billableGiB: number }
  >()
  for (const org of activeOrgs) {
    const usage = usageByOrg.get(org.id)
    if (!usage) continue
    const bill = computeBillable(usage.userCount, usage.storageBytes)
    estimatedByOrg.set(org.id, {
      totalCents: bill.totalCents,
      userCents: bill.userCents,
      storageCents: bill.storageCents,
      billableUsers: bill.billableUsers,
      billableGiB: bill.billableGiB,
    })
    mrrCents += bill.totalCents
    mrrUserCents += bill.userCents
    mrrStorageCents += bill.storageCents
    billableUsersTotal += bill.billableUsers
    billableGiBTotal += bill.billableGiB
    billableBytes += usage.storageBytes
  }

  // Daily platform totals for the chart.
  const byDay = new Map<string, { users: number; storageBytes: number; mrrCents: number }>()
  for (const s of snapshots) {
    const key = s.day.toISOString().slice(0, 10)
    const entry = byDay.get(key) ?? { users: 0, storageBytes: 0, mrrCents: 0 }
    entry.users += s.userCount
    entry.storageBytes += Number(s.storageBytes)
    entry.mrrCents += computeBillable(s.userCount, Number(s.storageBytes)).totalCents
    byDay.set(key, entry)
  }
  const series = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ day, ...v }))

  // ── Revenue actually invoiced in the range ───────────────────────────────
  // Only the MOST RECENT invoice per company is stored locally (there is no
  // invoice-history table — Stripe holds the full ledger), so this is a floor,
  // not a total. Saying so beats printing a confident wrong number.
  const invoicedInRangeCents = settingsRows.reduce((acc, s) => {
    if (!s.lastChargedAt || !s.lastInvoiceAmount) return acc
    if (s.lastChargedAt < from || s.lastChargedAt > to) return acc
    if (s.lastInvoiceStatus && s.lastInvoiceStatus !== 'paid') return acc
    return acc + s.lastInvoiceAmount
  }, 0)

  // ── Activity in range ────────────────────────────────────────────────────
  const [uploads, comments, projectsCreated, newCompanies] = await Promise.all([
    (prismaPrivileged as any).video.count({
      where: { organizationId: { in: orgIds }, createdAt: { gte: from, lte: to } },
    }),
    (prismaPrivileged as any).comment.count({
      where: { organizationId: { in: orgIds }, createdAt: { gte: from, lte: to } },
    }),
    (prismaPrivileged as any).project.count({
      where: { organizationId: { in: orgIds }, createdAt: { gte: from, lte: to } },
    }),
    (prismaPrivileged as any).organization.count({
      where: { isPlatform: false, id: { not: platformId }, createdAt: { gte: from, lte: to } },
    }),
  ])

  // ── Per-company table ────────────────────────────────────────────────────
  const companiesTable = orgs.map((org) => {
    const s = settingsByOrg.get(org.id)
    const usage = usageByOrg.get(org.id)
    const est = estimatedByOrg.get(org.id)
    return {
      id: org.id,
      name: org.name,
      createdAt: org.createdAt.toISOString(),
      status: org.status,
      users: userCountByOrg.get(org.id) ?? 0,
      storageBytes: usage?.storageBytes ?? 0,
      billingStatus: s?.billingStatus ?? 'none',
      hasCard: !!s?.paymentMethodLast4,
      lastInvoiceCents: s?.lastInvoiceAmount ?? null,
      lastChargedAt: s?.lastChargedAt ? s.lastChargedAt.toISOString() : null,
      estimatedMonthlyCents: est?.totalCents ?? 0,
      estimatedUserCents: est?.userCents ?? 0,
      estimatedStorageCents: est?.storageCents ?? 0,
      billableUsers: est?.billableUsers ?? 0,
      billableGiB: est?.billableGiB ?? 0,
      tier: ((est?.totalCents ?? 0) > 0 ? 'paid' : 'free') as 'free' | 'paid',
      deletionScheduledAt: org.deletionScheduledAt ? org.deletionScheduledAt.toISOString() : null,
      deletionReason: org.deletionReason ?? null,
      ownerEmail: contactByOrg.get(org.id)?.ownerEmail ?? null,
      ownerName: contactByOrg.get(org.id)?.ownerName ?? null,
      deletionRequestedByEmail: contactByOrg.get(org.id)?.requestedByEmail ?? null,
    }
  })

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    companies: {
      total: orgs.length,
      active: activeOrgs.length,
      suspended: orgs.filter((o) => o.status === 'SUSPENDED').length,
      newInRange: newCompanies,
      paying,
      onPaidTier: companiesTable.filter((c) => c.tier === 'paid').length,
      onFreeTier: companiesTable.filter((c) => c.tier === 'free').length,
    },
    users: { total: userTotal, newInRange: newUsers },
    revenue: {
      mrrCents,
      mrrUserCents,
      mrrStorageCents,
      billableUsers: billableUsersTotal,
      billableGiB: billableGiBTotal,
      invoicedInRangeCents,
      revenueNote:
        'Invoiced figure counts the most recent paid invoice per company, which is all this instance stores locally. Stripe holds the complete ledger.',
      currency: BILLING_PRICING.currency,
      pricing: {
        perUserPerMonthCents: BILLING_PRICING.perUserPerMonthCents,
        perGibPerMonthCents: BILLING_PRICING.perGibPerMonthCents,
        freeUsers: FREE_TIER.users,
        freeGib: FREE_TIER.gib,
      },
    },
    storage: { totalBytes, billableBytes },
    activity: { uploads, comments, projectsCreated },
    series,
    companiesTable: companiesTable.sort(
      (a, b) => b.estimatedMonthlyCents - a.estimatedMonthlyCents,
    ),
  }
}

/** Parse `?from`/`?to`, defaulting to the last 30 days. */
export function parseRange(searchParams: URLSearchParams): { from: Date; to: Date } {
  const now = new Date()
  const toRaw = searchParams.get('to')
  const fromRaw = searchParams.get('from')
  const to = toRaw ? new Date(toRaw) : now
  const from = fromRaw ? new Date(fromRaw) : new Date(now.getTime() - 30 * DAY_MS)
  const valid = (d: Date) => d instanceof Date && !Number.isNaN(d.getTime())
  return {
    from: valid(from) ? from : new Date(now.getTime() - 30 * DAY_MS),
    to: valid(to) ? to : now,
  }
}
