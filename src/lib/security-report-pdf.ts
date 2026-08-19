/**
 * 6.20.0 — the security report as a PDF.
 *
 * Built with pdfkit, the same renderer as the platform report, so there is one
 * PDF stack in this codebase rather than two that drift.
 *
 * WHAT THIS DOCUMENT IS FOR
 *
 * It leaves the building. Someone will email it to an investor, an insurer or
 * a client's IT department, and it will be read by people who cannot ask a
 * follow-up question. That shapes every decision below:
 *
 *  - It states which installation it describes, in the header and again in the
 *    footer. A report of a laptop presented as production is the single worst
 *    outcome this feature could produce, and the only defence is that the
 *    document says so on every page.
 *  - Failures and warnings come first, with the plain-language line. Passing
 *    checks are listed after, compactly. A report that opens with forty green
 *    ticks is a marketing document; one that opens with what is wrong is a
 *    security document.
 *  - Checks that could not run are shown as their own group, never merged into
 *    the passes. The difference between "we verified this" and "we could not
 *    verify this" is the entire value of the report.
 *  - No logos, no gradients, no score dial. It prints in black and white on
 *    somebody's office printer and still reads.
 */

import PDFDocument from 'pdfkit'

export interface ReportFinding {
  stage: string
  checkId: string
  title: string
  status: string
  severity: string
  detail: string | null
  remediation: string | null
  impact: string | null
}

export interface ReportScan {
  id: string
  kind?: string | null
  status: string
  score: number | null
  passed: number
  warnings: number
  failures: number
  skipped?: number | null
  durationMs?: number | null
  environment?: string | null
  startedAt: Date | string
  finishedAt: Date | string | null
  startedByName: string | null
  findings: ReportFinding[]
}

const INK = '#111111'
const MUTED = '#666666'
const FAINT = '#999999'
const RULE = '#dddddd'
const RED = '#a4262c'
const AMBER = '#8a6d1f'
const GREEN = '#1d6b3f'

const STAGE_LABELS: Record<string, string> = {
  server: 'Server state',
  transport: 'Transport',
  secrets: 'Secrets',
  isolation: 'Tenant isolation',
  sessions: 'Sessions',
  accounts: 'Accounts',
  exposure: 'Data exposure',
  files: 'File integrity',
  content: 'Content safety',
  dependencies: 'Dependencies',
  reputation: 'Mail reputation',
  privacy: 'Privacy',
}

export function buildSecurityReportPdf(scan: ReportScan): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      /*
       * `bufferPages` is what makes the footer loop below work. Without it,
       * pdfkit flushes each page as it is finished, `bufferedPageRange()`
       * reports a single page, and `switchToPage` appends a NEW page instead
       * of returning to an old one — which is why the first production report
       * ended with a blank page and every footer read "page 1 of 1".
       */
      const doc = new PDFDocument({ margin: 56, size: 'A4', bufferPages: true })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      const right = () => doc.page.width - doc.page.margins.right
      const width = () => right() - doc.page.margins.left

      const rule = () => {
        doc.strokeColor(RULE).lineWidth(1)
          .moveTo(doc.page.margins.left, doc.y).lineTo(right(), doc.y).stroke()
      }

      /**
       * Start a new page before a block that would otherwise be orphaned.
       * A finding split across a page break — title on one page, the sentence
       * explaining it on the next — is exactly the finding somebody
       * misreads.
       */
      const keepTogether = (needed: number) => {
        if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage()
      }

      const finished = scan.finishedAt ? new Date(scan.finishedAt) : new Date(scan.startedAt)
      const isDaily = (scan.kind || 'FULL') === 'DAILY'
      const total = scan.passed + scan.warnings + scan.failures + (scan.skipped || 0)

      // ── Header ──────────────────────────────────────────────────────────
      doc.fontSize(20).fillColor(INK).text('FrameComment')
      doc.moveDown(0.1).fontSize(12).fillColor(MUTED)
        .text(`Security report · ${isDaily ? 'Daily checks' : 'Full scan'}`)
      doc.moveDown(0.2).fontSize(9).fillColor(FAINT)
        .text(`${finished.toLocaleString()}${scan.startedByName ? ` · started by ${scan.startedByName}` : ''}`)
      // Said here and repeated in the footer. A report of a developer laptop
      // read as production is the worst thing this document could cause.
      if (scan.environment) {
        doc.fontSize(9).fillColor(FAINT).text(`Environment: ${scan.environment}`)
      }
      doc.moveDown(0.8)
      rule()
      doc.moveDown(0.8)

      // ── Summary ─────────────────────────────────────────────────────────
      const summaryY = doc.y
      doc.fontSize(34).fillColor(
        scan.score == null ? MUTED : scan.score >= 90 ? GREEN : scan.score >= 70 ? AMBER : RED,
      ).text(scan.score == null ? '—' : String(scan.score), doc.page.margins.left, summaryY, { continued: false })
      doc.fontSize(10).fillColor(FAINT).text('out of 100', doc.page.margins.left, doc.y - 4)

      const boxX = doc.page.margins.left + 120
      doc.y = summaryY
      const stat = (label: string, value: string, colour: string) => {
        doc.fontSize(9).fillColor(FAINT).text(label, boxX, doc.y, { continued: true })
        doc.fontSize(9).fillColor(colour).text(`   ${value}`)
      }
      stat('Checks run', String(total), INK)
      stat('Passed', String(scan.passed), GREEN)
      stat('Warnings', String(scan.warnings), scan.warnings ? AMBER : MUTED)
      stat('Failures', String(scan.failures), scan.failures ? RED : MUTED)
      if (scan.skipped) stat('Could not run', String(scan.skipped), MUTED)
      if (scan.durationMs != null) stat('Duration', `${(scan.durationMs / 1000).toFixed(1)}s`, MUTED)

      doc.x = doc.page.margins.left
      doc.moveDown(1.2)

      // Say plainly what a daily report does NOT cover. A reader who does not
      // know the difference will otherwise treat it as a full audit.
      if (isDaily) {
        doc.fontSize(9).fillColor(MUTED).text(
          'This is a daily run: it covers only the checks whose answer can change without a ' +
          'deployment. File integrity, dependency advisories, content safety and mail reputation ' +
          'are verified by the weekly full scan.',
          { width: width() },
        )
        doc.moveDown(0.8)
      }

      const bySeverity = (a: ReportFinding, b: ReportFinding) => {
        const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }
        return (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
      }

      const failures = scan.findings.filter((f) => f.status === 'FAIL').sort(bySeverity)
      const warnings = scan.findings.filter((f) => f.status === 'WARN').sort(bySeverity)
      const skipped = scan.findings.filter((f) => f.status === 'SKIPPED')
      const passes = scan.findings.filter((f) => f.status === 'PASS')

      const section = (title: string, count: number, colour: string) => {
        keepTogether(60)
        doc.moveDown(0.4)
        doc.fontSize(12).fillColor(colour).text(`${title} (${count})`)
        doc.moveDown(0.3)
        rule()
        doc.moveDown(0.5)
      }

      const finding = (f: ReportFinding, colour: string, mark: string) => {
        keepTogether(90)
        doc.fontSize(10).fillColor(colour).text(`${mark}  ${f.title}`, { continued: true })
        doc.fontSize(8).fillColor(FAINT)
          .text(`   ${STAGE_LABELS[f.stage] || f.stage}${f.severity !== 'INFO' ? ` · ${f.severity}` : ''}`)
        if (f.impact) {
          // The plain-language line first: whether to care precedes what to do.
          doc.moveDown(0.15).fontSize(9.5).fillColor(INK)
            .text(f.impact, { width: width() - 14, indent: 14 })
        }
        if (f.detail) {
          doc.moveDown(0.15).fontSize(8.5).fillColor(MUTED)
            .text(`Observed: ${f.detail}`, { width: width() - 14, indent: 14 })
        }
        if (f.remediation) {
          doc.moveDown(0.1).fontSize(8.5).fillColor(MUTED)
            .text(`Fix: ${f.remediation}`, { width: width() - 14, indent: 14 })
        }
        doc.moveDown(0.6)
      }

      if (failures.length) {
        section('Failing', failures.length, RED)
        failures.forEach((f) => finding(f, RED, '✗'))
      }
      if (warnings.length) {
        section('Warnings', warnings.length, AMBER)
        warnings.forEach((f) => finding(f, AMBER, '!'))
      }
      if (!failures.length && !warnings.length) {
        doc.moveDown(0.4)
        doc.fontSize(11).fillColor(GREEN).text('No failures or warnings.')
        doc.moveDown(0.6)
      }

      // Its own group, never folded into the passes: "we could not verify
      // this" and "this is fine" are different claims, and conflating them is
      // how a report becomes dishonest without anyone lying.
      if (skipped.length) {
        section('Could not be checked', skipped.length, MUTED)
        skipped.forEach((f) => {
          keepTogether(40)
          doc.fontSize(9.5).fillColor(MUTED).text(`–  ${f.title}`)
          if (f.detail) {
            doc.fontSize(8.5).fillColor(FAINT).text(f.detail, { width: width() - 14, indent: 14 })
          }
          doc.moveDown(0.35)
        })
      }

      if (passes.length) {
        section('Passed', passes.length, GREEN)
        // Compact: a reader who cares about a specific passing check wants to
        // find it, not read a paragraph about it.
        passes.forEach((f) => {
          keepTogether(24)
          doc.fontSize(9).fillColor(INK).text(`✓  ${f.title}`, { continued: true })
          doc.fontSize(8).fillColor(FAINT).text(`   ${f.detail || ''}`, { width: width() - 200 })
        })
        doc.moveDown(0.6)
      }

      /*
       * ── Footer on every page ──────────────────────────────────────────
       *
       * `margins.bottom = 0` around the write is what stops this loop from
       * ADDING pages. The footer sits deliberately below the bottom margin, and
       * pdfkit reads any write past that margin as an overflow and starts a new
       * page — so a two-page report came out with two extra pages carrying
       * nothing but a footer line each. `bufferPages` (6.20.1) fixed the
       * related bug where every footer read "page 1 of 1"; it did not fix this
       * one, and the smoke test at the time counted content streams rather than
       * pages, so it passed while the document was visibly wrong.
       *
       * The margin is restored per page: `switchToPage` hands back a real page
       * object, and leaving it at zero would change how anything written
       * afterwards flows.
       */
      const range = doc.bufferedPageRange()
      for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i)
        const savedBottom = doc.page.margins.bottom
        doc.page.margins.bottom = 0
        const y = doc.page.height - savedBottom + 12
        doc.fontSize(7.5).fillColor(FAINT).text(
          `FrameComment security report · ${scan.environment || 'unknown environment'} · ` +
          `${finished.toLocaleString()} · page ${i - range.start + 1} of ${range.count}`,
          doc.page.margins.left, y,
          { width: width(), align: 'center', lineBreak: false },
        )
        doc.page.margins.bottom = savedBottom
      }

      // Required with bufferPages: nothing is written until the buffered
      // pages are flushed, and this must happen after the footer pass.
      doc.flushPages()
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}
