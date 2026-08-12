import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { logLeadActivity } from '@/lib/founder-crm'
import { prismaPrivileged } from '@/lib/db'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 6.6.0 — schedule a follow-up (POST), mark one done (PATCH), drop one (DELETE). */

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const rows = await (prismaPrivileged as any).followUp.findMany({
      where: { doneAt: null },
      orderBy: { dueAt: 'asc' },
      take: 100,
      include: { lead: { select: { id: true, name: true, email: true, status: true } } },
    })
    const now = new Date()
    return NextResponse.json(
      {
        followUps: rows.map((f: any) => ({
          id: f.id,
          dueAt: f.dueAt.toISOString(),
          note: f.note ?? null,
          overdue: f.dueAt < now,
          lead: f.lead,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    logError('[GET /api/founder/crm/follow-ups] failed:', error)
    return NextResponse.json({ error: 'Failed to load follow-ups' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const body = await request.json().catch(() => ({}))
    const leadId = typeof body?.leadId === 'string' ? body.leadId : ''
    const dueAtRaw = typeof body?.dueAt === 'string' ? body.dueAt : ''
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : ''

    const dueAt = new Date(dueAtRaw)
    if (!leadId || Number.isNaN(dueAt.getTime())) {
      return NextResponse.json({ error: 'A lead and a date are required.' }, { status: 400 })
    }

    const lead = await (prismaPrivileged as any).lead.findUnique({
      where: { id: leadId },
      select: { id: true },
    })
    if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await (prismaPrivileged as any).followUp.create({
      data: { leadId, dueAt, note: note || null, createdById: auth.id },
    })
    await logLeadActivity({
      leadId,
      type: 'NOTE',
      body: `Follow-up scheduled for ${dueAt.toISOString().slice(0, 10)}${note ? ` — ${note}` : ''}`,
      authorId: auth.id,
      authorName: auth.name || auth.email,
    })

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) {
    logError('[POST /api/founder/crm/follow-ups] failed:', error)
    return NextResponse.json({ error: 'Failed to schedule the follow-up' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const body = await request.json().catch(() => ({}))
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const followUp = await (prismaPrivileged as any).followUp.findUnique({
      where: { id },
      select: { id: true, leadId: true, doneAt: true },
    })
    if (!followUp) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // `done: false` reopens it — undo should be possible without a database.
    const done = body?.done !== false
    await (prismaPrivileged as any).followUp.update({
      where: { id },
      data: { doneAt: done ? new Date() : null },
    })
    if (done && !followUp.doneAt) {
      await logLeadActivity({
        leadId: followUp.leadId,
        type: 'NOTE',
        body: 'Follow-up done.',
        authorId: auth.id,
        authorName: auth.name || auth.email,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[PATCH /api/founder/crm/follow-ups] failed:', error)
    return NextResponse.json({ error: 'Failed to update the follow-up' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const id = request.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    await (prismaPrivileged as any).followUp.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[DELETE /api/founder/crm/follow-ups] failed:', error)
    return NextResponse.json({ error: 'Failed to delete the follow-up' }, { status: 500 })
  }
}
