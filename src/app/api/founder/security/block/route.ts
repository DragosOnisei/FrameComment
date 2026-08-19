/**
 * POST /api/founder/security/block — 6.18.0
 *
 * Block or unblock an IP straight from the Security page, the way Wordfence
 * lets you act on the row you are looking at. A dashboard that shows you an
 * address hammering your login and makes you go elsewhere to do something
 * about it is a report, not a control.
 *
 * `BlockedIP` is org-scoped in the schema, from back when blocking was a tenant
 * setting. A founder blocking an address means "keep this off the platform",
 * so we write with the privileged client and no organization — the row applies
 * everywhere, which is what the person clicking the button intends.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { rateLimit } from '@/lib/rate-limit'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Only shapes that look like an address get through. The value lands in a
 * unique-indexed column and is compared against request IPs; anything else is
 * junk that would sit there forever matching nothing.
 */
function looksLikeIp(value: string): boolean {
  if (!value || value.length > 45) return false
  const v4 = /^(\d{1,3}\.){3}\d{1,3}$/
  const v6 = /^[0-9a-f:]+$/i
  return v4.test(value) || (v6.test(value) && value.includes(':'))
}

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' },
    'security-block',
  )
  if (limited) return limited

  try {
    const body = await request.json().catch(() => ({}))
    const ip = String(body?.ip || '').trim()
    const block = body?.block !== false
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : null

    if (!looksLikeIp(ip)) {
      return NextResponse.json({ error: 'That does not look like an IP address.' }, { status: 400 })
    }

    const user = auth as any
    if (block) {
      await (prismaPrivileged as any).blockedIP.upsert({
        where: { ipAddress: ip },
        update: { reason: reason ?? 'Blocked from the Security page' },
        create: {
          ipAddress: ip,
          reason: reason ?? 'Blocked from the Security page',
          createdBy: user?.id ?? null,
        },
      })
      logMessage(`[SECURITY] ${user?.email || 'founder'} blocked ${ip}`)
    } else {
      await (prismaPrivileged as any).blockedIP
        .delete({ where: { ipAddress: ip } })
        .catch(() => {
          // Already gone. Unblocking something that is not blocked is a no-op,
          // not an error worth showing anyone.
        })
      logMessage(`[SECURITY] ${user?.email || 'founder'} unblocked ${ip}`)
    }

    return NextResponse.json({ ip, blocked: block })
  } catch (error) {
    logError('[FOUNDER/SECURITY] block failed:', error)
    return NextResponse.json({ error: 'Could not update the block list' }, { status: 500 })
  }
}
