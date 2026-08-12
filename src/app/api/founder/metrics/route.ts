import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { computeFounderMetrics, parseRange } from '@/lib/founder-metrics'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 6.4.0 — GET /api/founder/metrics?from&to
 *
 * Platform-wide figures for the Founder dashboard. Gated to the founder
 * (`requirePlatformAdmin` answers 404 to everyone else, so the surface isn't
 * discoverable), read-only, and computed from data already in the database.
 */
export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { from, to } = parseRange(request.nextUrl.searchParams)
    const metrics = await computeFounderMetrics(from, to)
    return NextResponse.json(metrics, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    logError('[GET /api/founder/metrics] failed:', error)
    return NextResponse.json({ error: 'Failed to compute metrics' }, { status: 500 })
  }
}
