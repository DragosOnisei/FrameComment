import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { computeRetention, computeSecurityPosture } from '@/lib/platform-investor'
import { computeUptime } from '@/lib/platform-uptime'
import { listAuditEvents } from '@/lib/platform-audit'
import { listArchives } from '@/lib/platform-archive'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000

/** 6.8.0 — everything the investor pack page shows, in one call. */
export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const days = Math.min(
      365,
      Math.max(1, Number(request.nextUrl.searchParams.get('days') || 90)),
    )
    const to = new Date()
    const from = new Date(to.getTime() - days * DAY_MS)

    const [retention, posture, uptime, audit, archives] = await Promise.all([
      computeRetention(),
      computeSecurityPosture(),
      computeUptime(from, to),
      listAuditEvents(100),
      listArchives(50),
    ])

    return NextResponse.json(
      { range: { from: from.toISOString(), to: to.toISOString(), days }, retention, posture, uptime, audit, archives },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    logError('[GET /api/founder/investors] failed:', error)
    return NextResponse.json({ error: 'Failed to load the investor pack' }, { status: 500 })
  }
}
