/**
 * 4.3.0+: ownership-transfer engine (single-owner model + 30-day anti-hijack
 * grace window).
 *
 * All access to the "OwnershipTransfer" table goes through raw SQL so it keeps
 * working even before `prisma generate` has caught up with the new model — the
 * same stale-client-safe pattern the storage layer uses. Callers that need the
 * current owner-level state (delete-user guards, the transfer route, the UI
 * banner) come through here so the rules live in exactly one place.
 *
 * State machine:
 *   initiate  → creates a GRACE transfer; target becomes active OWNER, previous
 *               owner is kept OWNER-level but flagged as the grace ("from") party.
 *   reverse   → previous owner reclaims OWNER; target is restored to its prior
 *               role; transfer → REVERSED. (Anti-hijack rescue.)
 *   finalize  → after graceEndsAt: previous owner → ADMIN; transfer → FINALIZED;
 *               target is the sole OWNER.
 */
import { randomUUID } from 'crypto'
import { prisma, setOrgContextOn, currentOrgId, rawArmed } from './db'
import { logError, logMessage } from './logging'
import { revokeAllUserTokens } from './token-revocation'

export const OWNERSHIP_GRACE_DAYS = 30

export type OwnershipResult =
  | { ok: true }
  | { ok: false; error: string; status: number }

export interface GraceTransfer {
  id: string
  fromUserId: string
  toUserId: string
  toPreviousRole: string
  status: string
  initiatedAt: Date
  graceEndsAt: Date
}

/**
 * Demote the previous owner and close out any GRACE transfer whose 30-day
 * window has elapsed. Idempotent + safe to call from anywhere (lazy checks +
 * the worker sweep both use it). Returns how many were finalized.
 */
export async function finalizeExpiredTransfers(): Promise<number> {
  try {
    // 6.21.0: every bare raw statement in this file goes through `rawArmed`.
    // Raw queries are not intercepted by the RLS extension (it arms model
    // operations only), so post-flip these ran with no
    // `app.current_organization_id`: the SELECTs returned nothing and the
    // UPDATEs matched nothing, silently, and an expired grace window was never
    // closed out. Without a context (the worker sweep) `rawArmed` degrades to a
    // plain transaction, which is exactly what that path had before.
    const rows = await rawArmed(prisma.$queryRawUnsafe<Array<{ id: string; fromUserId: string }>>(
      `SELECT "id", "fromUserId" FROM "OwnershipTransfer"
        WHERE "status" = 'GRACE' AND "graceEndsAt" <= NOW()`,
    ))
    let finalized = 0
    for (const r of rows) {
      // Only demote if they're still OWNER — never clobber a role set elsewhere.
      await rawArmed(prisma.$executeRawUnsafe(
        `UPDATE "User" SET "role" = 'ADMIN', "updatedAt" = NOW()
          WHERE "id" = $1 AND "role" = 'OWNER'`,
        r.fromUserId,
      ))
      await rawArmed(prisma.$executeRawUnsafe(
        `UPDATE "OwnershipTransfer" SET "status" = 'FINALIZED', "finalizedAt" = NOW()
          WHERE "id" = $1 AND "status" = 'GRACE'`,
        r.id,
      ))
      // Force the demoted user to re-authenticate so their session reflects
      // the reduced permissions immediately.
      try { await revokeAllUserTokens(r.fromUserId) } catch { /* non-fatal */ }
      finalized++
    }
    if (finalized > 0) {
      logMessage(`[ownership] finalized ${finalized} expired ownership transfer(s)`)
    }
    return finalized
  } catch (err) {
    logError('[ownership] finalizeExpiredTransfers failed:', err)
    return 0
  }
}

/**
 * The single active GRACE transfer, or null. Opportunistically finalizes any
 * expired windows first, so callers always see current truth.
 */
export async function getActiveGraceTransfer(): Promise<GraceTransfer | null> {
  await finalizeExpiredTransfers()
  try {
    const rows = await rawArmed(prisma.$queryRawUnsafe<Array<GraceTransfer>>(
      `SELECT "id", "fromUserId", "toUserId", "toPreviousRole", "status", "initiatedAt", "graceEndsAt"
         FROM "OwnershipTransfer"
        WHERE "status" = 'GRACE' AND "graceEndsAt" > NOW()
        ORDER BY "initiatedAt" DESC
        LIMIT 1`,
    ))
    return rows[0] ?? null
  } catch (err) {
    logError('[ownership] getActiveGraceTransfer failed:', err)
    return null
  }
}

/**
 * Is this user the previous owner still inside a 30-day grace window? Such a
 * user is UNTOUCHABLE through user management (can't be deleted / demoted /
 * role-changed by anyone but themselves via the reverse flow) — this is the
 * hard rule that stops a hijacker who just received ownership from locking the
 * real owner out.
 */
export async function isGraceOwner(userId: string): Promise<boolean> {
  const t = await getActiveGraceTransfer()
  return !!t && t.fromUserId === userId
}

/**
 * Initiate an ownership transfer (caller must already be the active OWNER and
 * must have re-authenticated — both enforced in the route). The recipient
 * becomes the active OWNER immediately; the caller stays OWNER-level for the
 * 30-day grace window and can reverse. Only one transfer may be in flight.
 */
export async function initiateTransfer(fromUserId: string, toUserId: string): Promise<OwnershipResult> {
  if (!toUserId || fromUserId === toUserId) {
    return { ok: false, error: 'Choose a different user to transfer ownership to.', status: 400 }
  }
  const active = await getActiveGraceTransfer()
  if (active) {
    return { ok: false, error: 'An ownership transfer is already in progress.', status: 409 }
  }
  const rows = await rawArmed(prisma.$queryRawUnsafe<Array<{ id: string; role: string }>>(
    `SELECT "id", "role" FROM "User" WHERE "id" = $1`,
    toUserId,
  ))
  const target = rows[0]
  if (!target) return { ok: false, error: 'That user no longer exists.', status: 404 }
  if (target.role === 'OWNER') {
    return { ok: false, error: 'That user is already an owner.', status: 400 }
  }

  const id = randomUUID()
  const graceEndsAt = new Date(Date.now() + OWNERSHIP_GRACE_DAYS * 24 * 60 * 60 * 1000)
  try {
    await prisma.$transaction(async (tx) => {
      await setOrgContextOn(tx as any, currentOrgId())
      // Recipient becomes the active owner NOW.
      await (tx as any).$executeRawUnsafe(
        `UPDATE "User" SET "role" = 'OWNER', "updatedAt" = NOW() WHERE "id" = $1`,
        toUserId,
      )
      // Record the transfer. The previous owner (fromUserId) intentionally
      // stays OWNER — they are the grace party and keep power to reverse.
      await (tx as any).$executeRawUnsafe(
        `INSERT INTO "OwnershipTransfer"
           ("id", "fromUserId", "toUserId", "toPreviousRole", "status", "initiatedAt", "graceEndsAt")
         VALUES ($1, $2, $3, $4::"UserRole", 'GRACE', NOW(), $5)`,
        id, fromUserId, toUserId, target.role, graceEndsAt,
      )
    })
  } catch (err) {
    logError('[ownership] initiateTransfer failed:', err)
    return { ok: false, error: 'Failed to start the ownership transfer.', status: 500 }
  }
  // Recipient must re-log to pick up owner permissions.
  try { await revokeAllUserTokens(toUserId) } catch { /* non-fatal */ }
  logMessage(`[ownership] transfer initiated ${fromUserId} -> ${toUserId} (grace until ${graceEndsAt.toISOString()})`)
  return { ok: true }
}

/**
 * Reverse an in-flight transfer. Only the grace ("from") owner may do this and
 * only inside the window — the anti-hijack rescue: the recipient is demoted
 * back to their previous role and the previous owner keeps ownership.
 */
export async function reverseTransfer(actorId: string): Promise<OwnershipResult> {
  const active = await getActiveGraceTransfer()
  if (!active) {
    return { ok: false, error: 'There is no ownership transfer to reverse.', status: 404 }
  }
  if (active.fromUserId !== actorId) {
    return { ok: false, error: 'Only the previous owner can reverse this transfer.', status: 403 }
  }
  try {
    await prisma.$transaction(async (tx) => {
      await setOrgContextOn(tx as any, currentOrgId())
      // Restore the recipient to exactly what they were before.
      await (tx as any).$executeRawUnsafe(
        `UPDATE "User" SET "role" = $1::"UserRole", "updatedAt" = NOW() WHERE "id" = $2`,
        active.toPreviousRole, active.toUserId,
      )
      // Make sure the reclaiming party is OWNER (they should already be).
      await (tx as any).$executeRawUnsafe(
        `UPDATE "User" SET "role" = 'OWNER', "updatedAt" = NOW() WHERE "id" = $1`,
        active.fromUserId,
      )
      await (tx as any).$executeRawUnsafe(
        `UPDATE "OwnershipTransfer" SET "status" = 'REVERSED', "reversedAt" = NOW()
          WHERE "id" = $1 AND "status" = 'GRACE'`,
        active.id,
      )
    })
  } catch (err) {
    logError('[ownership] reverseTransfer failed:', err)
    return { ok: false, error: 'Failed to reverse the ownership transfer.', status: 500 }
  }
  try { await revokeAllUserTokens(active.toUserId) } catch { /* non-fatal */ }
  logMessage(`[ownership] transfer reversed by ${actorId} (recipient ${active.toUserId} restored to ${active.toPreviousRole})`)
  return { ok: true }
}
