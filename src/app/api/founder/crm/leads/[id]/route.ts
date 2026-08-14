import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { LEAD_STATUSES, getLeadDetail, logLeadActivity, type LeadStatus } from '@/lib/founder-crm'
import { prismaPrivileged } from '@/lib/db'
import { logPlatformAudit, actorFrom } from '@/lib/platform-audit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 6.6.0 — one lead: read with history, edit, delete. */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { id } = await params
    const detail = await getLeadDetail(id)
    if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    logError('[GET /api/founder/crm/leads/[id]] failed:', error)
    return NextResponse.json({ error: 'Failed to load the lead' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))

    const current = await (prismaPrivileged as any).lead.findUnique({
      where: { id },
      select: { id: true, status: true },
    })
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const data: any = {}
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 120)
    if (typeof body?.company === 'string') data.company = body.company.trim() || null
    if (typeof body?.profession === 'string') data.profession = body.profession.trim() || null
    if (typeof body?.notes === 'string') data.notes = body.notes.trim() || null
    if (body?.estimatedValueCents === null) data.estimatedValueCents = null
    else if (typeof body?.estimatedValueCents === 'number' && Number.isFinite(body.estimatedValueCents)) {
      data.estimatedValueCents = Math.max(0, Math.round(body.estimatedValueCents))
    }

    let statusChanged: LeadStatus | null = null
    if (typeof body?.status === 'string' && (LEAD_STATUSES as readonly string[]).includes(body.status)) {
      const next = body.status as LeadStatus
      if (next !== current.status) {
        statusChanged = next
        data.status = next
        // CUSTOMER set by hand carries no organization to point at — the
        // register flow is what fills convertedOrgId. Record the date anyway
        // so "won this month" counts it, and say in the timeline who did it.
        if (next === 'CUSTOMER') data.convertedAt = new Date()
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ ok: true, unchanged: true })
    }

    await (prismaPrivileged as any).lead.update({ where: { id }, data })

    if (statusChanged) {
      await logLeadActivity({
        leadId: id,
        type: 'STATUS_CHANGE',
        body: `${current.status} → ${statusChanged}`,
        authorId: auth.id,
        authorName: auth.name || auth.email,
      })
    }

    await logPlatformAudit({
      actor: actorFrom(auth),
      action: statusChanged ? 'lead.status_changed' : 'lead.updated',
      targetType: 'lead',
      targetId: id,
      summary: statusChanged ? `${current.status} → ${statusChanged}` : Object.keys(data).join(', '),
      ipAddress: request.headers.get('x-forwarded-for'),
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[PATCH /api/founder/crm/leads/[id]] failed:', error)
    return NextResponse.json({ error: 'Failed to update the lead' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { id } = await params
    // Activities and follow-ups cascade at the database level.
    await (prismaPrivileged as any).lead.delete({ where: { id } })
    await logPlatformAudit({
      actor: actorFrom(auth),
      action: 'lead.deleted',
      targetType: 'lead',
      targetId: id,
      ipAddress: request.headers.get('x-forwarded-for'),
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[DELETE /api/founder/crm/leads/[id]] failed:', error)
    return NextResponse.json({ error: 'Failed to delete the lead' }, { status: 500 })
  }
}
