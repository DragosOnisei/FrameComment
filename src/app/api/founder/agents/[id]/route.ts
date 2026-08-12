import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { prismaPrivileged } from '@/lib/db'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 6.7.0 — turn an agent on or off, or rename it. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    const data: any = {}
    if (typeof body?.enabled === 'boolean') data.enabled = body.enabled
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 80)
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ ok: true, unchanged: true })
    }

    await (prismaPrivileged as any).agent.update({ where: { id }, data })
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[PATCH /api/founder/agents/[id]] failed:', error)
    return NextResponse.json({ error: 'Failed to update the agent' }, { status: 500 })
  }
}
