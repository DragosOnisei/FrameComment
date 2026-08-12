/**
 * 6.6.0 Founder CRM (Faza 3) — the platform's own pipeline.
 *
 * Everything here goes through `prismaPrivileged`: these tables carry no
 * organizationId and the tenant database role has no grant on them at all
 * (see the migration). Every caller sits behind `requirePlatformAdmin`.
 *
 * Design note: the app writes STATUS_CHANGE activities itself, so a lead's
 * history explains how it got where it is. A pipeline that silently mutates
 * status is a pipeline you stop trusting after the first surprise.
 */

import { prismaPrivileged } from './db'
import { logError } from './logging'

export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'TRIAL',
  'CUSTOMER',
  'LOST',
] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

export const LEAD_ACTIVITY_TYPES = ['NOTE', 'CALL', 'EMAIL', 'DEMO', 'STATUS_CHANGE'] as const
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number]

/** Statuses that still need work from you. */
const OPEN_STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'TRIAL']

export interface LeadRow {
  id: string
  name: string
  email: string
  company: string | null
  profession: string | null
  source: string
  status: LeadStatus
  estimatedValueCents: number | null
  notes: string | null
  convertedOrgId: string | null
  convertedAt: string | null
  lastContactedAt: string | null
  createdAt: string
  updatedAt: string
  activityCount: number
  nextFollowUpAt: string | null
  followUpOverdue: boolean
}

export interface CrmSummary {
  total: number
  open: number
  byStatus: Record<LeadStatus, number>
  followUpsDue: number
  wonThisMonth: number
  /** Customers ÷ every lead that reached a decision (customer or lost). Null
   *  while nothing has been decided yet — a rate over zero decisions is noise. */
  conversionRate: number | null
  pipelineValueCents: number
}

function serializeLead(
  l: any,
  followUps: Array<{ leadId: string; dueAt: Date }>,
  activityCounts: Map<string, number>,
  now: Date,
): LeadRow {
  const next = followUps.find((f) => f.leadId === l.id)
  return {
    id: l.id,
    name: l.name,
    email: l.email,
    company: l.company ?? null,
    profession: l.profession ?? null,
    source: l.source,
    status: l.status as LeadStatus,
    estimatedValueCents: l.estimatedValueCents ?? null,
    notes: l.notes ?? null,
    convertedOrgId: l.convertedOrgId ?? null,
    convertedAt: l.convertedAt ? l.convertedAt.toISOString() : null,
    lastContactedAt: l.lastContactedAt ? l.lastContactedAt.toISOString() : null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    activityCount: activityCounts.get(l.id) ?? 0,
    nextFollowUpAt: next ? next.dueAt.toISOString() : null,
    followUpOverdue: !!next && next.dueAt < now,
  }
}

/** The pipeline list plus the numbers on top of it, in one round. */
export async function listLeads(options: {
  status?: LeadStatus | 'ALL' | 'OPEN'
  query?: string
}): Promise<{ leads: LeadRow[]; summary: CrmSummary }> {
  const now = new Date()
  const where: any = {}

  if (options.status && options.status !== 'ALL') {
    where.status = options.status === 'OPEN' ? { in: OPEN_STATUSES } : options.status
  }
  const q = options.query?.trim()
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { company: { contains: q, mode: 'insensitive' } },
    ]
  }

  const leads = await (prismaPrivileged as any).lead.findMany({
    where,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  })

  const leadIds = leads.map((l: any) => l.id)
  const [openFollowUps, activityGroups] = await Promise.all([
    leadIds.length
      ? ((prismaPrivileged as any).followUp.findMany({
          where: { leadId: { in: leadIds }, doneAt: null },
          orderBy: { dueAt: 'asc' },
          select: { leadId: true, dueAt: true },
        }) as Promise<Array<{ leadId: string; dueAt: Date }>>)
      : Promise.resolve([] as Array<{ leadId: string; dueAt: Date }>),
    leadIds.length
      ? ((prismaPrivileged as any).leadActivity.groupBy({
          by: ['leadId'],
          where: { leadId: { in: leadIds } },
          _count: { id: true },
        }) as Promise<Array<{ leadId: string; _count: { id: number } }>>)
      : Promise.resolve([] as Array<{ leadId: string; _count: { id: number } }>),
  ])
  const activityCounts = new Map(activityGroups.map((g) => [g.leadId, g._count.id]))

  return {
    leads: leads.map((l: any) => serializeLead(l, openFollowUps, activityCounts, now)),
    summary: await computeCrmSummary(now),
  }
}

/** Summary over ALL leads, not just the filtered page. */
export async function computeCrmSummary(now = new Date()): Promise<CrmSummary> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const [groups, followUpsDue, wonThisMonth, valueAgg] = await Promise.all([
    (prismaPrivileged as any).lead.groupBy({
      by: ['status'],
      _count: { id: true },
    }) as Promise<Array<{ status: string; _count: { id: number } }>>,
    (prismaPrivileged as any).followUp.count({
      where: { doneAt: null, dueAt: { lte: now } },
    }) as Promise<number>,
    (prismaPrivileged as any).lead.count({
      where: { status: 'CUSTOMER', convertedAt: { gte: monthStart } },
    }) as Promise<number>,
    (prismaPrivileged as any).lead.aggregate({
      where: { status: { in: OPEN_STATUSES } },
      _sum: { estimatedValueCents: true },
    }),
  ])

  const byStatus = LEAD_STATUSES.reduce(
    (acc, s) => ({ ...acc, [s]: 0 }),
    {} as Record<LeadStatus, number>,
  )
  for (const g of groups) {
    if ((LEAD_STATUSES as readonly string[]).includes(g.status)) {
      byStatus[g.status as LeadStatus] = g._count.id
    }
  }

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  const open = OPEN_STATUSES.reduce((a, s) => a + byStatus[s], 0)
  const decided = byStatus.CUSTOMER + byStatus.LOST

  return {
    total,
    open,
    byStatus,
    followUpsDue,
    wonThisMonth,
    conversionRate: decided > 0 ? byStatus.CUSTOMER / decided : null,
    pipelineValueCents: Number(valueAgg?._sum?.estimatedValueCents ?? 0),
  }
}

/** One lead with its full history. */
export async function getLeadDetail(id: string) {
  const lead = await (prismaPrivileged as any).lead.findUnique({ where: { id } })
  if (!lead) return null
  const [activities, followUps] = await Promise.all([
    (prismaPrivileged as any).leadActivity.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    (prismaPrivileged as any).followUp.findMany({
      where: { leadId: id },
      orderBy: { dueAt: 'asc' },
    }),
  ])
  return {
    lead: serializeLead(lead, [], new Map(), new Date()),
    activities: activities.map((a: any) => ({
      id: a.id,
      type: a.type as LeadActivityType,
      body: a.body ?? null,
      authorName: a.authorName ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
    followUps: followUps.map((f: any) => ({
      id: f.id,
      dueAt: f.dueAt.toISOString(),
      doneAt: f.doneAt ? f.doneAt.toISOString() : null,
      note: f.note ?? null,
    })),
  }
}

export async function logLeadActivity(params: {
  leadId: string
  type: LeadActivityType
  body?: string | null
  authorId?: string | null
  authorName?: string | null
}) {
  return (prismaPrivileged as any).leadActivity.create({
    data: {
      leadId: params.leadId,
      type: params.type,
      body: params.body ?? null,
      authorId: params.authorId ?? null,
      authorName: params.authorName ?? null,
    },
  })
}

/**
 * A new access request becomes a lead. Upsert on email so a second request
 * updates the existing row instead of splitting the person in two — and never
 * downgrades someone who already converted.
 */
export async function upsertLeadFromAccessRequest(params: {
  name: string
  email: string
  profession?: string | null
  createdAt?: Date
}): Promise<{ created: boolean } | null> {
  const email = params.email.trim().toLowerCase()
  if (!email) return null
  try {
    const existing = await (prismaPrivileged as any).lead.findUnique({
      where: { email },
      select: { id: true, status: true },
    })
    if (existing) {
      await (prismaPrivileged as any).lead.update({
        where: { id: existing.id },
        data: {
          name: params.name || undefined,
          profession: params.profession || undefined,
        },
      })
      await logLeadActivity({
        leadId: existing.id,
        type: 'NOTE',
        body: 'Requested access again.',
        authorName: 'System',
      })
      return { created: false }
    }
    const lead = await (prismaPrivileged as any).lead.create({
      data: {
        name: params.name,
        email,
        profession: params.profession ?? null,
        source: 'request-access',
        status: 'NEW',
        ...(params.createdAt ? { createdAt: params.createdAt } : {}),
      },
    })
    await logLeadActivity({
      leadId: lead.id,
      type: 'NOTE',
      body: 'Requested access from the website.',
      authorName: 'System',
    })
    return { created: true }
  } catch (error) {
    // The CRM must never be the reason a person can't ask for access.
    logError('[crm] upsertLeadFromAccessRequest failed:', error)
    return null
  }
}

/**
 * Called when a company registers. Marks the matching lead as CUSTOMER and
 * records WHICH organization it became, so the claim is checkable later.
 * Best-effort by design: registration must succeed regardless.
 */
export async function markLeadConverted(params: {
  email: string
  organizationId: string
  registrationInviteId?: string | null
}): Promise<void> {
  const email = params.email.trim().toLowerCase()
  if (!email) return
  try {
    const lead = await (prismaPrivileged as any).lead.findUnique({
      where: { email },
      select: { id: true, status: true },
    })
    if (!lead) return
    if (lead.status === 'CUSTOMER') return
    await (prismaPrivileged as any).lead.update({
      where: { id: lead.id },
      data: {
        status: 'CUSTOMER',
        convertedOrgId: params.organizationId,
        convertedAt: new Date(),
        registrationInviteId: params.registrationInviteId ?? undefined,
      },
    })
    await logLeadActivity({
      leadId: lead.id,
      type: 'STATUS_CHANGE',
      body: `Registered a company (${params.organizationId}) → CUSTOMER.`,
      authorName: 'System',
    })
  } catch (error) {
    logError('[crm] markLeadConverted failed:', error)
  }
}

/**
 * Retroactive import: every access request made before the CRM existed lives
 * as an EARLY_ACCESS notification, whose message is "Name (email), Profession".
 * Parse it, upsert by email, keep the original date. Idempotent — running it
 * twice imports nothing new.
 */
export async function importLeadsFromAccessRequests(): Promise<{
  scanned: number
  imported: number
  skipped: number
}> {
  // Written with organizationId 'org-1' by the early-access route, so read it
  // privileged and without an org filter.
  const rows = (await (prismaPrivileged as any).notification.findMany({
    where: { type: 'EARLY_ACCESS' },
    orderBy: { createdAt: 'asc' },
    select: { actorName: true, message: true, createdAt: true },
    take: 2000,
  })) as Array<{ actorName: string | null; message: string | null; createdAt: Date }>

  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const parsed = parseAccessRequestMessage(row.message, row.actorName)
    if (!parsed) {
      skipped++
      continue
    }
    const result = await upsertLeadFromAccessRequest({
      name: parsed.name,
      email: parsed.email,
      profession: parsed.profession,
      createdAt: row.createdAt,
    })
    if (result?.created) imported++
    else skipped++
  }
  return { scanned: rows.length, imported, skipped }
}

/** "Ana Pop (ana@example.com), Editor" → its three parts. Null if it doesn't
 *  match, because a half-parsed lead is worse than a skipped one. */
export function parseAccessRequestMessage(
  message: string | null,
  actorName: string | null,
): { name: string; email: string; profession: string | null } | null {
  if (!message) return null
  const match = message.match(/^(.*?)\s*\(([^)]+)\)(?:,\s*(.*))?$/)
  if (!match) return null
  const email = match[2].trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  const name = (actorName || match[1] || '').trim() || email
  const profession = match[3]?.trim() || null
  return { name, email, profession }
}
