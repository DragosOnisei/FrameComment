/**
 * 5.5 multi-tenant (Phase 3d): org-context arming for PUBLIC share surfaces.
 *
 * Public share routes receive an unguessable slug/token in the URL and used
 * to resolve it straight through the default `prisma` client. Post-flip (app
 * running as the non-superuser `framecomment_app` role) that first lookup
 * runs WITHOUT an org context → RLS returns nothing → every share link would
 * 404. These helpers are the sanctioned bridge:
 *
 *   1. resolve slug → organizationId through `prismaPrivileged` (the ONLY
 *      thing the privileged client is used for — a single, minimal SELECT),
 *   2. `enterOrgContext(org)` so every subsequent query in the request is
 *      automatically wrapped by the db.ts RLS extension and scoped to the
 *      owning company.
 *
 * Call it FIRST in the route handler (right after reading the slug param),
 * before rate-limit/settings/locale reads — those then resolve against the
 * correct organization too.
 *
 * Fail-safe: unknown slug (or legacy NULL org) simply doesn't arm anything —
 * the route's own lookup then behaves exactly as before pre-flip, and
 * post-flip RLS denies by default. Never a cross-tenant leak.
 */

import { prismaPrivileged } from './db'
import { enterOrgContext } from './org-context'
import { logError } from './logging'

/** Resolve a PROJECT share slug/token to its org and arm the context. */
export async function armOrgForProjectSlug(slug: string): Promise<void> {
  if (!slug || typeof slug !== 'string' || slug.length > 256) return
  try {
    const row = (await prismaPrivileged.project.findUnique({
      where: { slug },
      select: { organizationId: true } as any,
    })) as any
    if (row?.organizationId) enterOrgContext(row.organizationId)
  } catch (err) {
    // Never break a public route over context plumbing — the request just
    // proceeds un-armed (pre-flip: unchanged; post-flip: RLS denies).
    logError('[share-org] project slug arming failed:', err)
  }
}

/** Resolve a FOLDER share slug to its org and arm the context. */
export async function armOrgForFolderSlug(slug: string): Promise<void> {
  if (!slug || typeof slug !== 'string' || slug.length > 256) return
  try {
    const row = (await prismaPrivileged.folder.findUnique({
      where: { slug },
      select: { organizationId: true } as any,
    })) as any
    if (row?.organizationId) enterOrgContext(row.organizationId)
  } catch (err) {
    logError('[share-org] folder slug arming failed:', err)
  }
}
