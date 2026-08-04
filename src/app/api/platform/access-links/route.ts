import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireApiOwner } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { prismaPrivileged, currentOrgId } from '@/lib/db'
import { logMessage, logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.14 — POST /api/platform/access-links (PLATFORM OWNER ONLY).
 *
 * Generates a single-use registration "access link": a unique code the
 * platform owner can send to a prospect; opening /register?code=<code>
 * pre-fills the invite-code field and the register API accepts it once
 * (valid 30 days). Lives alongside the shared REGISTER_INVITE_CODE env
 * secret, which keeps working unchanged.
 *
 * RegistrationInvite is a platform-level table (no organizationId), so
 * all access goes through this owner-gated route via the privileged
 * client.
 */

const ACCESS_LINK_TTL_DAYS = 30

/** Shared gate: platform org OWNER only. */
async function requirePlatformOwner(request: NextRequest) {
  const auth = await requireApiOwner(request)
  if (auth instanceof Response) return auth
  if (currentOrgId() !== 'org-1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return auth
}

// GET — list the latest access links (code, status, expiry) for the modal.
export async function GET(request: NextRequest) {
  const auth = await requirePlatformOwner(request)
  if (auth instanceof Response) return auth

  try {
    const rows = (await (prismaPrivileged as any).registrationInvite.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        code: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
        usedByEmail: true,
      },
    })) as any[]
    return NextResponse.json({ invites: rows })
  } catch (error) {
    logError('[GET /api/platform/access-links] failed:', error)
    return NextResponse.json({ error: 'Failed to load access links' }, { status: 500 })
  }
}

// DELETE ?id=… — revoke an UNUSED access link.
export async function DELETE(request: NextRequest) {
  const auth = await requirePlatformOwner(request)
  if (auth instanceof Response) return auth

  const id = new URL(request.url).searchParams.get('id') || ''
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  try {
    const row = (await (prismaPrivileged as any).registrationInvite.findUnique({
      where: { id },
      select: { id: true, usedAt: true },
    })) as any
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (row.usedAt) {
      return NextResponse.json({ error: 'This link was already used and is kept for the record.' }, { status: 400 })
    }
    await (prismaPrivileged as any).registrationInvite.delete({ where: { id } })
    logMessage(`[access-links] platform owner revoked access link ${id}`)
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[DELETE /api/platform/access-links] failed:', error)
    return NextResponse.json({ error: 'Failed to revoke access link' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireApiOwner(request)
  if (auth instanceof Response) return auth

  // Platform org only — tenant Owners never see or reach this.
  if (currentOrgId() !== 'org-1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const limited = await rateLimit(
    request,
    { windowMs: 60 * 60 * 1000, maxRequests: 30, message: 'Too many requests. Please slow down.' },
    'platform-access-links',
  )
  if (limited) return limited

  try {
    // Readable, unambiguous code: 20 hex chars grouped for humans.
    const raw = crypto.randomBytes(10).toString('hex').toUpperCase()
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`
    const expiresAt = new Date(Date.now() + ACCESS_LINK_TTL_DAYS * 24 * 60 * 60 * 1000)

    await (prismaPrivileged as any).registrationInvite.create({
      data: { code, createdById: auth.id, expiresAt },
    })

    logMessage(`[access-links] platform owner generated a registration code (expires ${expiresAt.toISOString()})`)
    // Relative path — the client prefixes window.location.origin, so the
    // same code works on localhost and framecomment.com.
    return NextResponse.json({
      ok: true,
      code,
      path: `/register?code=${encodeURIComponent(code)}`,
      expiresAt: expiresAt.toISOString(),
    })
  } catch (error) {
    logError('[POST /api/platform/access-links] failed:', error)
    return NextResponse.json({ error: 'Failed to generate access link' }, { status: 500 })
  }
}
