/**
 * 6.19.0 — the weekly scan, run by the worker.
 *
 * A scan you have to remember to press is a scan that gets pressed the week
 * you build it and never again. The findings that matter are the ones that
 * appear *later*: a certificate that lapses, a dependency advisory published
 * next month, a share link somebody made public in March. None of those
 * announce themselves.
 *
 * WHY THE WORKER, NOT A CRON IN THE WEB CONTAINER
 *
 * The web container may be running several replicas behind a proxy; a timer
 * there fires once per replica and produces duplicate runs. The worker is a
 * single process by design and already owns every other scheduled job in this
 * system, so the schedule lives where the other schedules live.
 *
 * WHEN IT NOTIFIES
 *
 * Only when something is actually wrong, and only when it is *newly* wrong.
 * A weekly email that says "still 3 warnings" trains you to delete it unread,
 * and then the week it says something different you delete that one too. So:
 * anything that failed, or any high/critical warning, and only if that exact
 * check was not already in that state a week ago.
 */

import { prismaPrivileged } from './db'
import { runSecurityScan, computeScore, describeEnvironment, type Finding } from './security-scan'
import { enqueueExternalNotification } from './external-notifications/enqueueExternalNotification'
import { logError, logMessage } from './logging'

/** Only these are worth waking someone up for. */
function isAlarming(f: Finding): boolean {
  if (f.status === 'FAIL') return true
  return f.status === 'WARN' && (f.severity === 'HIGH' || f.severity === 'CRITICAL')
}

/**
 * Was this check already in this state on the previous run?
 *
 * Repeating a known problem every week is how a security alert becomes
 * background noise. The first time a check breaks is the alert; the fifth time
 * is a to-do item, and to-do items belong on the page, not in your inbox.
 */
async function newlyAlarming(current: Finding[]): Promise<Finding[]> {
  try {
    const previous = await (prismaPrivileged as any).securityScan.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { startedAt: 'desc' },
      include: { findings: true },
    })
    if (!previous) return current.filter(isAlarming)

    const before = new Map<string, string>()
    for (const f of previous.findings as Array<{ checkId: string; status: string }>) {
      before.set(f.checkId, f.status)
    }
    return current.filter((f) => isAlarming(f) && before.get(f.checkId) !== f.status)
  } catch {
    // If we cannot read history, report everything alarming. Over-reporting is
    // recoverable; staying silent because a query failed is not.
    return current.filter(isAlarming)
  }
}

export async function runScheduledSecurityScan(): Promise<{
  scanId: string
  score: number
  failures: number
  notified: boolean
} | null> {
  const startedAt = Date.now()
  const environment = describeEnvironment()
  const log: Array<{ at: string; text: string }> = [
    { at: new Date().toISOString(), text: `Scheduled weekly scan against ${environment}` },
  ]

  let scanId: string
  try {
    const created = await (prismaPrivileged as any).securityScan.create({
      data: {
        status: 'RUNNING',
        environment,
        startedByName: 'Scheduled',
        logJson: JSON.stringify(log),
      },
    })
    scanId = created.id
  } catch (error) {
    logError('[SECURITY-SCAN] Could not create the scheduled run:', error)
    return null
  }

  try {
    const findings = await runSecurityScan(async (update) => {
      log.push({
        at: new Date().toISOString(),
        text: `${update.stageLabel}: ${update.findings.length} checks`,
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

    // Compared BEFORE this run is marked completed, so "the previous scan" is
    // genuinely the previous one and not the row we just wrote.
    const worthTelling = await newlyAlarming(findings)

    const passed = findings.filter((f) => f.status === 'PASS').length
    const warnings = findings.filter((f) => f.status === 'WARN').length
    const failures = findings.filter((f) => f.status === 'FAIL').length
    const skipped = findings.filter((f) => f.status === 'SKIPPED').length
    const score = computeScore(findings)

    log.push({
      at: new Date().toISOString(),
      text: `Weekly scan complete — score ${score}/100, ${failures} failures, ${worthTelling.length} new issue(s).`,
    })

    await (prismaPrivileged as any).securityScan.update({
      where: { id: scanId },
      data: {
        status: 'COMPLETED',
        progress: 100,
        currentStage: null,
        passed, warnings, failures, skipped, score,
        durationMs: Date.now() - startedAt,
        finishedAt: new Date(),
        logJson: JSON.stringify(log.slice(-200)),
      },
    })

    let notified = false
    if (worthTelling.length > 0) {
      // The body leads with the plain-language line, not the technical detail.
      // Someone reading this on a phone on a Sunday needs to know whether to
      // get up, and "relforcerowsecurity is false" does not answer that.
      const lines = worthTelling.slice(0, 6).map((f) => {
        const mark = f.status === 'FAIL' ? '✗' : '!'
        return `${mark} ${f.title}\n   ${f.impact || f.detail || ''}`
      })
      const more = worthTelling.length > 6 ? `\n…and ${worthTelling.length - 6} more.` : ''
      const title =
        failures > 0
          ? `Security scan: ${failures} check${failures > 1 ? 's' : ''} failing`
          : 'Security scan: new warnings'

      await enqueueExternalNotification({
        eventType: 'SECURITY_ALERT',
        title,
        body:
          `Weekly scan of ${environment}\n` +
          `Score ${score}/100 — ${passed} passed, ${warnings} warnings, ${failures} failures.\n\n` +
          `New since the last scan:\n${lines.join('\n')}${more}\n\n` +
          `Full report: Founder → Security`,
        notifyType: failures > 0 ? 'failure' : 'warning',
        pushData: { title, body: `${worthTelling.length} new security issue(s) — score ${score}/100` },
      }).catch((err) => logError('[SECURITY-SCAN] Could not send the alert:', err))
      notified = true
    }

    logMessage(
      `[SECURITY-SCAN] Weekly run finished: score ${score}/100, ${failures} failures, ` +
      `${worthTelling.length} new issue(s)${notified ? ' — alert sent' : ''}`,
    )

    return { scanId, score, failures, notified }
  } catch (error) {
    logError('[SECURITY-SCAN] Scheduled run failed:', error)
    await (prismaPrivileged as any).securityScan
      .update({
        where: { id: scanId },
        data: { status: 'FAILED', finishedAt: new Date() },
      })
      .catch(() => {})
    return null
  }
}

/**
 * Is a scheduled run due?
 *
 * Checked against the database rather than kept in memory, so a container that
 * restarts twice a day does not either skip the week or run the scan on every
 * boot. The timer only asks the question; the database decides.
 */
export async function scheduledScanIsDue(intervalMs: number): Promise<boolean> {
  try {
    const last = await (prismaPrivileged as any).securityScan.findFirst({
      where: { startedByName: 'Scheduled' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (!last) return true
    return Date.now() - new Date(last.startedAt).getTime() >= intervalMs
  } catch {
    // Unknown means do not run: a scan is cheap but not free, and a database
    // that cannot answer is not a good moment to start one.
    return false
  }
}
