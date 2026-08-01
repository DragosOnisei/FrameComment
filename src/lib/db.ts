import { PrismaClient } from '@prisma/client'
import { ALL_ROLES } from './permissions'
import { getOrgContext } from './org-context'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaBase: PrismaClient | undefined
}

/** The raw client — used internally by the RLS extension for the batch
 *  transaction, and available for privileged paths that must NOT be
 *  org-wrapped (login lookup, share-slug resolution, worker). */
export const prismaBase = globalForPrisma.prismaBase ?? new PrismaClient()

/**
 * 5.0 multi-tenant: the PRIVILEGED client for the handful of lookups that
 * must legitimately work WITHOUT an org context (they establish it):
 *   - auth: token → user row (the org comes FROM this row),
 *   - login / passkey: email or credential → user across orgs,
 *   - share/short-link resolution: public slug/token → owning project/org,
 *   - boot seed.
 *
 * Pre-flip this is the same connection as everything else. POST-FLIP the
 * operator points DATABASE_URL at the restricted `framecomment_app` role and
 * sets DATABASE_URL_PRIVILEGED to the admin/BYPASSRLS role — so RLS binds the
 * whole app EXCEPT these audited resolver paths. Never use this client in
 * route handlers directly; resolve → `enterOrgContext(...)` → use `prisma`.
 */
export const prismaPrivileged: PrismaClient =
  (globalForPrisma as any).prismaPrivileged ??
  (process.env.DATABASE_URL_PRIVILEGED
    ? new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL_PRIVILEGED } },
      })
    : prismaBase)

// ─── 5.0 multi-tenant: automatic RLS org context on every model operation ───
//
// Official Prisma RLS pattern (prisma-client-extensions/row-level-security):
// when a request has an org context (set by the auth guards via
// AsyncLocalStorage — see org-context.ts), each model operation is executed
// as a BATCH TRANSACTION of [set_config(org), operation]. Both statements run
// on the same pooled connection inside one transaction, so the
// transaction-scoped setting is armed for exactly that operation — the RLS
// policies see it, and it can never leak to another request sharing the
// connection.
//
// Skips (return the bare operation):
//  - no org context (worker, unauthenticated paths) — post-flip, RLS then
//    denies by default for the app role; the worker's privileged role is
//    unaffected;
//  - operations already inside an interactive transaction (`__internalParams
//    .transaction` set) — wrapping would escape the caller's transaction.
//    Interactive-transaction call sites arm the context themselves via
//    `setOrgContextOn(tx, orgId)` as their first statement.
//
// While the app still connects as the Postgres superuser (pre-flip), the
// policies don't filter anything — but the DEFAULT-expression column values
// and WITH CHECK behavior are already exercised, so the flip is a pure
// config change.
function withRlsOrgContext(base: PrismaClient): PrismaClient {
  const extended = (base as any).$extends({
    query: {
      $allModels: {
        async $allOperations(params: any) {
          const { args, query } = params
          const organizationId = getOrgContext()
          const inInteractiveTx = !!(params as any).__internalParams?.transaction
          if (!organizationId || inInteractiveTx) {
            return query(args)
          }
          const [, result] = await (base as any).$transaction([
            (base as any).$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, TRUE)`,
            query(args),
          ])
          return result
        },
      },
    },
  })
  return extended as PrismaClient
}

export const prisma = globalForPrisma.prisma ?? withRlsOrgContext(prismaBase)

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaBase = prismaBase
  ;(globalForPrisma as any).prismaPrivileged = prismaPrivileged
}

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

/**
 * 5.0 multi-tenant: the org-aware `where` for the per-org singletons
 * (Settings / SecuritySettings — organizationId is @unique on both).
 *
 * Replaces the legacy id-'default' singleton `where` at every call site:
 *  - App requests: resolves the caller's org from the AsyncLocalStorage
 *    context the auth guards enter → each company reads/writes ITS row.
 *  - No context (worker, boot paths): falls back to 'org-1' — the migrated
 *    legacy singleton — preserving today's behavior until those paths are
 *    explicitly wired (worker gets explicit org plumbing separately).
 *
 * Returns `any` so call sites type-check against BOTH the fresh generated
 * client (organizationId is a unique where key) and the sandbox's stale one.
 */
export function orgSettingsWhere(): any {
  return { organizationId: getOrgContext() ?? 'org-1' }
}

/**
 * The effective org for the current async context — request org when armed,
 * 'org-1' (the legacy tenant) otherwise. Used to make CREATEs explicit on
 * paths that can also run outside a request (worker, boot).
 */
export function currentOrgId(): string {
  return getOrgContext() ?? 'org-1'
}

/**
 * Companion for the CREATE branches of settings upserts. Preserves the exact
 * legacy shape for org-1 / no-context (id 'default', organizationId via the
 * DB default), and gives other orgs their own row keyed by the org id —
 * matching what /api/auth/register creates.
 */
export function orgSettingsCreateBase(): any {
  const org = getOrgContext()
  if (org && org !== 'org-1') {
    return { id: org, organizationId: org }
  }
  return { id: 'default' }
}

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

