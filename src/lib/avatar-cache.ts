/**
 * 7.14.1: the avatar cache, as a policy rather than a Map.
 *
 * Since 7.4.1 a person's photo is fetched once per page load and shared by
 * every comment, reply and timeline pin that shows them. The first version
 * remembered a FAILED fetch the same way it remembered a photo: as the
 * answer for the rest of the session. That read as sensible — "a user
 * whose avatar is missing is asked for once" — and it is exactly why Dragos
 * saw colleagues' faces replaced by initials until he reloaded the page
 * (2026-09-22, "a reapărut"). Any one refused request — a rate-limited
 * burst on the player page, a token that expired in the same second, a
 * network blip, a deploy replacing the server mid-request — turned into
 * initials for that person on every note, permanently, while the picture
 * itself was perfectly fine. A reload emptied the module cache, so a reload
 * "fixed" it, which is the tell of a negative cache with no expiry.
 *
 * The policy now distinguishes the answers:
 *   - a photo is kept for the session (nothing invalidates it but a reload,
 *     and the bytes never change under the same user id in practice);
 *   - "there is no photo" (404) is remembered for a minute — the comment
 *     payload said there was one, so the two disagree and the flag may be
 *     the stale party; asking again a minute later costs one request;
 *   - a transient refusal (401, 429, 5xx, a thrown fetch) is remembered
 *     only for a backoff — 2 s, 4 s, 8 s … up to 30 s — long enough that
 *     forty notes by the same person do not stampede the server after one
 *     failure, short enough that the next look at the list gets the face.
 *
 * Pure: the fetcher is injected, so a node script exercises the policy with
 * a fetcher that fails on purpose. `UserAvatar` supplies the real one.
 */

export type AvatarFetchOutcome =
  /** 2xx: the bytes, already turned into an object URL by the caller. */
  | { kind: 'ok'; url: string }
  /** 404 or 415: the server says this person has no usable photo. */
  | { kind: 'missing' }
  /** Anything else, including a thrown fetch. `status` is kept for the log. */
  | { kind: 'transient'; status?: number }

export type AvatarFetcher = (userId: string) => Promise<AvatarFetchOutcome>

export type AvatarLoadResult =
  | { url: string }
  /** No photo; ask again after `retryInMs` only if the caller still wants one. */
  | { url: null; missing: true; retryInMs: number }
  /** Refused for now; a mounted caller retries after `retryInMs`. */
  | { url: null; missing: false; retryInMs: number }

type Entry =
  | { kind: 'url'; url: string }
  | { kind: 'missing'; until: number }
  | { kind: 'transient'; until: number; failures: number }
  | { kind: 'pending'; promise: Promise<AvatarLoadResult> }

export const MISSING_TTL_MS = 60_000
export const TRANSIENT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000]

export function transientBackoffMs(failures: number): number {
  const idx = Math.min(Math.max(failures, 1), TRANSIENT_BACKOFF_MS.length) - 1
  return TRANSIENT_BACKOFF_MS[idx]
}

export interface AvatarStore {
  /** The photo already known for this person, or null. Never triggers a request. */
  peek(userId: string): string | null
  /** Ask, deduplicated: concurrent callers share one request; a fresh negative answer is honoured. */
  load(userId: string): Promise<AvatarLoadResult>
  /** Forget everything (tests, and a sign-out). */
  clear(): void
}

export function createAvatarStore(fetcher: AvatarFetcher, now: () => number = () => Date.now()): AvatarStore {
  const entries = new Map<string, Entry>()

  const peek = (userId: string): string | null => {
    const e = entries.get(userId)
    return e && e.kind === 'url' ? e.url : null
  }

  const load = (userId: string): Promise<AvatarLoadResult> => {
    const existing = entries.get(userId)
    const t = now()
    if (existing) {
      if (existing.kind === 'url') return Promise.resolve({ url: existing.url })
      if (existing.kind === 'pending') return existing.promise
      if (existing.until > t) {
        // A recent negative answer stands until it expires; the caller is told
        // how long, so a mounted component can come back exactly then.
        return Promise.resolve(
          existing.kind === 'missing'
            ? { url: null, missing: true, retryInMs: existing.until - t }
            : { url: null, missing: false, retryInMs: existing.until - t },
        )
      }
    }
    const failuresSoFar = existing && existing.kind === 'transient' ? existing.failures : 0

    const promise: Promise<AvatarLoadResult> = (async () => {
      let outcome: AvatarFetchOutcome
      try {
        outcome = await fetcher(userId)
      } catch {
        outcome = { kind: 'transient' }
      }
      const at = now()
      if (outcome.kind === 'ok') {
        entries.set(userId, { kind: 'url', url: outcome.url })
        return { url: outcome.url }
      }
      if (outcome.kind === 'missing') {
        entries.set(userId, { kind: 'missing', until: at + MISSING_TTL_MS })
        return { url: null, missing: true, retryInMs: MISSING_TTL_MS }
      }
      const failures = failuresSoFar + 1
      const backoff = transientBackoffMs(failures)
      entries.set(userId, { kind: 'transient', until: at + backoff, failures })
      return { url: null, missing: false, retryInMs: backoff }
    })()
    entries.set(userId, { kind: 'pending', promise })
    return promise
  }

  return { peek, load, clear: () => entries.clear() }
}

/** HTTP status → outcome, shared by the real fetcher and the tests. */
export function outcomeForStatus(status: number): AvatarFetchOutcome['kind'] {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 404 || status === 415) return 'missing'
  return 'transient'
}
