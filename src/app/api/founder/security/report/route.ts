/**
 * GET /api/founder/security/report — 6.20.0
 *
 * The PDF of a scan. `?id=` for a specific run, otherwise the most recent
 * completed one.
 *
 * Deliberately only COMPLETED runs. Handing someone a PDF of a scan that was
 * still going would produce a document whose numbers do not add up, and the
 * person receiving it has no way to know that — they would just conclude the
 * report is wrong, which is the correct conclusion for the wrong reason.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { buildSecurityReportPdf } from '@/lib/security-report-pdf'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const id = request.nextUrl.searchParams.get('id')

  try {
    const scan = id
      ? await (prismaPrivileged as any).securityScan.findUnique({
          where: { id },
          include: { findings: { orderBy: { createdAt: 'asc' } } },
        })
      : await (prismaPrivileged as any).securityScan.findFirst({
          where: { status: 'COMPLETED' },
          orderBy: { startedAt: 'desc' },
          include: { findings: { orderBy: { createdAt: 'asc' } } },
        })

    if (!scan) {
      return NextResponse.json({ error: 'No completed scan to report on yet.' }, { status: 404 })
    }
    if (scan.status !== 'COMPLETED') {
      return NextResponse.json(
        { error: 'That scan has not finished. Wait for it to complete, then download.' },
        { status: 409 },
      )
    }

    const pdf = await buildSecurityReportPdf(scan)

    // A filename someone can find again in six months, sorted by date, with
    // the environment in it — a folder of "report.pdf" is a folder of nothing.
    const stamp = new Date(scan.finishedAt || scan.startedAt).toISOString().slice(0, 10)
    const env = (scan.environment || 'unknown').split('·')[0].trim().replace(/[^a-z0-9]+/gi, '-')
    const kind = (scan.kind || 'FULL').toLowerCase()
    const filename = `framecomment-security-${kind}-${env}-${stamp}.pdf`

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdf.length),
        // Never cached: the same URL renders a different document as soon as
        // a newer scan finishes.
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    logError('[FOUNDER/SECURITY] report failed:', error)
    return NextResponse.json({ error: 'Could not build the report' }, { status: 500 })
  }
}
