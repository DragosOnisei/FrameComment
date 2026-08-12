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
import { BILLING_PRICING, computeBillable, fcStorageWhere } from './billing'

export interface FounderMetrics {
  range: { from: string; to: string }
  companies: {
    total: number
    active: number
    suspended: number
    newInRange: number
    paying: number
  }
  users: { total: number; newInRange: number }
  revenue: {
    /** Sum of what every active company would be invoiced today, in cents. */
    mrrCents: number
    /** Cents actually invoiced inside the range, from the last invoice we
     *  recorded per company. Partial by construction — see `revenueNote`. */
    invoicedInRangeCents: number
    revenueNote: string
    currency: string
  }
  storage: { totalBytes: number; billableBytes: number }
  activity: {
    uploads: number
    comments: number
    approvals: number
    projectsCreated: number
  }
  /** Daily platform totals from the billing snapshots already written each day. */
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
    select: { id: true, name: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })) as Array<{ id: string; name: string; status: string; createdAt: Date }>

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

  // ── Snapshots: the only historical series we already keep ────────────────
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

  // Latest snapshot per company drives MRR and the billable-storage figure.
  const latestByOrg = new Map<string, { userCount: number; storageBytes: number }>()
  for (const s of snapshots) {
    latestByOrg.set(s.organizationId ?? '', {
      userCount: s.userCount,
      storageBytes: Number(s.storageBytes),
    })
  }

  // A company only gets a snapshot once its billing status is read for the day,
  // so a brand-new company (or a fresh local database) has none. Rather than
  // reporting it as 0 users / 0 bytes — which reads like a real measurement —
  // compute its current usage live, by exactly the definition the snapshot uses.
  const missingSnapshot = orgs.map((o) => o.id).filter((id) => !latestByOrg.has(id))
  if (missingSnapshot.length > 0) {
    const scope = { AND: [fcStorageWhere(), { organizationId: { in: missingSnapshot } }] }
    const [vs, as, us] = await Promise.all([
      (prismaPrivileged as any).video.groupBy({
        by: ['organizationId'],
        where: scope,
        _sum: { originalFileSize: true },
      }) as Promise<Array<{ organizationId: string | null; _sum: { originalFileSize: bigint | null } }>>,
      (prismaPrivileged as any).videoAsset.groupBy({
        by: ['organizationId'],
        where: scope,
        _sum: { fileSize: true },
      }) as Promise<Array<{ organizationId: string | null; _sum: { fileSize: bigint | null } }>>,
      (prismaPrivileged as any).projectUpload.groupBy({
        by: ['organizationId'],
        where: scope,
        _sum: { fileSize: true },
      }) as Promise<Array<{ organizationId: string | null; _sum: { fileSize: bigint | null } }>>,
    ])
    const live = new Map<string, number>()
    for (const r of vs) {
      live.set(r.organizationId ?? '', (live.get(r.organizationId ?? '') ?? 0) + Number(r._sum.originalFileSize ?? 0))
    }
    for (const r of [...as, ...us]) {
      live.set(r.organizationId ?? '', (live.get(r.organizationId ?? '') ?? 0) + Number(r._sum.fileSize ?? 0))
    }
    for (const id of missingSnapshot) {
      latestByOrg.set(id, {
        userCount: userCountByOrg.get(id) ?? 0,
        storageBytes: live.get(id) ?? 0,
      })
    }
  }

  let mrrCents = 0
  let billableBytes = 0
  const estimatedByOrg = new Map<string, number>()
  for (const org of activeOrgs) {
    const snap = latestByOrg.get(org.id)
    if (!snap) continue
    const bill = computeBillable(snap.userCount, snap.storageBytes)
    estimatedByOrg.set(org.id, bill.totalCents)
    mrrCents += bill.totalCents
    billableBytes += snap.storageBytes
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
  const [uploads, comments, approvals, projectsCreated, newCompanies] = await Promise.all([
    (prismaPrivileged as any).video.count({
      where: { organizationId: { in: orgIds }, createdAt: { gte: from, lte: to } },
    }),
    (prismaPrivileged as any).comment.count({
      where: { organizationId: { in: orgIds }, createdAt: { gte: from, lte: to } },
    }),
    (prismaPrivileged as any).video.count({
      where: { organizationId: { in: orgIds }, approvedAt: { gte: from, lte: to } },
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
    const snap = latestByOrg.get(org.id)
    return {
      id: org.id,
      name: org.name,
      createdAt: org.createdAt.toISOString(),
      status: org.status,
      users: userCountByOrg.get(org.id) ?? 0,
      storageBytes: snap?.storageBytes ?? 0,
      billingStatus: s?.billingStatus ?? 'none',
      hasCard: !!s?.paymentMethodLast4,
      lastInvoiceCents: s?.lastInvoiceAmount ?? null,
      lastChargedAt: s?.lastChargedAt ? s.lastChargedAt.toISOString() : null,
      estimatedMonthlyCents: estimatedByOrg.get(org.id) ?? 0,
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
    },
    users: { total: userTotal, newInRange: newUsers },
    revenue: {
      mrrCents,
      invoicedInRangeCents,
      revenueNote:
        'Invoiced figure counts the most recent paid invoice per company, which is all this instance stores locally. Stripe holds the complete ledger.',
      currency: BILLING_PRICING.currency,
    },
    storage: { totalBytes, billableBytes },
    activity: { uploads, comments, approvals, projectsCreated },
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
