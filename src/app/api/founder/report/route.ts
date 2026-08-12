import { NextRequest, NextResponse } from 'next/server'
import PDFDocument from 'pdfkit'
import { requirePlatformAdmin } from '@/lib/platform'
import { computeFounderMetrics, parseRange, type FounderMetrics } from '@/lib/founder-metrics'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 6.5.0 — GET /api/founder/report?from&to
 *
 * The same numbers as the dashboard, as a PDF you can hand to someone. Built
 * with pdfkit (already used for transcripts) so no new dependency.
 *
 * It states its own limits on the page: the invoiced figure is a floor, and
 * the report says where the complete ledger lives. A document that quietly
 * overstates revenue is worse than no document.
 */

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function buildPdf(m: FounderMetrics): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 56, size: 'A4' })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      const from = new Date(m.range.from)
      const to = new Date(m.range.to)
      const period = `${from.toLocaleDateString()} – ${to.toLocaleDateString()}`

      doc.fontSize(20).fillColor('#111111').text('FrameComment')
      doc.moveDown(0.1).fontSize(12).fillColor('#666666').text(`Platform report · ${period}`)
      doc.moveDown(0.2).fontSize(9).fillColor('#999999')
        .text(`Generated ${new Date().toLocaleString()}`)
      doc.moveDown(0.8)
      doc.strokeColor('#dddddd').lineWidth(1)
        .moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke()
      doc.moveDown(0.8)

      const row = (label: string, value: string) => {
        doc.fontSize(10).fillColor('#666666').text(label, { continued: true })
        doc.fillColor('#111111').text(`   ${value}`)
        doc.moveDown(0.25)
      }

      doc.fontSize(13).fillColor('#111111').text('Revenue')
      doc.moveDown(0.35)
      row('Recurring, at current usage', `${money(m.revenue.mrrCents)} / month`)
      row('Invoiced in period (recorded locally)', money(m.revenue.invoicedInRangeCents))
      doc.fontSize(8).fillColor('#999999').text(m.revenue.revenueNote, { width: 420 })
      doc.moveDown(0.8)

      doc.fontSize(13).fillColor('#111111').text('Customers')
      doc.moveDown(0.35)
      row('Companies', String(m.companies.total))
      row('Active', String(m.companies.active))
      row('Paying (card on file)', String(m.companies.paying))
      row('New in period', String(m.companies.newInRange))
      row('Suspended', String(m.companies.suspended))
      doc.moveDown(0.6)

      doc.fontSize(13).fillColor('#111111').text('Usage')
      doc.moveDown(0.35)
      row('Users', `${m.users.total} (${m.users.newInRange} new)`)
      row('Storage stored', bytes(m.storage.totalBytes))
      row('Storage billable', bytes(m.storage.billableBytes))
      row('Uploads in period', String(m.activity.uploads))
      row('Comments in period', String(m.activity.comments))
      row('Approvals in period', String(m.activity.approvals))
      row('Projects created', String(m.activity.projectsCreated))
      doc.moveDown(0.8)

      doc.fontSize(13).fillColor('#111111').text('Companies')
      doc.moveDown(0.4)
      doc.fontSize(9).fillColor('#666666')
      const cols = [56, 230, 300, 380, 470]
      doc.text('Company', cols[0], doc.y, { continued: false })
      const headerY = doc.y - 11
      doc.text('Users', cols[1], headerY)
      doc.text('Storage', cols[2], headerY)
      doc.text('Billing', cols[3], headerY)
      doc.text('Est. / mo', cols[4], headerY)
      doc.moveDown(0.3)

      for (const c of m.companiesTable) {
        if (doc.y > doc.page.height - 90) {
          doc.addPage()
        }
        const y = doc.y
        doc.fontSize(9).fillColor('#111111')
          .text(c.name.slice(0, 28), cols[0], y, { width: 165 })
        doc.fillColor('#333333')
        doc.text(String(c.users), cols[1], y)
        doc.text(bytes(c.storageBytes), cols[2], y)
        doc.text(c.hasCard ? c.billingStatus : 'no card', cols[3], y)
        doc.text(money(c.estimatedMonthlyCents), cols[4], y)
        doc.moveDown(0.35)
      }

      doc.moveDown(1)
      doc.fontSize(8).fillColor('#999999').text(
        'Figures are computed from this instance’s own records. Storage and user counts come from the daily billing snapshots; revenue at current usage applies the published pricing to those snapshots.',
        56,
        doc.y,
        { width: 480 },
      )

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  try {
    const { from, to } = parseRange(request.nextUrl.searchParams)
    const metrics = await computeFounderMetrics(from, to)
    const pdf = await buildPdf(metrics)
    const stamp = new Date().toISOString().slice(0, 10)
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
