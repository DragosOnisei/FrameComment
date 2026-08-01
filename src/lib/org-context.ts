/**
 * 5.0 multi-tenant: per-request organization context (AsyncLocalStorage).
 *
 * The auth guards call `enterOrgContext(user.organizationId)` once per
 * authenticated request; from that point on, EVERY Prisma model operation in
 * the same async chain is automatically wrapped by the db.ts client extension
 * in a batch transaction that first arms Postgres'
 * `app.current_organization_id` setting — which is what the Row-Level
 * Security policies compare against. Zero per-route changes needed.
 *
 * Design notes:
 *  - `enterWith` (not `run`) because guards are awaited INSIDE route handlers
 *    — they can't wrap the rest of the handler in a callback. `enterWith`
 *    binds the store to the current async execution context and its
 *    descendants; each incoming HTTP request starts a fresh context from the
 *    server root, so stores never leak across requests. (Same pattern APM
 *    tools use for request tracing.)
 *  - The WORKER never enters a context: it runs as the privileged DB role and
 *    passes organizationId explicitly where it matters.
 *  - Fail-safe direction: a MISSING context simply means the extension
 *    doesn't arm the setting → after the non-superuser flip, RLS denies by
 *    default (empty results), never cross-tenant data.
 */

import { AsyncLocalStorage } from 'async_hooks'

interface OrgStore {
  organizationId: string
}

// Browser-safety: this module can be PULLED into client bundles through long
// import chains (db.ts → i18n/locale.ts → a page). next.config.js stubs
// `async_hooks` to an empty module for browser builds, so AsyncLocalStorage
// is undefined there — guard instantiation; the functions below then no-op
// client-side (they're only meaningful on the server anyway).
//
// SINGLETON ON globalThis: bundlers (Turbopack dev especially) can duplicate
// this module across server chunks — auth.ts would then write into one ALS
// instance while db.ts reads another, silently losing the context (surfaced
// as a create running unwrapped → FK violation on the org default). Pinning
// the instance on globalThis guarantees ONE store per process regardless of
// how many module copies the bundler produces.
const g = globalThis as unknown as { __fcOrgAls?: AsyncLocalStorage<OrgStore> }
const als: AsyncLocalStorage<OrgStore> | null =
  typeof window === 'undefined' && typeof AsyncLocalStorage === 'function'
    ? (g.__fcOrgAls ??= new AsyncLocalStorage<OrgStore>())
    : null

/** Bind the org to the CURRENT async execution context (guards call this). */
export function enterOrgContext(organizationId: string): void {
  als?.enterWith({ organizationId })
}

/** Classic callback-scoped variant, for explicit scoping (worker jobs etc.). */
export function runWithOrgContext<T>(organizationId: string, fn: () => T): T {
  if (!als) return fn()
  return als.run({ organizationId }, fn)
}

/** The org bound to the current async chain, or null outside any context. */
export function getOrgContext(): string | null {
  return als?.getStore()?.organizationId ?? null
}
