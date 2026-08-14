/**
 * 6.8.0 — the platform report PDF, in one place.
 *
 * Extracted from the report route in Faza 5 so the archive can render the
 * SAME document from frozen figures. Two renderers would drift, and a report
 * that looks different depending on where you downloaded it is a report
 * nobody trusts.
 *
 * The document states its own limits on the page: the invoiced figure is a
 * floor, and it says where the complete ledger lives. A document that quietly
 * overstates revenue is worse than no document.
 */

import PDFDocument from 'pdfkit'
import type { FounderMetrics } from './founder-metrics'

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

export function buildPlatformReportPdf(m: FounderMetrics): Promise<Buffer> {
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

      const p = m.revenue.pricing
      const unit = (cents: number) => `$${(cents / 100).toFixed(2)}`

      doc.fontSize(13).fillColor('#111111').text('Revenue')
      doc.moveDown(0.35)
      row(
        'Charged for users',
        `${money(m.revenue.mrrUserCents)} / month  (${m.revenue.billableUsers} paid users × ${unit(p.perUserPerMonthCents)}; ${p.freeUsers} free per company)`,
      )
      row(
        'Charged for storage',
        `${money(m.revenue.mrrStorageCents)} / month  (${m.revenue.billableGiB} paid GB × ${unit(p.perGibPerMonthCents)}; ${p.freeGib} GB free per company)`,
      )
      row('Recurring total, at current usage', `${money(m.revenue.mrrCents)} / month`)
      row('Invoiced in period (recorded locally)', money(m.revenue.invoicedInRangeCents))
      doc.fontSize(8).fillColor('#999999').text(m.revenue.revenueNote, { width: 460 })
      doc.moveDown(0.2)
      doc.fontSize(8).fillColor('#999999').text(
        'Only storage on the FrameComment backend is charged per GiB; files kept on a company’s own Local / R2 / AWS storage cost seats only.',
        { width: 460 },
      )
      doc.moveDown(0.8)

      doc.fontSize(13).fillColor('#111111').text('Customers')
      doc.moveDown(0.35)
      row('Companies', String(m.companies.total))
      row('Active', String(m.companies.active))
      row('On paid tier', String(m.companies.onPaidTier))
      row('On free tier', String(m.companies.onFreeTier))
      row('With a card on file', String(m.companies.paying))
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
      const cols = [56, 190, 250, 320, 375, 445]
      doc.text('Company', cols[0], doc.y, { continued: false })
      const headerY = doc.y - 11
      doc.text('Users', cols[1], headerY)
      doc.text('Storage', cols[2], headerY)
      doc.text('Tier', cols[3], headerY)
      doc.text('Seats + storage', cols[4], headerY)
      doc.text('Est. / mo', cols[5], headerY)
      doc.moveDown(0.3)

      for (const c of m.companiesTable) {
        if (doc.y > doc.page.height - 90) {
          doc.addPage()
        }
        const y = doc.y
        doc.fontSize(9).fillColor('#111111')
          .text(c.name.slice(0, 24), cols[0], y, { width: 128 })
        doc.fillColor('#333333')
        doc.text(c.billableUsers > 0 ? `${c.users} (${c.billableUsers})` : String(c.users), cols[1], y)
        doc.text(bytes(c.storageBytes), cols[2], y)
        // Tier is the plan; a paid company with no card is the exception worth
        // naming, so it travels with the tier instead of hiding in a footnote.
        doc.text(
          c.tier === 'paid' ? (c.hasCard ? 'Paid' : 'Paid · no card') : 'Free',
          cols[3],
          y,
          { width: 68 },
        )
        doc.text(
          c.estimatedMonthlyCents > 0
            ? `${money(c.estimatedUserCents)} + ${money(c.estimatedStorageCents)}`
            : '—',
          cols[4],
          y,
        )
        doc.text(money(c.estimatedMonthlyCents), cols[5], y)
        doc.moveDown(0.35)
      }

      doc.moveDown(1)
      doc.fontSize(8).fillColor('#999999').text(
        'Figures are computed from this instance’s own records. Recurring revenue is measured live — current users and current bytes on the FrameComment backend — the same way each company’s own Billing page measures it, so the two agree.',
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
