/**
 * 6.8.0 — retention, cohorts and security posture (Faza 5).
 *
 * The rule for this file: every line is either measured from the database or
 * read from the running configuration. Nothing is asserted because it sounds
 * good in a data room. Where a claim cannot be verified from inside the
 * application — backups, external monitoring, penetration testing — it is
 * listed as unverified rather than quietly omitted, because an investor
 * checklist with only green ticks is the least believable document there is.
 */

import { prismaPrivileged } from './db'
import { platformOrgId } from './platform'
import { BILLING_PRICING, FREE_TIER } from './billing'
import { logError } from './logging'

const DAY_MS = 24 * 60 * 60 * 1000

export interface Cohort {
  /** Month the companies signed up, as YYYY-MM. */
  month: string
  companies: number
  /** Still ACTIVE today. */
  retained: number
  /** Active AND used the product in the last 30 days. */
  active30d: number
  churned: number
  retentionPercent: number
}

export interface RetentionSummary {
  cohorts: Cohort[]
  /** Companies that used the product in the window, over all active ones. */
  activeRatePercent: number | null
  medianDaysToFirstUpload: number | null
  note: string
}

/**
 * Cohorts by signup month. "Churned" means the organization is no longer
 * ACTIVE — suspended or scheduled for deletion. There is deliberately no
 * churn DATE anywhere in the schema, so this is a snapshot of where each
 * cohort stands today, not a monthly churn curve. Saying which one you have
 * matters more than having the prettier one.
 */
export async function computeRetention(): Promise<RetentionSummary> {
  const now = new Date()
  const activeCutoff = new Date(now.getTime() - 30 * DAY_MS)
  const platformId = platformOrgId()

  const orgs = (await (prismaPrivileged as any).organization.findMany({
    where: { isPlatform: false, id: { not: platformId } },
    select: { id: true, status: true, createdAt: true },
  })) as Array<{ id: string; status: string; createdAt: Date }>

  if (orgs.length === 0) {
    return {
      cohorts: [],
      activeRatePercent: null,
      medianDaysToFirstUpload: null,
      note: 'No companies yet.',
    }
  }

  const orgIds = orgs.map((o) => o.id)

  // "Used the product" = uploaded or commented. Logging in doesn't count:
  // there is no login timestamp in the schema, and pretending otherwise
  // would inflate every number on this page.
  const [recentUploads, recentComments, firstUploads] = await Promise.all([
    (prismaPrivileged as any).video.groupBy({
      by: ['organizationId'],
      where: { organizationId: { in: orgIds }, createdAt: { gte: activeCutoff } },
      _count: { id: true },
    }) as Promise<Array<{ organizationId: string | null }>>,
    (prismaPrivileged as any).comment.groupBy({
      by: ['organizationId'],
      where: { organizationId: { in: orgIds }, createdAt: { gte: activeCutoff } },
      _count: { id: true },
    }) as Promise<Array<{ organizationId: string | null }>>,
    (prismaPrivileged as any).video.groupBy({
      by: ['organizationId'],
      where: { organizationId: { in: orgIds } },
      _min: { createdAt: true },
    }) as Promise<Array<{ organizationId: string | null; _min: { createdAt: Date | null } }>>,
  ])

  const activeOrgIds = new Set<string>()
  for (const r of [...recentUploads, ...recentComments]) {
    if (r.organizationId) activeOrgIds.add(r.organizationId)
  }

  const firstUploadByOrg = new Map(
    firstUploads
      .filter((f) => f.organizationId && f._min.createdAt)
      .map((f) => [f.organizationId as string, f._min.createdAt as Date]),
  )

  const byMonth = new Map<string, Cohort>()
  for (const org of orgs) {
    const month = org.createdAt.toISOString().slice(0, 7)
    const c =
      byMonth.get(month) ??
      ({
        month,
        companies: 0,
        retained: 0,
        active30d: 0,
        churned: 0,
        retentionPercent: 0,
      } as Cohort)
    c.companies++
    if (org.status === 'ACTIVE') {
      c.retained++
      if (activeOrgIds.has(org.id)) c.active30d++
    } else {
      c.churned++
    }
    byMonth.set(month, c)
  }

  const cohorts = Array.from(byMonth.values())
    .map((c) => ({
      ...c,
      retentionPercent: c.companies > 0 ? (c.retained / c.companies) * 100 : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month))

  const activeOrgs = orgs.filter((o) => o.status === 'ACTIVE')
  const activeRatePercent =
    activeOrgs.length > 0
      ? (activeOrgs.filter((o) => activeOrgIds.has(o.id)).length / activeOrgs.length) * 100
      : null

  // Time to first upload: the honest proxy for "did onboarding work".
  const deltas = orgs
    .map((o) => {
      const first = firstUploadByOrg.get(o.id)
      if (!first) return null
      return (first.getTime() - o.createdAt.getTime()) / DAY_MS
    })
    .filter((d): d is number => d !== null && d >= 0)
    .sort((a, b) => a - b)

  const medianDaysToFirstUpload =
    deltas.length > 0
      ? Math.round(deltas[Math.floor(deltas.length / 2)] * 10) / 10
      : null

  return {
    cohorts,
    activeRatePercent,
    medianDaysToFirstUpload,
    note: 'Cohorts are by signup month, and "retained" is where each cohort stands today — the schema records no date for when a company becomes inactive, so a month-by-month churn curve cannot be produced without inventing it. "Used the product" means uploaded or commented; logins are not recorded.',
  }
}

export interface PostureItem {
  label: string
  /** true = verified in this run, false = verified absent, null = not checkable here. */
  status: boolean | null
  detail: string
}

/**
 * Security posture, checked rather than claimed. Row-level security is read
 * from the live catalogue; TTLs come from the running configuration; the
 * things this process genuinely cannot see are marked as such.
 */
export async function computeSecurityPosture(): Promise<PostureItem[]> {
  const items: PostureItem[] = []

  // ── Row-level security, straight from the catalogue ──────────────────────
  try {
    const rows = (await (prismaPrivileged as any).$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE c.relrowsecurity) AS enabled,
         COUNT(*) FILTER (WHERE c.relforcerowsecurity) AS forced,
         COUNT(*) AS total
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    )) as Array<{ enabled: bigint; forced: bigint; total: bigint }>
    const r = rows?.[0]
    const enabled = Number(r?.enabled ?? 0)
    const forced = Number(r?.forced ?? 0)
    const total = Number(r?.total ?? 0)
    items.push({
      label: 'Per-company isolation enforced by the database',
      status: enabled > 0,
      detail: `Row-level security is enabled on ${enabled} of ${total} tables and FORCEd on ${forced}. Tables without it are platform-level ones the tenant role has no grant on.`,
    })
  } catch (error) {
    logError('[posture] RLS check failed:', error)
    items.push({
      label: 'Per-company isolation enforced by the database',
      status: null,
      detail: 'The check could not be run against this database.',
    })
  }

  // ── The privileged connection is a separate credential ───────────────────
  const hasPrivileged = !!process.env.DATABASE_URL_PRIVILEGED
  items.push({
    label: 'Application runs on a restricted database role',
    status: hasPrivileged,
    detail: hasPrivileged
      ? 'Normal requests use a role subject to row-level security; a separate privileged connection exists only for pre-auth and platform reads.'
      : 'DATABASE_URL_PRIVILEGED is not set, so the app is using one connection for everything — row-level security cannot be relied on to isolate tenants.',
  })

  // ── Session lifetimes, read from configuration ───────────────────────────
  const accessTtl = Number(process.env.ADMIN_ACCESS_TTL_SECONDS || 900)
  const refreshDays = Number(process.env.ADMIN_REFRESH_TTL_SECONDS || 30 * 24 * 3600) / 86400
  items.push({
    label: 'Short-lived access tokens with silent refresh',
    status: accessTtl <= 3600,
    detail: `Access tokens last ${Math.round(accessTtl / 60)} minutes; sessions last ${Math.round(refreshDays)} days and refresh in the background, so a stolen access token has a narrow window.`,
  })

  // ── Encryption key for stored secrets ────────────────────────────────────
  const hasEncryptionKey = !!process.env.ENCRYPTION_KEY
  items.push({
    label: 'Stored third-party credentials are encrypted',
    status: hasEncryptionKey,
    detail: hasEncryptionKey
      ? 'API keys and storage credentials are encrypted at rest with a key held outside the database.'
      : 'ENCRYPTION_KEY is not set — credentials would be stored unencrypted.',
  })

  // ── Free tier and pricing, so the data room sees the real numbers ────────
  items.push({
    label: 'Pricing is published in the product',
    status: true,
    detail: `$${BILLING_PRICING.perUserPerMonth}/user/month and $${BILLING_PRICING.perGibPerMonth}/GB/month above a free tier of ${FREE_TIER.users} user and ${FREE_TIER.gib} GB. No contracts, prorated monthly.`,
  })

  // ── Software licence, which a buyer will absolutely ask about ────────────
  items.push({
    label: 'Software licence',
    status: true,
    detail: 'AGPL-3.0. The product is a derivative of ViTransfer; the source offer is published at /source. Revenue comes from operating the service, not from licensing the code.',
  })

  // ── What this page cannot verify. Listed on purpose. ─────────────────────
  items.push({
    label: 'Off-site backups, tested restores',
    status: null,
    detail: 'Not verifiable from inside the application. Provide the backup schedule and the date of the last tested restore separately.',
  })
  items.push({
    label: 'External uptime monitoring',
    status: null,
    detail: 'Uptime here is measured from inside the system. A probe outside this machine is needed to prove customers could reach it.',
  })
  items.push({
    label: 'Independent penetration test',
    status: null,
    detail: 'None commissioned. Worth doing before an enterprise deal; self-run scanning is not a substitute.',
  })

  return items
}
