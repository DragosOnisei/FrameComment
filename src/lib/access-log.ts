/**
 * 6.18.0 — recording who tried to get in.
 *
 * The app already had `SecurityEvent`, but it is scoped to an organization,
 * and that is precisely wrong for authentication. A failed login has no
 * organization: the credentials did not resolve to a user, which is the case
 * most worth recording. Under row-level security those rows would belong to
 * nobody and be invisible to everyone — the same as not writing them.
 *
 * So this is a separate, platform-level table, read only by the founder area.
 *
 * THREE RULES, all of them deliberate:
 *
 * 1. Never block on it. Recording an attack must not slow down or break the
 *    thing being attacked. Every write is best-effort and swallowed; a login
 *    succeeds or fails on its own merits whatever the logger does.
 *
 * 2. Never store a password, or anything derived from one. The `identifier` is
 *    what someone typed in the username box, because "admin" being tried 400
 *    times is the signal. What they typed in the password box is never touched
 *    — not hashed, not truncated, not logged on failure. A breach of this
 *    table must not be a breach of anyone's credentials.
 *
 * 3. Never store the raw User-Agent. The coarse `browser:os` signature is
 *    enough to tell a scripted client from a person and cannot be used to
 *    track anyone across sites.
 *
 * IP addresses ARE personal data under GDPR. Rows expire after 90 days (see
 * `purgeExpiredAccessAttempts`, run by the worker); the aggregate counts the
 * Security page draws survive, because "1,412 attempts from Nigeria"
 * identifies no one.
 */

import type { NextRequest } from 'next/server'
import { prismaPrivileged } from './db'
import { getClientIpAddress } from './utils'
import { deviceSignature } from './device-signature'
import { lookupIp } from './geoip'
import { logError } from './logging'

export type AccessAttemptKind =
  | 'LOGIN_FAILED'
  | 'LOGIN_SUCCESS'
  | 'LOGIN_LOCKED'
  | 'RATE_LIMITED'
  | 'TOKEN_DEVICE_MISMATCH'
  | 'TOKEN_REPLAY'
  | 'BLOCKED_IP'
  | 'SHARE_PASSWORD_FAILED'

export type AccessSeverity = 'INFO' | 'WARNING' | 'CRITICAL'

/** Default weight per kind, so callers do not have to remember. */
const SEVERITY: Record<AccessAttemptKind, AccessSeverity> = {
  LOGIN_SUCCESS: 'INFO',
  LOGIN_FAILED: 'WARNING',
  LOGIN_LOCKED: 'CRITICAL',
  RATE_LIMITED: 'WARNING',
  // Since 6.17.1 a device mismatch is a real mismatch — browser updates no
  // longer trigger it — so it is worth treating as serious again.
  TOKEN_DEVICE_MISMATCH: 'CRITICAL',
  TOKEN_REPLAY: 'CRITICAL',
  BLOCKED_IP: 'WARNING',
  SHARE_PASSWORD_FAILED: 'INFO',
}

export const ACCESS_RETENTION_DAYS = Number.parseInt(
  process.env.ACCESS_LOG_RETENTION_DAYS || '90',
  10,
)

/**
 * Write one attempt. Fire-and-forget by design — callers should NOT await this
 * on a hot path, and nothing they do should depend on it succeeding.
 */
export async function recordAccessAttempt(params: {
  request: NextRequest
  kind: AccessAttemptKind
  identifier?: string | null
  succeeded?: boolean
  severity?: AccessSeverity
  details?: Record<string, unknown>
}): Promise<void> {
  const { request, kind, identifier, succeeded = false, details } = params
  try {
    const ipAddress = getClientIpAddress(request)
    const geo = await lookupIp(ipAddress)
    const userAgent = request.headers.get('user-agent')

    // Cloudflare already knows the country for free when traffic passes
    // through it. Preferring the header costs nothing and gives accurate
    // geography to installs that never set up a local database.
    const cfCountry = request.headers.get('cf-ipcountry')
    const country =
      cfCountry && cfCountry.length === 2 && cfCountry !== 'XX' ? cfCountry.toUpperCase() : geo.country

    await (prismaPrivileged as any).accessAttempt.create({
      data: {
        kind,
        severity: params.severity || SEVERITY[kind] || 'INFO',
        ipAddress,
        country,
        countryName: geo.countryName,
        city: geo.city,
        asn: geo.asn,
        // Trimmed: a username box will happily accept a megabyte of junk, and
        // storing it verbatim turns a log into an attack surface of its own.
        identifier: identifier ? identifier.slice(0, 200) : null,
        client: userAgent ? deviceSignature(userAgent) : null,
        path: new URL(request.url).pathname.slice(0, 200),
        succeeded,
        details: (details as any) ?? undefined,
      },
    })
  } catch (error) {
    // A logging failure must never surface to the person logging in, and must
    // never be the reason a request 500s.
    logError('[ACCESS-LOG] Could not record attempt:', error)
  }
}

/**
 * Drop everything past the retention window.
 *
 * Called by the worker on a schedule. Deleting in batches keeps the statement
 * from locking the table for a long time on an install that has accumulated
 * millions of rows — the exact install that most needs the cleanup to work.
 */
export async function purgeExpiredAccessAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - ACCESS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  let removed = 0
  try {
    for (let pass = 0; pass < 50; pass += 1) {
      const batch: Array<{ id: string }> = await (prismaPrivileged as any).accessAttempt.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: 5_000,
      })
      if (batch.length === 0) break
      const result = await (prismaPrivileged as any).accessAttempt.deleteMany({
        where: { id: { in: batch.map((r) => r.id) } },
      })
      removed += result.count
      if (batch.length < 5_000) break
    }
  } catch (error) {
    logError('[ACCESS-LOG] Purge failed:', error)
  }
  return removed
}
