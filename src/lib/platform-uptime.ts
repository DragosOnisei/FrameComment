/**
 * 6.8.0 — uptime, measured rather than claimed (Faza 5).
 *
 * How it works: each service rewrites one heartbeat row every minute. If the
 * beat before this one is older than the tolerance, the service was not
 * running in between, and that gap is written down as an outage the moment it
 * comes back. One row per service plus one row per real outage — no time
 * series to prune.
 *
 * What this can and cannot see, stated plainly because an uptime figure that
 * overstates itself is worse than none:
 *
 *   ✅ the app or worker process being down, crashed, restarting or deploying
 *   ✅ the database being unreachable (no beat can be written)
 *   ❌ the server being fine while users cannot reach it — DNS, TLS, reverse
 *      proxy, network, or the datacentre's route to the world
 *
 * That last category needs a probe OUTSIDE the machine. Until one exists, the
 * figure here is "the service was running", not "customers could use it", and
 * the UI says so in those words.
 */

import { prismaPrivileged } from './db'
import { logError, logMessage } from './logging'

export const HEARTBEAT_INTERVAL_MS = 60_000
/** A gap longer than this counts as downtime. Three missed beats, so a slow
 *  minute or a clock hiccup doesn't invent an outage. */
export const HEARTBEAT_TOLERANCE_MS = 3 * HEARTBEAT_INTERVAL_MS

export type ServiceName = 'web' | 'worker'

/**
 * Called every minute by each service, and once at boot.
 * `isBoot` distinguishes a restart from a routine beat: a restart quick
 * enough to leave no gap still deserves to be visible.
 */
export async function recordHeartbeat(
  service: ServiceName,
  options: { isBoot?: boolean; version?: string | null } = {},
): Promise<void> {
  const now = new Date()
  try {
    const existing = await (prismaPrivileged as any).serviceHeartbeat.findUnique({
      where: { service },
    })

    if (!existing) {
      await (prismaPrivileged as any).serviceHeartbeat.create({
        data: {
          service,
          lastSeenAt: now,
          bootedAt: now,
          bootCount: 1,
          version: options.version ?? null,
        },
      })
      return
    }

    const lastSeen = new Date(existing.lastSeenAt)
    const gapMs = now.getTime() - lastSeen.getTime()

    // The gap is real downtime: the service could not write its beat.
    if (gapMs > HEARTBEAT_TOLERANCE_MS) {
      await (prismaPrivileged as any).serviceOutage
        .create({
          data: {
            service,
            startedAt: lastSeen,
            endedAt: now,
            seconds: Math.round(gapMs / 1000),
            source: 'gap',
          },
        })
        .catch((err: unknown) => logError('[uptime] failed to record outage:', err))
      logMessage(
        `[uptime] ${service} was absent for ${Math.round(gapMs / 1000)}s — outage recorded`,
      )
    }

    await (prismaPrivileged as any).serviceHeartbeat.update({
      where: { service },
      data: {
        lastSeenAt: now,
        ...(options.isBoot
          ? { bootedAt: now, bootCount: (existing.bootCount ?? 0) + 1 }
          : {}),
        ...(options.version ? { version: options.version } : {}),
      },
    })
  } catch (error) {
    // Uptime bookkeeping must never take the service down with it.
    logError(`[uptime] heartbeat failed for ${service}:`, error)
  }
}

export interface UptimeService {
  service: string
  /** Null until there is at least a full period of measurement. */
  uptimePercent: number | null
  outages: number
  downtimeSeconds: number
  lastSeenAt: string | null
  bootedAt: string | null
  bootCount: number
  version: string | null
  online: boolean
  /** When measurement actually began — the figure only covers this window. */
  measuringSince: string | null
}

export interface UptimeSummary {
  from: string
  to: string
  services: UptimeService[]
  recentOutages: Array<{
    service: string
    startedAt: string
    endedAt: string
    seconds: number
    note: string | null
  }>
  /** The honest caveat, carried with the data so it can't be dropped in the UI. */
  scopeNote: string
}

export async function computeUptime(from: Date, to: Date): Promise<UptimeSummary> {
  const [beats, outages] = await Promise.all([
    (prismaPrivileged as any).serviceHeartbeat.findMany() as Promise<
      Array<{
        service: string
        lastSeenAt: Date
        bootedAt: Date
        bootCount: number
        version: string | null
        updatedAt: Date
      }>
    >,
    (prismaPrivileged as any).serviceOutage.findMany({
      where: { startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: 'desc' },
    }) as Promise<
      Array<{
        service: string
        startedAt: Date
        endedAt: Date
        seconds: number
        note: string | null
      }>
    >,
  ])

  const now = Date.now()

  const services: UptimeService[] = beats.map((b) => {
    const mine = outages.filter((o) => o.service === b.service)
    const downtimeSeconds = mine.reduce((acc, o) => acc + o.seconds, 0)

    // Measurement can't predate the first beat we ever wrote. Using the whole
    // requested range would silently credit us with uptime we never observed.
    const oldestOutage = mine.length ? mine[mine.length - 1].startedAt : null
    const measuringSince = oldestOutage && oldestOutage < b.bootedAt ? oldestOutage : b.bootedAt
    const windowStart = Math.max(from.getTime(), new Date(measuringSince).getTime())
    const windowMs = Math.min(to.getTime(), now) - windowStart

    return {
      service: b.service,
      uptimePercent:
        windowMs > HEARTBEAT_INTERVAL_MS
          ? Math.max(0, Math.min(100, ((windowMs - downtimeSeconds * 1000) / windowMs) * 100))
          : null,
      outages: mine.length,
      downtimeSeconds,
      lastSeenAt: b.lastSeenAt.toISOString(),
      bootedAt: b.bootedAt.toISOString(),
      bootCount: b.bootCount,
      version: b.version,
      online: now - new Date(b.lastSeenAt).getTime() <= HEARTBEAT_TOLERANCE_MS,
      measuringSince: new Date(measuringSince).toISOString(),
    }
  })

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    services,
    recentOutages: outages.slice(0, 20).map((o) => ({
      service: o.service,
      startedAt: o.startedAt.toISOString(),
      endedAt: o.endedAt.toISOString(),
      seconds: o.seconds,
      note: o.note,
    })),
    scopeNote:
      'Measured from inside the system: each service writes a heartbeat every minute and a missing beat is recorded as downtime. This sees the app, the worker and the database being down. It cannot see the server being healthy while users could not reach it — DNS, TLS, proxy or network failures need a probe outside this machine.',
  }
}
