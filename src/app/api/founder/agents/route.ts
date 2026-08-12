import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { listAgents, listReports } from '@/lib/founder-agents'
import { getOpenAiApiKey } from '@/lib/settings'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 6.7.0 — the agent registry plus recent reports. */
export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const [agents, reports, key] = await Promise.all([
      listAgents(),
      listReports(20),
      getOpenAiApiKey(),
    ])
    return NextResponse.json(
      // `modelConfigured: false` is why a report may arrive without a
      // narrative — the UI says so instead of leaving it a mystery.
      { agents, reports, modelConfigured: !!key },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    logError('[GET /api/founder/agents] failed:', error)
    return NextResponse.json({ error: 'Failed to load agents' }, { status: 500 })
  }
}
