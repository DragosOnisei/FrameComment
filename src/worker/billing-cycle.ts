import {
  runBillingCycleIfDue,
  recordDailySnapshotIfNeeded,
  evaluateBillingHealth,
} from '../lib/billing'
import { logError, logMessage } from '../lib/logging'

/**
 * 3.7.0+: monthly billing tick.
 *
 * Piggy-backs on the every-minute notification scheduler. Almost every
 * call is a cheap no-op ("not due"); on the billing day it computes the
 * instance's usage, creates a Stripe invoice, and charges the saved
 * card off-session. `runBillingCycleIfDue` advances `nextBillingAt`
 * before charging so a mid-run crash can't double-charge on the next
 * minute.
 */
export async function processBillingCycle() {
  try {
    // 1) Meter: record today's usage snapshot (once/day, idempotent) so
    //    the monthly invoice can average + prorate.
    await recordDailySnapshotIfNeeded()
    // 2) Dunning: start/clear the grace clock, suspend after 5 business
    //    days unresolved.
    await evaluateBillingHealth()
    // 3) Charge if the monthly anchor is due.
    const result = await runBillingCycleIfDue()
    // Only log the interesting (non-skip) outcomes to keep the every-
    // minute logs quiet.
    if (!result.startsWith('skip')) {
      logMessage(`[billing] ${result}`)
    }
  } catch (err) {
    logError('[billing] processBillingCycle error:', err)
  }
}
