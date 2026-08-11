/**
 * 5.10 Danger Zone — company deletion + anti-mass-wipe throttling.
 *
 * Threat model: a COMPROMISED tenant account must not be able to destroy a
 * company's work quickly. Two server-side mechanisms (client can't influence
 * either — all clocks are DB timestamps compared on the server):
 *
 *  1. PROJECT TRASH THROTTLE (tenants only; the platform org is exempt —
 *     the operator's real protection is server access + ZFS snapshots):
 *     - at most ONE project may be moved to Trash per 24h window;
 *     - a trashed project can only be PURGED once it has sat in Trash for
 *       24h (recovery window for the real owner);
 *     - `?permanent=1` (skip-trash deletion) is disabled for tenants unless
 *       the project already served its 24h in Trash;
 *     - empty projects (no folders, no videos) are exempt — nothing to lose.
 *
 *  2. COMPANY DELETION — 30-day countdown:
 *     - can only be REQUESTED when the org has ZERO projects (so wiping a
 *       company takes at least one day per project + 30 days, loudly);
 *     - requires the Owner's password AND typing the exact company name;
 *     - cancellable by any Owner (password) during the whole window;
 *     - while pending, project creation is blocked;
 *     - the WORKER performs the wipe only once NOW passes the DB timestamp,
 *       and re-verifies the zero-project invariant before deleting.
 */

import { prismaPrivileged, currentOrgId } from './db'
import { isPlatformOrgContext } from './platform'
import { logError } from './logging'

export const PROJECT_TRASH_LOCK_MS = 24 * 60 * 60 * 1000 // 24h (hard-coded)
export const ORG_DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * 6.2.0: re-exported from `./platform`, which is now the single source of
 * truth. This used to be `currentOrgId() === 'org-1'`, exempting the founder's
 * own marketing company from every tenant rule. Only the dedicated platform
 * organization is exempt now; 'org-1' plays by the same rules as any other
 * customer (project-trash throttle included).
 */
export { isPlatformOrgContext }

export interface OrgDangerState {
  id: string
  name: string
  deletionScheduledAt: Date | null
  lastProjectTrashedAt: Date | null
}

export async function getOrgDangerState(
  orgId: string = currentOrgId(),
): Promise<OrgDangerState | null> {
  try {
    return (await (prismaPrivileged as any).organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        deletionScheduledAt: true,
        lastProjectTrashedAt: true,
      } as any,
    })) as OrgDangerState | null
  } catch (err) {
    logError('[danger-zone] org state read failed:', err)
    return null
  }
}

/** May THIS org trash another project right now? (tenants: 1 per 24h) */
export async function checkProjectTrashAllowed(): Promise<
  { allowed: true } | { allowed: false; retryAt: Date }
> {
  if (isPlatformOrgContext()) return { allowed: true }
  const org = await getOrgDangerState()
  const last = org?.lastProjectTrashedAt
    ? new Date(org.lastProjectTrashedAt).getTime()
    : 0
  const retryAt = last + PROJECT_TRASH_LOCK_MS
  if (Date.now() >= retryAt) return { allowed: true }
  return { allowed: false, retryAt: new Date(retryAt) }
}

/** Stamp the throttle after a successful (non-empty) project trash. */
export async function markProjectTrashed(): Promise<void> {
  if (isPlatformOrgContext()) return
  try {
    await (prismaPrivileged as any).organization.update({
      where: { id: currentOrgId() },
      data: { lastProjectTrashedAt: new Date() },
    })
  } catch (err) {
    logError('[danger-zone] trash stamp failed:', err)
  }
}

/** May a trashed project be PURGED yet? (tenants: 24h in Trash first) */
export function projectPurgeAllowed(deletedAt: Date | string | null): boolean {
  if (isPlatformOrgContext()) return true
  if (!deletedAt) return false
  return Date.now() >= new Date(deletedAt).getTime() + PROJECT_TRASH_LOCK_MS
}

/** Human-friendly "in Xh Ym" for throttle error messages. */
export function humanUntil(when: Date): string {
  const ms = Math.max(0, when.getTime() - Date.now())
  const h = Math.floor(ms / 3_600_000)
  const m = Math.ceil((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
