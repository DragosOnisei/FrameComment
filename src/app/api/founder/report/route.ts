import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/platform'
import { computeFounderMetrics, parseRange } from '@/lib/founder-metrics'
import { buildPlatformReportPdf } from '@/lib/founder-report-pdf'
import { logPlatformAudit, actorFrom } from '@/lib/platform-audit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 6.5.0 — GET /api/founder/report?from&to
 *
 * The same numbers as the dashboard, as a PDF you can hand to someone.
 * 6.8.0: the rendering lives in lib/founder-report-pdf so the archive can
 * produce an identical document from frozen figures.
 */
export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { from, to } = parseRange(request.nextUrl.searchParams)
    const metrics = await computeFounderMetrics(from, to)
    const pdf = await buildPlatformReportPdf(metrics)
    const stamp = new Date().toISOString().slice(0, 10)
    await logPlatformAudit({
      actor: actorFrom(auth),
      action: 'report.downloaded',
      summary: `Platform report for ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`,
      ipAddress: request.headers.get('x-forwarded-for'),
    })
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="framecomment-platform-${stamp}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    logError('[GET /api/founder/report] failed:', error)
    return NextResponse.json({ error: 'Failed to build report' }, { status: 500 })
  }
}
