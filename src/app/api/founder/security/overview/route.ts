/**
 * GET /api/founder/security/overview — 6.18.0
 *
 * Everything the Security page needs, in one request. Five separate endpoints
 * would mean five round-trips and five chances for the page to render half a
 * story; the aggregates are cheap and the tables are indexed for exactly these
 * shapes.
 *
 * Founder-only. `requirePlatformAdmin` answers 404, not 403, for anyone else —
 * an authenticated tenant should not be able to learn that this area exists.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { ACCESS_RETENTION_DAYS } from '@/lib/access-log'
import { geoipStatus } from '@/lib/geoip'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const windowDays = Math.min(
    Math.max(Number.parseInt(request.nextUrl.searchParams.get('days') || '7', 10) || 7, 1),
    ACCESS_RETENTION_DAYS,
  )
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  try {
    const [totals, topIps, topCountries, topIdentifiers, recent, daily, lastScan] =
      await Promise.all([
        prismaPrivileged.$queryRawUnsafe<Array<{
          total: bigint; failed: bigint; succeeded: bigint; critical: bigint; uniqueips: bigint
        }>>(`
          SELECT COUNT(*)::bigint AS total,
                 COUNT(*) FILTER (WHERE succeeded = false)::bigint AS failed,
                 COUNT(*) FILTER (WHERE succeeded = true)::bigint AS succeeded,
                 COUNT(*) FILTER (WHERE severity = 'CRITICAL')::bigint AS critical,
                 COUNT(DISTINCT "ipAddress")::bigint AS uniqueips
          FROM "AccessAttempt" WHERE "createdAt" >= $1
        `, since),

        prismaPrivileged.$queryRawUnsafe<Array<{
          ipaddress: string; country: string | null; countryname: string | null;
          city: string | null; asn: string | null; attempts: bigint; lastseen: Date; blocked: boolean
        }>>(`
          SELECT a."ipAddress" AS ipaddress,
                 MAX(a.country)      AS country,
                 MAX(a."countryName") AS countryname,
                 MAX(a.city)         AS city,
                 MAX(a.asn)          AS asn,
                 COUNT(*)::bigint    AS attempts,
                 MAX(a."createdAt")  AS lastseen,
                 EXISTS (SELECT 1 FROM "BlockedIP" b WHERE b."ipAddress" = a."ipAddress") AS blocked
          FROM "AccessAttempt" a
          WHERE a."createdAt" >= $1 AND a.succeeded = false
          GROUP BY a."ipAddress"
          ORDER BY attempts DESC, lastseen DESC
          LIMIT 10
        `, since),

        prismaPrivileged.$queryRawUnsafe<Array<{
          country: string | null; countryname: string | null; ips: bigint; attempts: bigint
        }>>(`
          SELECT country,
                 MAX("countryName") AS countryname,
                 COUNT(DISTINCT "ipAddress")::bigint AS ips,
                 COUNT(*)::bigint AS attempts
          FROM "AccessAttempt"
          WHERE "createdAt" >= $1 AND succeeded = false AND country IS NOT NULL
          GROUP BY country
          ORDER BY attempts DESC
          LIMIT 10
        `, since),

        prismaPrivileged.$queryRawUnsafe<Array<{
          identifier: string; attempts: bigint; existing: boolean
        }>>(`
          SELECT a.identifier,
                 COUNT(*)::bigint AS attempts,
                 EXISTS (SELECT 1 FROM "User" u WHERE lower(u.email) = lower(a.identifier)) AS existing
          FROM "AccessAttempt" a
          WHERE a."createdAt" >= $1 AND a.succeeded = false AND a.identifier IS NOT NULL
          GROUP BY a.identifier
          ORDER BY attempts DESC
          LIMIT 10
        `, since),

        prismaPrivileged.$queryRawUnsafe<Array<Record<string, unknown>>>(`
          SELECT id, kind, severity, "ipAddress", country, "countryName", city, asn,
                 identifier, client, path, succeeded, "createdAt"
          FROM "AccessAttempt"
          WHERE "createdAt" >= $1
          ORDER BY "createdAt" DESC
          LIMIT 100
        `, since),

        // One row per day so the sparkline has gaps where there was no traffic
        // rather than a line that quietly connects across a silent week.
        prismaPrivileged.$queryRawUnsafe<Array<{ day: Date; failed: bigint; succeeded: bigint }>>(`
          SELECT date_trunc('day', "createdAt") AS day,
                 COUNT(*) FILTER (WHERE succeeded = false)::bigint AS failed,
                 COUNT(*) FILTER (WHERE succeeded = true)::bigint  AS succeeded
          FROM "AccessAttempt" WHERE "createdAt" >= $1
          GROUP BY 1 ORDER BY 1 ASC
        `, since),

        prismaPrivileged.$queryRawUnsafe<Array<Record<string, unknown>>>(`
          SELECT id, status, progress, "currentStage", passed, warnings, failures, score,
                 "startedAt", "finishedAt", "startedByName"
          FROM "SecurityScan" ORDER BY "startedAt" DESC LIMIT 1
        `),
      ])

    const num = (v: unknown) => Number(v ?? 0)
    const t = totals?.[0]

    return NextResponse.json({
      windowDays,
      retentionDays: ACCESS_RETENTION_DAYS,
      geoip: await geoipStatus(),
      totals: {
        total: num(t?.total),
        failed: num(t?.failed),
        succeeded: num(t?.succeeded),
        critical: num(t?.critical),
        uniqueIps: num(t?.uniqueips),
      },
      topIps: topIps.map((r) => ({
        ip: r.ipaddress,
        country: r.country,
        countryName: r.countryname,
        city: r.city,
        asn: r.asn,
        attempts: num(r.attempts),
        lastSeen: r.lastseen,
        blocked: !!r.blocked,
      })),
      topCountries: topCountries.map((r) => ({
        country: r.country,
        countryName: r.countryname,
        ips: num(r.ips),
        attempts: num(r.attempts),
      })),
      topIdentifiers: topIdentifiers.map((r) => ({
        identifier: r.identifier,
        attempts: num(r.attempts),
        existingUser: !!r.existing,
      })),
      recent: recent.map((r) => ({ ...r, createdAt: r.createdAt })),
      daily: daily.map((r) => ({
        day: r.day,
        failed: num(r.failed),
        succeeded: num(r.succeeded),
      })),
      lastScan: lastScan?.[0] ?? null,
    })
  } catch (error) {
    logError('[FOUNDER/SECURITY] overview failed:', error)
    return NextResponse.json({ error: 'Could not load security data' }, { status: 500 })
  }
}
