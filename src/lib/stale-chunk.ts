/**
 * 7.10.1: recognising — and recovering from — a stale-deploy chunk failure.
 *
 * Every release replaces the Docker image, and with it every file under
 * `/_next/static/chunks/`, whose names carry the build hash. A tab that was
 * open before the update still holds the OLD page, and the first time that
 * page lazily needs a chunk it has not loaded yet (opening a video, a menu,
 * a dialog) it asks for a file that no longer exists: "Loading chunk 685
 * failed" — which the error boundary then presented as a broken screen
 * ("Something broke on this screen", 2026-09-16, on a phone opening a share
 * link). Nothing is actually broken; the page is simply from before the
 * update, and a reload fetches the current one.
 *
 * The boundary therefore reloads ONCE, automatically, when the error is a
 * chunk failure. `sessionStorage` remembers when it last did so, and a second
 * failure inside the cooldown shows the normal error card instead — a chunk
 * that is really missing (a broken build, a proxy serving stale files) must
 * not become an infinite reload loop. Both helpers are pure so the decision
 * is exercised by a script before release.
 */

/** Messages the three browser engines produce for a missing or stale chunk. */
const CHUNK_PATTERNS: RegExp[] = [
  /Loading chunk [\w-]+ failed/i, // webpack / Next.js (Chrome, Safari)
  /Loading CSS chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i, // Chrome native import()
  /Importing a module script failed/i, // Safari native import()
  /error loading dynamically imported module/i, // Firefox
]

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: unknown; message?: unknown }
  if (e.name === 'ChunkLoadError') return true
  const message = typeof e.message === 'string' ? e.message : ''
  return CHUNK_PATTERNS.some((re) => re.test(message))
}

/** sessionStorage key holding the epoch-ms of the last automatic reload. */
export const STALE_CHUNK_RELOAD_KEY = 'fc:stale-chunk-reload-at'

/**
 * A second chunk failure inside this window is not "the page is old" — the
 * page IS new by then — so it is shown rather than reloaded again.
 */
export const STALE_CHUNK_RELOAD_COOLDOWN_MS = 60_000

/**
 * Whether to reload now, given when the last automatic reload happened
 * (null = never in this tab).
 */
export function shouldReloadForStaleChunk(lastReloadAt: number | null, now: number): boolean {
  if (lastReloadAt === null || !Number.isFinite(lastReloadAt)) return true
  return now - lastReloadAt > STALE_CHUNK_RELOAD_COOLDOWN_MS
}
