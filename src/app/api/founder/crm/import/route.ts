import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { importLeadsFromAccessRequests } from '@/lib/founder-crm'
import { logPlatformAudit, actorFrom } from '@/lib/platform-audit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 6.6.0 — pull every past access request into the pipeline.
 *
 * Before the CRM existed those requests only became in-app notifications, so
 * this reads them back and upserts a lead per email. Idempotent: a second run
 * reports the same people as skipped rather than duplicating them.
 */
export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const result = await importLeadsFromAccessRequests()
    await logPlatformAudit({
      actor: actorFrom(auth),
      action: 'lead.imported',
      summary: `Scanned ${result.scanned}, imported ${result.imported}, skipped ${result.skipped}`,
      ipAddress: request.headers.get('x-forwarded-for'),
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    logError('[POST /api/founder/crm/import] failed:', error)
    return NextResponse.json({ error: 'Import failed' }, { status: 500 })
  }
}
