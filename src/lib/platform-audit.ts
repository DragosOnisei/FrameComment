/**
 * 6.8.0 — the platform audit trail (Faza 5).
 *
 * Records what was done in the Founder area: who, what, to which thing, when.
 * Deliberately a separate table from `SecurityEvent`, for three reasons that
 * each disqualify reuse on their own: SecurityEvent is org-scoped, it has no
 * actor field, and it is silenced by a per-tenant `trackSecurityLogs` setting.
 * An audit trail a customer can switch off is not an audit trail.
 *
 * Writes are best-effort and never block the action being audited — but they
 * are also never skipped silently: a failure is logged loudly, because a
 * missing line here is exactly the kind of gap nobody notices until it
 * matters.
 */

import { prismaPrivileged } from './db'
import { logError } from './logging'
import type { AuthUser } from './auth'

export interface AuditActor {
  id?: string | null
  name?: string | null
  email?: string | null
}

export function actorFrom(user: AuthUser): AuditActor {
  return { id: user.id, name: user.name || user.email, email: user.email }
}

export async function logPlatformAudit(params: {
  actor?: AuditActor | null
  action: string
  targetType?: string | null
  targetId?: string | null
  summary?: string | null
  ipAddress?: string | null
}): Promise<void> {
  try {
    await (prismaPrivileged as any).platformAuditEvent.create({
      data: {
        actorId: params.actor?.id ?? null,
        actorName: params.actor?.name ?? params.actor?.email ?? null,
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        summary: params.summary ?? null,
        ipAddress: params.ipAddress ?? null,
      },
    })
  } catch (error) {
    logError(`[audit] failed to record "${params.action}":`, error)
  }
}

export interface AuditRow {
  id: string
  actorName: string | null
  action: string
  targetType: string | null
  targetId: string | null
  summary: string | null
  createdAt: string
}

export async function listAuditEvents(limit = 100): Promise<AuditRow[]> {
  const rows = await (prismaPrivileged as any).platformAuditEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
  })
  return rows.map((r: any) => ({
    id: r.id,
    actorName: r.actorName ?? null,
    action: r.action,
    targetType: r.targetType ?? null,
    targetId: r.targetId ?? null,
    summary: r.summary ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}
