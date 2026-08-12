import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { LEAD_ACTIVITY_TYPES, logLeadActivity, type LeadActivityType } from '@/lib/founder-crm'
import { prismaPrivileged } from '@/lib/db'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 6.6.0 — log something that happened with a lead (call, email, demo, note).
 *
 * Anything except a plain note also moves `lastContactedAt`, because that is
 * what "we talked to them" means, and the list sorts on it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    const typeRaw = typeof body?.type === 'string' ? body.type : 'NOTE'
    // STATUS_CHANGE is written by the app, never by hand — it would let the
    // timeline claim a transition that never happened.
    const type: LeadActivityType =
      (LEAD_ACTIVITY_TYPES as readonly string[]).includes(typeRaw) && typeRaw !== 'STATUS_CHANGE'
        ? (typeRaw as LeadActivityType)
        : 'NOTE'
    const text = typeof body?.body === 'string' ? body.body.trim().slice(0, 4000) : ''

    if (!text) {
      return NextResponse.json({ error: 'Write something first.' }, { status: 400 })
    }

    const lead = await (prismaPrivileged as any).lead.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await logLeadActivity({
      leadId: id,
      type,
      body: text,
      authorId: auth.id,
      authorName: auth.name || auth.email,
    })

    if (type !== 'NOTE') {
      await (prismaPrivileged as any).lead.update({
        where: { id },
        data: { lastContactedAt: new Date() },
      })
    }

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) {
    logError('[POST /api/founder/crm/leads/[id]/activities] failed:', error)
    return NextResponse.json({ error: 'Failed to log the activity' }, { status: 500 })
  }
}
