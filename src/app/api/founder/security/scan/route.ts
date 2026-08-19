/**
 * /api/founder/security/scan — 6.18.0
 *
 * POST starts a run and returns immediately with its id. GET polls it.
 *
 * The run is NOT awaited by the request that starts it. Twelve stages include
 * DNS lookups and a full-table hash comparison; holding an HTTP connection open
 * for that would hit a proxy timeout on any install behind Cloudflare, and the
 * user would see a failure for a scan that actually completed. Progress lives
 * in the database instead, which also means the page can be closed and reopened
 * mid-scan and still pick up the run.
 *
 * Founder-only, and rate-limited: the scan touches every table and hashes the
 * application directory, so it is the one endpoint here where hammering the
 * button would be self-inflicted denial of service.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { rateLimit } from '@/lib/rate-limit'
import { runSecurityScan, computeScore, SCAN_STAGES, describeEnvironment } from '@/lib/security-scan'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

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
          orderBy: { startedAt: 'desc' },
          include: { findings: { orderBy: { createdAt: 'asc' } } },
        })

    return NextResponse.json({
      stages: SCAN_STAGES.map((s) => ({ id: s.id, label: s.label, blurb: s.blurb })),
      scan: scan
        ? { ...scan, log: scan.logJson ? JSON.parse(scan.logJson) : [] }
        : null,
    })
  } catch (error) {
    logError('[FOUNDER/SECURITY] scan read failed:', error)
    return NextResponse.json({ error: 'Could not read the scan' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const limited = await rateLimit(
    request,
    { windowMs: 5 * 60 * 1000, maxRequests: 6, message: 'A scan was started recently. Give it a moment.' },
    'security-scan',
  )
  if (limited) return limited

  try {
    // A second scan while one is running would interleave two sets of findings
    // under two ids and make the live log jump between them.
    const running = await (prismaPrivileged as any).securityScan.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
    })
    if (running) {
      const ageMin = (Date.now() - new Date(running.startedAt).getTime()) / 60000
      // Unless it is stuck: a container restart mid-scan leaves a RUNNING row
      // nobody will ever finish, and without this the button dies forever.
      if (ageMin < 10) {
        return NextResponse.json({ id: running.id, alreadyRunning: true })
      }
      await (prismaPrivileged as any).securityScan.update({
        where: { id: running.id },
        data: { status: 'FAILED', finishedAt: new Date(), currentStage: 'Abandoned' },
      })
    }

    const user = auth as any
    const scan = await (prismaPrivileged as any).securityScan.create({
      data: {
        status: 'RUNNING',
        environment: describeEnvironment(),
        startedById: user?.id ?? null,
        startedByName: user?.name || user?.email || null,
        logJson: JSON.stringify([
          { at: new Date().toISOString(), text: 'Starting security scan' },
        ]),
      },
    })

    // Deliberately not awaited — see the file header.
    void executeScan(scan.id)

    return NextResponse.json({ id: scan.id, alreadyRunning: false })
  } catch (error) {
    logError('[FOUNDER/SECURITY] scan start failed:', error)
    return NextResponse.json({ error: 'Could not start the scan' }, { status: 500 })
  }
}

async function executeScan(scanId: string): Promise<void> {
  const startedAt = Date.now()
  const environment = describeEnvironment()
  const log: Array<{ at: string; text: string }> = [
    { at: new Date().toISOString(), text: `Starting security scan against ${environment}` },
  ]

  try {
    const findings = await runSecurityScan(async (update) => {
      const failed = update.findings.filter((f) => f.status === 'FAIL').length
      const warned = update.findings.filter((f) => f.status === 'WARN').length
      // The per-stage line names the skips explicitly. A stage that could not
      // run and one that ran clean both used to read "all clear", which is the
      // single most misleading thing a security report can say.
      const skippedHere = update.findings.filter((f) => f.status === 'SKIPPED').length
      log.push({
        at: new Date().toISOString(),
        text:
          `${update.stageLabel}: ${update.findings.length} checks` +
          (failed ? `, ${failed} failed` : '') +
          (warned ? `, ${warned} warning${warned > 1 ? 's' : ''}` : '') +
          (skippedHere ? `, ${skippedHere} could not run` : '') +
          (!failed && !warned && !skippedHere ? ' — all clear' : ''),
      })

      await (prismaPrivileged as any).securityScanFinding.createMany({
        data: update.findings.map((f) => ({
          scanId,
          stage: f.stage,
          checkId: f.checkId,
          title: f.title,
          status: f.status,
          severity: f.severity,
          detail: f.detail ?? null,
          remediation: f.remediation ?? null,
          impact: f.impact ?? null,
        })),
      })

      await (prismaPrivileged as any).securityScan.update({
        where: { id: scanId },
        data: {
          progress: Math.round((update.index / update.total) * 100),
          currentStage: update.stageLabel,
          logJson: JSON.stringify(log.slice(-200)),
        },
      })
    })

    const passed = findings.filter((f) => f.status === 'PASS').length
    const warnings = findings.filter((f) => f.status === 'WARN').length
    const failures = findings.filter((f) => f.status === 'FAIL').length
    const skipped = findings.filter((f) => f.status === 'SKIPPED').length
    const score = computeScore(findings)
    const durationMs = Date.now() - startedAt

    log.push({
      at: new Date().toISOString(),
      text:
        `Scan complete — ${findings.length} checks in ${(durationMs / 1000).toFixed(1)}s: ` +
        `${passed} passed, ${warnings} warnings, ${failures} failures` +
        (skipped ? `, ${skipped} could not run` : '') +
        `. Score ${score}/100.`,
    })

    await (prismaPrivileged as any).securityScan.update({
      where: { id: scanId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        currentStage: null,
        passed,
        warnings,
        failures,
        skipped,
        score,
        durationMs,
        environment,
        finishedAt: new Date(),
        logJson: JSON.stringify(log.slice(-200)),
      },
    })
  } catch (error) {
    logError('[FOUNDER/SECURITY] scan crashed:', error)
    log.push({ at: new Date().toISOString(), text: `Scan failed: ${String(error).slice(0, 200)}` })
    await (prismaPrivileged as any).securityScan
      .update({
        where: { id: scanId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          logJson: JSON.stringify(log.slice(-200)),
        },
      })
      .catch(() => {})
  }
}
