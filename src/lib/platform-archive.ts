/**
 * 6.8.0 — the report archive (Faza 5).
 *
 * Archiving stores the FIGURES for a period, not the rendered PDF. Two
 * reasons, both about trust:
 *
 *  - A report for March must keep saying what March said, even after videos
 *    are deleted and companies churn. Recomputing from live data would
 *    quietly rewrite history every time you opened an old report.
 *  - Keeping the numbers instead of the bytes means the layout can improve
 *    without falsifying past documents, and the archive stays small.
 *
 * The PDF is re-rendered on download from the frozen metrics, by the same
 * renderer the live report uses.
 */

import { prismaPrivileged } from './db'
import { computeFounderMetrics, type FounderMetrics } from './founder-metrics'

export interface ArchiveRow {
  id: string
  label: string
  periodFrom: string
  periodTo: string
  createdAt: string
  createdByName: string | null
  mrrCents: number
  companies: number
  users: number
}

/** Freeze a period. The label is what you'll recognise it by later. */
export async function archivePeriod(params: {
  from: Date
  to: Date
  label?: string | null
  actorId?: string | null
  actorName?: string | null
}): Promise<{ id: string; label: string }> {
  const metrics = await computeFounderMetrics(params.from, params.to)
  const label =
    params.label?.trim() ||
    `${params.from.toISOString().slice(0, 10)} → ${params.to.toISOString().slice(0, 10)}`

  const row = await (prismaPrivileged as any).platformReportArchive.create({
    data: {
      label,
      periodFrom: params.from,
      periodTo: params.to,
      metricsJson: JSON.stringify(metrics),
      createdById: params.actorId ?? null,
      createdByName: params.actorName ?? null,
    },
  })
  return { id: row.id, label }
}

export async function listArchives(limit = 50): Promise<ArchiveRow[]> {
  const rows = await (prismaPrivileged as any).platformReportArchive.findMany({
    orderBy: { periodTo: 'desc' },
    take: limit,
  })
  return rows.map((r: any) => {
    // Parsing defensively: an archive whose JSON can't be read should still
    // list, with blanks, rather than break the whole page.
    let m: FounderMetrics | null = null
    try {
      m = JSON.parse(r.metricsJson)
    } catch {
      m = null
    }
    return {
      id: r.id,
      label: r.label,
      periodFrom: r.periodFrom.toISOString(),
      periodTo: r.periodTo.toISOString(),
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdByName ?? null,
      mrrCents: m?.revenue?.mrrCents ?? 0,
      companies: m?.companies?.total ?? 0,
      users: m?.users?.total ?? 0,
    }
  })
}

export async function getArchivedMetrics(
  id: string,
): Promise<{ label: string; metrics: FounderMetrics } | null> {
  const row = await (prismaPrivileged as any).platformReportArchive.findUnique({
    where: { id },
  })
  if (!row) return null
  try {
    return { label: row.label, metrics: JSON.parse(row.metricsJson) as FounderMetrics }
  } catch {
    return null
  }
}

export async function deleteArchive(id: string): Promise<void> {
  await (prismaPrivileged as any).platformReportArchive.delete({ where: { id } })
}
