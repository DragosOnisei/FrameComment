/**
 * 4.3.0+: role-based permissions — single source of truth, shared by the
 * server guards (src/lib/auth.ts) and the client UI (sidebar, User Management,
 * menus). Keep this file free of server-only imports so it can be bundled into
 * client components.
 *
 * Roles form an mIRC-style level hierarchy:
 *
 *   OWNER    100  every right, incl. transferring ownership / deleting the company
 *   ADMIN     90  every right EXCEPT owning; may add/delete users + assign roles up
 *                 to Admin, but may NEVER touch the Owner (or a grace-period owner)
 *   EDITOR    50  content only (videos/folders/projects/comments/sharing)
 *   MARKETING 50  == EDITOR for now
 *   PRODUCER  50  == EDITOR for now
 *
 * Capability summary (confirmed with the product owner):
 *   - Content ops ......................... every role
 *   - App Settings / Storage / Billing .... OWNER + ADMIN
 *   - Add users / change roles ............ OWNER + ADMIN (never assign OWNER here)
 *   - Delete users ........................ OWNER + ADMIN (never the Owner / grace owner)
 *   - Transfer ownership / delete company . OWNER only
 */

export type AppRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'MARKETING' | 'PRODUCER'

export const ROLE_LEVELS: Record<AppRole, number> = {
  OWNER: 100,
  ADMIN: 90,
  EDITOR: 50,
  MARKETING: 50,
  PRODUCER: 50,
}

/** Every valid internal role, highest-privilege first. */
export const ALL_ROLES: AppRole[] = ['OWNER', 'ADMIN', 'EDITOR', 'MARKETING', 'PRODUCER']

/**
 * Roles that can be handed out through normal role management. OWNER is
 * deliberately absent: ownership only ever moves through the transfer flow
 * (with re-authentication + the 30-day grace window), never a plain role edit.
 */
export const ASSIGNABLE_ROLES: AppRole[] = ['ADMIN', 'EDITOR', 'MARKETING', 'PRODUCER']

/** Human-facing label for a role. */
export const ROLE_LABELS: Record<AppRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  EDITOR: 'Editor',
  MARKETING: 'Marketing',
  PRODUCER: 'Producer',
}

/** Type guard: is this string one of the known internal roles? */
export function isAppRole(role: unknown): role is AppRole {
  return typeof role === 'string' && (ALL_ROLES as string[]).includes(role)
}

/** Numeric level for a role; unknown roles get 0 (no privilege). */
export function roleLevel(role: string | null | undefined): number {
  return isAppRole(role) ? ROLE_LEVELS[role] : 0
}

export function isOwner(role: string | null | undefined): boolean {
  return role === 'OWNER'
}

export function isAdmin(role: string | null | undefined): boolean {
  return role === 'ADMIN'
}

/**
 * Any authenticated internal user (one of the five roles). This is the gate for
 * ordinary content routes — what `requireApiAdmin` now means. Unknown / corrupt
 * roles are rejected (fail closed).
 */
export function isStaff(role: string | null | undefined): boolean {
  return isAppRole(role)
}

/** OWNER + ADMIN: App Settings, Storage configuration, Billing. */
export function canManageSettings(role: string | null | undefined): boolean {
  return isOwner(role) || isAdmin(role)
}

/** OWNER + ADMIN: add users and change roles. */
export function canManageUsers(role: string | null | undefined): boolean {
  return isOwner(role) || isAdmin(role)
}

/** OWNER + ADMIN: delete user accounts (subject to target guards below). */
export function canDeleteUsers(role: string | null | undefined): boolean {
  return isOwner(role) || isAdmin(role)
}

/** OWNER only: initiate an ownership transfer / delete the company. */
export function canTransferOwnership(role: string | null | undefined): boolean {
  return isOwner(role)
}

/**
 * Can `actorRole` ASSIGN `targetRole` to a user via normal role management?
 *
 *   - Actor must be able to manage users (OWNER/ADMIN).
 *   - OWNER is never assignable here (transfer flow only).
 *   - Actor can only grant a role at or below their own level.
 */
export function canAssignRole(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  if (!canManageUsers(actorRole)) return false
  if (!isAppRole(targetRole)) return false
  if (targetRole === 'OWNER') return false
  return roleLevel(actorRole) >= ROLE_LEVELS[targetRole]
}

/**
 * Can `actor` act on (edit role / delete) the `target` user?
 *
 * Hard invariants that protect the account from hijack:
 *   - Nobody may act on themselves through the management path (no self-delete /
 *     self role-change).
 *   - The OWNER is untouchable through user management — ownership only moves via
 *     the transfer flow.
 *   - A grace-period owner (previous owner still inside the 30-day window) is also
 *     untouchable, so a freshly-installed "new owner" can't lock the real owner out.
 */
export function canActOnUser(params: {
  actorId: string
  actorRole: string | null | undefined
  targetId: string
  targetRole: string | null | undefined
  targetIsGraceOwner?: boolean
}): boolean {
  const { actorId, actorRole, targetId, targetRole, targetIsGraceOwner } = params
  if (!canManageUsers(actorRole)) return false
  if (actorId === targetId) return false
  if (isOwner(targetRole)) return false
  if (targetIsGraceOwner) return false
  return true
}
