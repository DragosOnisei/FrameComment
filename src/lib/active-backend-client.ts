/**
 * 5.12.0 — client-side cached lookup of the company's ACTIVE storage backend.
 *
 * Used by the video kebab to decide whether to offer "Transfer to <backend>"
 * without every card firing its own request: one in-flight promise + a short
 * TTL cache are shared module-wide. Non-privileged roles get a 403 from the
 * endpoint — cached as `null` so the menu simply hides the item.
 */
import { apiJson } from '@/lib/api-client'

export interface ActiveBackendInfo {
  backend: string
  label: string
}

let cache: { value: ActiveBackendInfo | null; ts: number } | null = null
let inflight: Promise<ActiveBackendInfo | null> | null = null
const TTL_MS = 60_000

export async function fetchActiveBackendInfo(): Promise<ActiveBackendInfo | null> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.value
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const s = await apiJson<{ activeBackend?: string; activeBackendLabel?: string }>(
        '/api/settings/storage/transfer?light=1',
      )
      const value =
        s && typeof s.activeBackend === 'string' && s.activeBackend
          ? { backend: s.activeBackend, label: s.activeBackendLabel || s.activeBackend }
          : null
      cache = { value, ts: Date.now() }
      return value
    } catch {
      // 403 (role without settings access) or transient failure — hide the
      // menu item rather than erroring the card.
      cache = { value: null, ts: Date.now() }
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}
