import { ensureDefaultAdmin, ensureFoundingOwner } from './lib/seed'
import { initializeSecuritySettings } from './lib/settings'
import { logError, logMessage } from './lib/logging'

// Ensure the instrumentation hook only builds/runs in the Node.js runtime.
export const runtime = 'nodejs'

/**
 * Next.js Instrumentation Hook
 *
 * This file runs automatically when the Next.js server starts.
 * Used for server-side initialization tasks like seeding the database.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on Node.js runtime (not Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 5.6.1 multi-tenant: bind a fresh, MUTABLE org-context store at the
    // ROOT of every incoming HTTP request. The subscriber runs synchronously
    // when Node's http server receives a request, so everything downstream
    // (Next routing, our route handlers, Prisma extension) inherits the same
    // store object — and the auth guards can mutate it from inside awaited
    // helpers. See lib/org-context.ts for the full why.
    const g = globalThis as unknown as { __fcOrgDcSubscribed?: boolean }
    if (!g.__fcOrgDcSubscribed) {
      g.__fcOrgDcSubscribed = true
      const [{ subscribe }, { initRequestOrgStore }] = await Promise.all([
        import('node:diagnostics_channel'),
        import('./lib/org-context'),
      ])
      subscribe('http.server.request.start', () => {
        initRequestOrgStore()
      })
      logMessage('[INIT] Per-request org-context store armed (diagnostics_channel)')
    }

    logMessage('[INIT] Running server initialization...')

    try {
      await ensureDefaultAdmin()

      // 4.3.0+: make sure the account always has a founding OWNER (self-healing
      // safety net on top of the role migration — promotes the ADMIN_EMAIL
      // account, else the earliest user, only when no owner exists yet).
      await ensureFoundingOwner()

      // Initialize security settings from environment variables
      await initializeSecuritySettings()

      // 6.8.0 (Faza 5): start measuring uptime. One heartbeat at boot, then
      // one a minute; a missing beat becomes a recorded outage when the
      // process comes back. `unref()` so this timer never holds the process
      // open during a shutdown.
      const g2 = globalThis as unknown as { __fcHeartbeat?: NodeJS.Timeout }
      if (!g2.__fcHeartbeat) {
        const { recordHeartbeat, HEARTBEAT_INTERVAL_MS } = await import('./lib/platform-uptime')
        const pkgVersion = process.env.npm_package_version || null
        await recordHeartbeat('web', { isBoot: true, version: pkgVersion })
        g2.__fcHeartbeat = setInterval(() => {
          void recordHeartbeat('web')
        }, HEARTBEAT_INTERVAL_MS)
        g2.__fcHeartbeat.unref?.()
        logMessage('[INIT] Uptime heartbeat started')
      }

      logMessage('[INIT] Server initialization complete')
    } catch (error) {
      logError('[INIT] Initialization error:', error)
      // Don't throw - allow app to start even if initialization fails
      // The admin can be created manually via database if needed
    }
  }
}
