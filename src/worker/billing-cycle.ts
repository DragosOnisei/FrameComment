import {
  runBillingCycleIfDue,
  recordDailySnapshotIfNeeded,
  evaluateBillingHealth,
} from '../lib/billing'
import { prismaPrivileged } from '../lib/db'
import { runWithOrgContext } from '../lib/org-context'
import { logError, logMessage } from '../lib/logging'

/**
 * 3.7.0+: monthly billing tick. 5.7 Phase 5: PER ORGANIZATION.
 *
 * Piggy-backs on the every-minute notification scheduler. Each tick walks
 * every ACTIVE organization and runs the three billing steps INSIDE that
 * org's context (`runWithOrgContext` — the worker has no request ALS, so
 * this is what scopes `orgSettingsWhere()` / `currentOrgId()` to the right
 * company):
 *   1) meter: record today's usage snapshot (once/day/org, idempotent),
 *   2) dunning: start/clear the grace clock, suspend after 5 business days,
 *   3) charge: create + pay the Stripe invoice when the ORG's anchor is due
 *      (`runBillingCycleIfDue` advances nextBillingAt before charging, so a
 *      mid-run crash can't double-charge on the next minute).
 *
 * Orgs without a card / within the free tier cost one settings read each;
 * a failure in one org never blocks the others.
 */
export async function processBillingCycle() {
  let orgs: Array<{ id: string }> = []
  try {
    orgs = await (prismaPrivileged as any).organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    })
  } catch (err) {
    logError('[billing] failed to list organizations:', err)
    return
  }

  for (const org of orgs) {
    try {
      await runWithOrgContext(org.id, async () => {
        await recordDailySnapshotIfNeeded()
        await evaluateBillingHealth()
        const result = await runBillingCycleIfDue()
        // Only log the interesting (non-skip) outcomes to keep the every-
        // minute logs quiet.
        if (!result.startsWith('skip')) {
          logMessage(`[billing] ${org.id}: ${result}`)
        }
      })
    } catch (err) {
      logError(`[billing] processBillingCycle error for org ${org.id}:`, err)
    }
  }
}
