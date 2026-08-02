import { prismaPrivileged } from '../lib/db'
import { logError, logMessage } from '../lib/logging'

/**
 * 5.10 Danger Zone: the wipe executor. Runs on the every-minute scheduler
 * (cheap no-op almost always). An organization is wiped ONLY when:
 *   - deletionScheduledAt exists AND is in the past (server clock vs a DB
 *     timestamp — nothing a client can accelerate), and
 *   - the org STILL holds zero projects (re-verified here; if any exist the
 *     wipe is refused and logged — never destroy content).
 *
 * The wipe itself is a single Organization row delete: every tenant table
 * carries an ON DELETE CASCADE foreign key to Organization, so users,
 * settings, invites, snapshots, notifications etc. all go with it. There are
 * no files to remove — files only exist under projects, and the org can't
 * reach this point with any.
 */
export async function processOrgDeletions(): Promise<void> {
  let due: Array<{ id: string; name: string; deletionScheduledAt: Date }> = []
  try {
    due = await (prismaPrivileged as any).organization.findMany({
      where: { deletionScheduledAt: { not: null, lte: new Date() } },
      select: { id: true, name: true, deletionScheduledAt: true },
    })
  } catch (err) {
    logError('[danger-zone] due-deletion query failed:', err)
    return
  }

  for (const org of due) {
    try {
      if (org.id === 'org-1') {
        // Absolute backstop — the platform org is never deletable.
        logError(`[danger-zone] REFUSING to wipe platform org (org-1) — clearing schedule`)
        await (prismaPrivileged as any).organization.update({
          where: { id: org.id },
          data: { deletionScheduledAt: null, deletionRequestedById: null },
        })
        continue
      }

      const projectCount = await (prismaPrivileged as any).project.count({
        where: { organizationId: org.id },
      })
      if (projectCount > 0) {
        // Should be impossible (creation is blocked while pending) — refuse
        // and keep the schedule so a human investigates.
        logError(
          `[danger-zone] org ${org.id} ("${org.name}") reached T0 with ${projectCount} project(s) — WIPE REFUSED`,
        )
        continue
      }

      await (prismaPrivileged as any).organization.delete({ where: { id: org.id } })
      logMessage(`[danger-zone] org ${org.id} ("${org.name}") wiped after 30-day countdown`)
    } catch (err) {
      logError(`[danger-zone] wipe failed for org ${org.id}:`, err)
    }
  }
}
