import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { LEAD_STATUSES, listLeads, logLeadActivity, type LeadStatus } from '@/lib/founder-crm'
import { prismaPrivileged } from '@/lib/db'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 6.6.0 — the pipeline list (GET) and manual lead creation (POST). */

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const params = request.nextUrl.searchParams
    const statusRaw = params.get('status') ?? 'ALL'
    const status =
      statusRaw === 'ALL' || statusRaw === 'OPEN'
        ? (statusRaw as 'ALL' | 'OPEN')
        : (LEAD_STATUSES as readonly string[]).includes(statusRaw)
          ? (statusRaw as LeadStatus)
          : 'ALL'

    const data = await listLeads({ status, query: params.get('q') ?? undefined })
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    logError('[GET /api/founder/crm/leads] failed:', error)
    return NextResponse.json({ error: 'Failed to load leads' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const body = await request.json().catch(() => ({}))
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const company = typeof body?.company === 'string' ? body.company.trim() : ''
    const profession = typeof body?.profession === 'string' ? body.profession.trim() : ''
    const notes = typeof body?.notes === 'string' ? body.notes.trim() : ''
    const estimated =
      typeof body?.estimatedValueCents === 'number' && Number.isFinite(body.estimatedValueCents)
        ? Math.max(0, Math.round(body.estimatedValueCents))
        : null

    if (!name || name.length > 120) {
      return NextResponse.json({ error: 'A name is required.' }, { status: 400 })
    }
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })
    }

    const existing = await (prismaPrivileged as any).lead.findUnique({
      where: { email },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'A lead with that email already exists.', leadId: existing.id },
        { status: 409 },
      )
    }

    const lead = await (prismaPrivileged as any).lead.create({
      data: {
        name,
        email,
        company: company || null,
        profession: profession || null,
        notes: notes || null,
        estimatedValueCents: estimated,
        source: 'manual',
        status: 'NEW',
      },
    })
    await logLeadActivity({
      leadId: lead.id,
      type: 'NOTE',
      body: 'Added by hand.',
      authorId: auth.id,
      authorName: auth.name || auth.email,
    })

    return NextResponse.json({ ok: true, id: lead.id }, { status: 201 })
  } catch (error) {
    logError('[POST /api/founder/crm/leads] failed:', error)
    return NextResponse.json({ error: 'Failed to create the lead' }, { status: 500 })
  }
}
