import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { archivePeriod, listArchives } from '@/lib/platform-archive'
import { logPlatformAudit, actorFrom } from '@/lib/platform-audit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000

/** 6.8.0 — list archived periods (GET) and freeze a new one (POST). */

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    return NextResponse.json(
      { archives: await listArchives(50) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    logError('[GET /api/founder/archives] failed:', error)
    return NextResponse.json({ error: 'Failed to list archives' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const body = await request.json().catch(() => ({}))

    // Default: the month that just ended. Archiving a period while it is
    // still running would freeze a half-month and label it a month.
    const now = new Date()
    const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))

    const from = body?.from ? new Date(body.from) : defaultFrom
    const to = body?.to ? new Date(body.to) : defaultTo
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      return NextResponse.json({ error: 'That period does not make sense.' }, { status: 400 })
    }

    const label =
      typeof body?.label === 'string' && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : to.getTime() - from.getTime() <= 32 * DAY_MS
          ? from.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
          : null

    const result = await archivePeriod({
      from,
      to,
      label,
      actorId: auth.id,
      actorName: auth.name || auth.email,
    })

    await logPlatformAudit({
      actor: actorFrom(auth),
      action: 'archive.created',
      targetType: 'archive',
      targetId: result.id,
      summary: `Froze the figures for ${result.label}`,
      ipAddress: request.headers.get('x-forwarded-for'),
    })

    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (error) {
    logError('[POST /api/founder/archives] failed:', error)
    return NextResponse.json({ error: 'Failed to archive the period' }, { status: 500 })
  }
}
