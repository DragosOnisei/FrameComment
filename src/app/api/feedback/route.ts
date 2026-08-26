import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prismaPrivileged } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { requirePlatformAdmin } from '@/lib/platform'
import { rateLimit } from '@/lib/rate-limit'
import { safeParseBody } from '@/lib/validation'
import { logError } from '@/lib/logging'
import { deviceSignature } from '@/lib/device-signature'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.3.0 — in-app feedback.
 *
 * WHY prismaPrivileged, in a route any logged-in user can reach: `Feedback` is a
 * PLATFORM table, not a tenant one. It has no organizationId to arm and no
 * row-level policy, exactly like AccessAttempt, because the founder reads one
 * inbox spanning every organisation — and the migration revokes it from the app
 * role so a stray tenant query cannot reach across companies.
 *
 * That makes the guard here the only thing standing between a caller and the
 * table, so it is deliberately narrow: a valid session, a rate limit, a schema,
 * and a row whose author fields are taken from the SESSION rather than from the
 * body. Nothing a caller sends decides who they are.
 */
const submitSchema = z.object({
  kind: z.enum(['BUG', 'IDEA']),
  message: z.string().trim().min(3).max(5000),
  pageUrl: z.string().max(2000).optional(),
})

export async function POST(request: NextRequest) {
  const limited = await rateLimit(
    request,
    { windowMs: 60 * 60 * 1000, maxRequests: 20, message: 'Too much feedback at once — try again shortly.' },
    'feedback-submit',
  )
  if (limited) return limited

  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth

  const parsed = await safeParseBody(request)
  if (!parsed.success) return parsed.response
  const validation = submitSchema.safeParse(parsed.data)
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: validation.error.format() },
      { status: 400 },
    )
  }
  const { kind, message, pageUrl } = validation.data

  try {
    const orgId = (auth as any).organizationId ?? null
    // The organisation NAME is denormalised alongside the id for the same
    // reason the user's is: a company that later leaves must not turn its open
    // reports into anonymous rows.
    const org = orgId
      ? await prismaPrivileged.organization.findUnique({
          where: { id: orgId },
          select: { name: true },
        })
      : null

    const created = await prismaPrivileged.feedback.create({
      data: {
        kind,
        message,
        pageUrl: pageUrl || null,
        // 7.3.0: stamped by the SERVER, not sent by the browser. Which build a
        // report came from is the one field a caller has no business deciding,
        // and the server is the only party that actually knows.
        appVersion: process.env.npm_package_version || null,
        // Coarse browser:os signature, never the raw User-Agent — the same
        // rule the rest of the app follows for anything it stores about a
        // client.
        client: deviceSignature(request.headers.get('user-agent') || ''),
        userId: auth.id,
        userName: auth.name || null,
        userEmail: auth.email || null,
        organizationId: orgId,
        organizationName: org?.name ?? null,
      },
      select: { id: true },
    })

    return NextResponse.json({ id: created.id }, { status: 201 })
  } catch (error) {
    logError('[feedback] submit failed:', error)
    return NextResponse.json({ error: 'Could not send feedback' }, { status: 500 })
  }
}

/** The founder's inbox. Everyone else gets a 404 — see requirePlatformAdmin. */
export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const rows = await prismaPrivileged.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        attachments: {
          select: { id: true, fileName: true, fileType: true, fileSize: true },
        },
      },
    })
    const unread = await prismaPrivileged.feedback.count({ where: { status: 'NEW' } })

    return NextResponse.json({
      unread,
      items: rows.map((r) => ({
        ...r,
        // BigInt does not survive JSON.stringify.
        attachments: r.attachments.map((a) => ({ ...a, fileSize: a.fileSize.toString() })),
      })),
    })
  } catch (error) {
    logError('[feedback] listing failed:', error)
    return NextResponse.json({ error: 'Could not load feedback' }, { status: 500 })
  }
}
