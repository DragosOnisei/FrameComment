#!/usr/bin/env tsx
/**
 * 6.23.0 — a regression test for the security report PDF, written because the
 * previous one passed while the document was visibly broken.
 *
 * That test asserted on byte size, then on "content streams == pages". Both are
 * proxies, and both were satisfied by a report that came out with two extra
 * pages carrying nothing but a footer line. The bug reached production twice.
 *
 * So this one asserts the property that actually failed: EVERY page carries a
 * footer. A page without one is a page the footer loop created by accident —
 * which is exactly what writing below the bottom margin does in pdfkit, since it
 * reads that as an overflow and starts a new page.
 *
 * It runs against the real `buildSecurityReportPdf`, not a replica of it. A test
 * that reimplements the thing it is testing can only ever confirm that the
 * reimplementation agrees with itself.
 *
 * Usage: npm run verify:report
 */

import zlib from 'zlib'
import { buildSecurityReportPdf, type ReportFinding, type ReportScan } from '../src/lib/security-report-pdf'

function makeFindings(count: number): ReportFinding[] {
  const statuses = ['FAIL', 'WARN', 'PASS', 'SKIPPED']
  return Array.from({ length: count }, (_, i) => ({
    stage: 'sessions',
    checkId: `check.${i}`,
    title: `Check number ${i} did not do what it should`,
    status: statuses[i % statuses.length],
    severity: i % 3 === 0 ? 'HIGH' : 'MEDIUM',
    detail: `Observed: something measurable, number ${i}`,
    remediation: 'Do the thing that fixes it.',
    impact: 'A sentence a non-engineer can act on, long enough to wrap onto a second line in the layout.',
  }))
}

function makeScan(findings: ReportFinding[]): ReportScan {
  return {
    id: 'scan-test',
    kind: 'FULL',
    status: 'COMPLETED',
    score: 76,
    passed: findings.filter((f) => f.status === 'PASS').length,
    warnings: findings.filter((f) => f.status === 'WARN').length,
    failures: findings.filter((f) => f.status === 'FAIL').length,
    skipped: findings.filter((f) => f.status === 'SKIPPED').length,
    durationMs: 300,
    environment: 'test',
    startedAt: new Date('2026-08-19T18:58:35Z'),
    finishedAt: new Date('2026-08-19T18:58:35Z'),
    startedByName: 'Verification script',
    findings,
  }
}

/**
 * Recover the readable text from a decompressed content stream.
 *
 * pdfkit writes strings as hex inside TJ arrays, with kerning numbers between
 * the runs — `[<46> 45 <72> 10 <616d65...>] TJ` — so searching the stream for
 * plain words finds nothing. Concatenating every hex run in order gives the
 * page's text back, kerning and all.
 */
function decodeText(stream: string): string {
  let out = ''
  for (const m of stream.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    const hex = m[1]
    if (hex.length % 2 !== 0) continue
    out += Buffer.from(hex, 'hex').toString('latin1')
  }
  return out
}

/**
 * Split the PDF into page objects and return, for each, the readable text of
 * its content stream.
 *
 * Deliberately crude: pdfkit's output is predictable enough that a full parser
 * would be more code than the thing under test. It only needs to answer one
 * question per page — is the footer on it.
 */
function pageContents(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1')

  // Every stream in the file, inflated where it is deflated.
  const streams: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    const body = Buffer.from(raw.slice(start, end), 'latin1')
    try {
      streams.push(zlib.inflateSync(body).toString('latin1'))
    } catch {
      streams.push(body.toString('latin1'))
    }
  }

  // Page objects, in document order. `/Type /Page` (not `/Pages`).
  const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length

  // pdfkit writes one content stream per page, in order, so the LAST
  // `pageCount` text-bearing streams line up with the pages. Font and metadata
  // streams carry no `Tj`, which is how they are told apart.
  const textStreams = streams.filter((s) => s.includes('Tj') || s.includes('TJ'))
  if (textStreams.length !== pageCount) {
    throw new Error(
      `Could not line up streams with pages: ${textStreams.length} text streams, ${pageCount} pages. ` +
      `The PDF structure changed and this check needs revisiting rather than deleting.`,
    )
  }
  return textStreams.map(decodeText)
}

let failures = 0
function check(name: string, condition: boolean, detail: string) {
  if (condition) {
    console.log(`  ok    ${name} — ${detail}`)
  } else {
    console.error(`  FAIL  ${name} — ${detail}`)
    failures += 1
  }
}

async function main() {
  // Sized so one case fits on a single page and the other certainly does not:
  // the bug only shows up once there is more than one page to put a footer on.
  for (const count of [4, 40, 120]) {
    const pdf = await buildSecurityReportPdf(makeScan(makeFindings(count)))
    const pages = pageContents(pdf)
    const withFooter = pages.filter((p) => p.includes('security report')).length

    console.log(`\n${count} findings → ${pages.length} page(s)`)
    check(
      'every page carries a footer',
      withFooter === pages.length,
      `${withFooter} of ${pages.length} pages have one` +
        (withFooter === pages.length ? '' : ' — the extra pages are the footer loop overflowing'),
    )
    check(
      'no page is empty',
      pages.every((p) => p.trim().length > 0),
      'all pages have a content stream',
    )
    check(
      'page count is plausible',
      pages.length >= 1 && pages.length <= Math.max(2, Math.ceil(count / 12)),
      `${pages.length} page(s) for ${count} findings`,
    )
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Verification failed to run:', err)
  process.exit(1)
})
