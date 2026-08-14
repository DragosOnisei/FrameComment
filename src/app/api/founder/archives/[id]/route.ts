import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { getArchivedMetrics, deleteArchive } from '@/lib/platform-archive'
import { buildPlatformReportPdf } from '@/lib/founder-report-pdf'
import { logPlatformAudit, actorFrom } from '@/lib/platform-audit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 6.8.0 — download an archived period as PDF, or delete the archive.
 *
 * The PDF is rendered from the FROZEN figures, by the same renderer the live
 * report uses. Opening a March report in July gives you March's numbers.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { id } = await params
    const archived = await getArchivedMetrics(id)
    if (!archived) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const pdf = await buildPlatformReportPdf(archived.metrics)
    const safeLabel = archived.label.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase()

    await logPlatformAudit({
      actor: actorFrom(auth),
      action: 'archive.downloaded',
      targetType: 'archive',
      targetId: id,
      summary: archived.label,
      ipAddress: request.headers.get('x-forwarded-for'),
    })

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="framecomment-${safeLabel}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    logError('[GET /api/founder/archives/[id]] failed:', error)
    return NextResponse.json({ error: 'Failed to build the report' }, { status: 500 })
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
    await deleteArchive(id)
    await logPlatformAudit({
      actor: actorFrom(auth),
      action: 'archive.deleted',
      targetType: 'archive',
      targetId: id,
      ipAddress: request.headers.get('x-forwarded-for'),
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[DELETE /api/founder/archives/[id]] failed:', error)
    return NextResponse.json({ error: 'Failed to delete the archive' }, { status: 500 })
  }
}
