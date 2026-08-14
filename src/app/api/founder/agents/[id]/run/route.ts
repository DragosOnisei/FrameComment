import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { runAgent } from '@/lib/founder-agents'
import { prismaPrivileged } from '@/lib/db'
import { logPlatformAudit, actorFrom } from '@/lib/platform-audit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Reports are small but the model call can take a while; give it room.
export const maxDuration = 120

/**
 * 6.7.0 — run one agent now.
 *
 * Runs inline rather than through the worker queue: this is a founder-only
 * action, at most a handful of database reads plus one model call, and doing
 * it inline means the result is on screen when the request returns. If agents
 * later run on a schedule, that path belongs in the worker.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { id } = await params

    const agent = await (prismaPrivileged as any).agent.findUnique({
      where: { id },
      select: { id: true, enabled: true },
    })
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!agent.enabled) {
      return NextResponse.json({ error: 'This agent is turned off.' }, { status: 400 })
    }

    // Refuse to pile up runs: one at a time per agent keeps the cost honest.
    const running = await (prismaPrivileged as any).agentRun.findFirst({
      where: { agentId: id, status: 'RUNNING' },
      select: { id: true, startedAt: true },
    })
    if (running && Date.now() - new Date(running.startedAt).getTime() < 5 * 60 * 1000) {
      return NextResponse.json({ error: 'This agent is already running.' }, { status: 409 })
    }

    const result = await runAgent(id, auth.name || auth.email)
    await logPlatformAudit({
      actor: actorFrom(auth),
      action: 'agent.run',
      targetType: 'agent',
      targetId: id,
      summary: result.status === 'SUCCEEDED' ? 'succeeded' : `failed: ${result.error ?? 'unknown'}`,
      ipAddress: request.headers.get('x-forwarded-for'),
    })
    if (result.status === 'FAILED') {
      return NextResponse.json({ error: result.error || 'The run failed.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, runId: result.runId })
  } catch (error) {
    logError('[POST /api/founder/agents/[id]/run] failed:', error)
    return NextResponse.json({ error: 'Failed to run the agent' }, { status: 500 })
  }
}
