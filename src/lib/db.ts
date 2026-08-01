import { PrismaClient } from '@prisma/client'
import { ALL_ROLES } from './permissions'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/**
 * Set the database user context for Row Level Security (RLS)
 * This sets PostgreSQL session variables that RLS policies use to determine access
 *
 * @param userId - The current user's ID (must be valid CUID)
 * @param userRole - The current user's role (must be valid UserRole enum)
 */
export async function setDatabaseUserContext(
  userId: string,
  userRole: string
): Promise<void> {
  // Validate userId format (CUID: starts with 'c', followed by 24 alphanumeric chars)
  if (!/^c[a-z0-9]{24}$/.test(userId)) {
    throw new Error('Invalid userId format - must be valid CUID')
  }

  // Validate userRole is a known enum value. 4.3.0+: this used to hardcode
  // ['ADMIN']; it must accept every role (Owner/Admin/Editor/Marketing/Producer)
  // or `getCurrentUserFromRequest` throws for any non-Admin — which broke the
  // session for the Owner right after the role migration.
  const validRoles = ALL_ROLES as readonly string[]
  if (!validRoles.includes(userRole)) {
    throw new Error(`Invalid userRole - must be one of: ${validRoles.join(', ')}`)
  }

  try {
    // Set PostgreSQL session variables for RLS
    // Input validation above prevents SQL injection via set_config parameters
    await prisma.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`
    await prisma.$executeRaw`SELECT set_config('app.current_user_role', ${userRole}, true)`
  } catch (error) {
    // Don't throw - RLS might not be configured yet, and app should still work
  }
}

/**
 * Clear the database user context
 */
export async function clearDatabaseUserContext(): Promise<void> {
  try {
    await prisma.$executeRaw`SELECT set_config('app.current_user_id', '', true)`
    await prisma.$executeRaw`SELECT set_config('app.current_user_role', '', true)`
  } catch (error) {
    // Don't throw - this is just cleanup
  }
}

// ─── 5.0 multi-tenant: organization context for RLS ──────────────────────────
//
// The RLS policies (migration 20260801130000_multi_tenant_rls) compare each
// row's organizationId with `current_setting('app.current_organization_id')`.
// This helper arms that setting.
//
// IMPORTANT SCOPING CAVEAT (applies to setDatabaseUserContext above too):
// `set_config(..., true)` is TRANSACTION-scoped. A standalone $executeRaw runs
// in its own implicit transaction, so the setting evaporates before the next
// query on a pooled connection. That is intentional-safe (never leaks context
// across requests sharing a connection) but means RLS is only truly armed for
// queries that run INSIDE the same transaction as the set_config call:
//
//   await prisma.$transaction(async (tx) => {
//     await setOrgContextOn(tx, organizationId)
//     …tenant queries via tx…
//   })
//
// Phase 2 wires this per request. Until the app switches to the non-superuser
// `framecomment_app` DB role, policies are dormant anyway (superusers bypass
// RLS), so calling or not calling this has no behavioral effect today.

/** Prisma transaction client shape accepted by setOrgContextOn. */
type PrismaLike = Pick<PrismaClient, '$executeRaw'>

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Arm the RLS organization context on a specific client/transaction. Use the
 * transaction form (see caveat above) for it to cover subsequent queries.
 */
export async function setOrgContextOn(
  client: PrismaLike,
  organizationId: string,
): Promise<void> {
  if (!ORG_ID_RE.test(organizationId)) {
    throw new Error('Invalid organizationId format')
  }
  await client.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`
}

/** Convenience: default-client variant (transaction caveat applies). */
export async function setDatabaseOrgContext(organizationId: string): Promise<void> {
  try {
    await setOrgContextOn(prisma, organizationId)
  } catch {
    // Dormant until the app moves off the superuser role — never break a
    // request over context plumbing.
  }
}

