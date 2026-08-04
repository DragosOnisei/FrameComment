import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 5.14 — POST /api/early-access (public).
 *
 * The landing page's "Request early access" form. Collects name, email
 * and profession, and delivers them as an IN-APP notification to the
 * platform owner ONLY (there is no outbound email system yet):
 * the OWNER of org-1 with the configured email address.
 *
 * Uses the privileged client on purpose: this is an unauthenticated
 * public route with no org context, writing a single platform-scoped
 * notification row. Strictly rate-limited + honeypot-protected.
 */

const PLATFORM_OWNER_EMAIL = 'dragosonisei@gmail.com'
const PROFESSIONS = ['Editor', 'Director', 'YouTuber', 'Entrepreneur', 'Other']

export async function POST(request: NextRequest) {
  const limited = await rateLimit(
    request,
    {
      windowMs: 60 * 60 * 1000,
      maxRequests: 5,
      message: 'Too many requests. Please try again later.',
    },
    'early-access',
  )
  if (limited) return limited

  try {
    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const professionRaw = typeof body?.profession === 'string' ? body.profession.trim() : ''
    const professionOther = typeof body?.professionOther === 'string' ? body.professionOther.trim() : ''
    // Honeypot: real users never fill this hidden field. Bots do —
    // pretend success and write nothing.
    const honeypot = typeof body?.company === 'string' ? body.company.trim() : ''
    if (honeypot) return NextResponse.json({ ok: true })

    if (!name || name.length > 120) {
      return NextResponse.json({ error: 'Please enter your name.' }, { status: 400 })
    }
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
    }
    if (!PROFESSIONS.includes(professionRaw)) {
      return NextResponse.json({ error: 'Please pick a profession.' }, { status: 400 })
    }
    const profession =
      professionRaw === 'Other'
        ? `Other: ${professionOther.slice(0, 120) || 'unspecified'}`
        : professionRaw

    // Deliver ONLY to the platform owner (org-1 + exact email + OWNER).
    const recipient = await (prismaPrivileged as any).user.findFirst({
      where: {
        organizationId: 'org-1',
        role: 'OWNER',
        email: { equals: PLATFORM_OWNER_EMAIL, mode: 'insensitive' },
      },
      select: { id: true },
    })

    if (recipient) {
      await (prismaPrivileged as any).notification.create({
        data: {
          organizationId: 'org-1',
          recipientId: recipient.id,
          type: 'EARLY_ACCESS',
          actorName: name,
          message: `${name} (${email}), ${profession}`,
        },
      })
      logMessage(`[early-access] request from ${email} (${profession})`)
    } else {
      // Never reveal internals to the visitor; log for the operator.
      logError('[early-access] platform owner recipient not found — request not delivered', {
        email,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[POST /api/early-access] failed:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
