'use client'

import { useEffect, useState } from 'react'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { logError } from '@/lib/logging'
import {
  createAvatarStore,
  outcomeForStatus,
  type AvatarFetchOutcome,
} from '@/lib/avatar-cache'

/**
 * 7.4.1 — an avatar that shows the person's face, falling back to their
 * initials.
 *
 * The bytes are fetched once per user per page load and shared by every place
 * that draws them. That matters more than it sounds: a thread can hold forty
 * notes from the same person, and without the cache below that is forty
 * requests for one 27KB image. With it, one.
 *
 * Module scope rather than React state because the cache has to outlive any
 * single component — the avatar on a comment, on its timeline pin and on a
 * reply are three separate mounts asking for the same picture.
 *
 * 7.14.1: a failed fetch is NOT remembered as the answer. It used to be —
 * "asked for once and then quietly draws initials for the rest of the
 * session" — and that one sentence is why a colleague's face turned into
 * initials on every note until the page was reloaded: any single refused
 * request (a rate-limited burst, a token that expired in that second, a
 * network blip, a deploy mid-request) was cached as "no photo" for as long as
 * the tab lived. The policy now lives in src/lib/avatar-cache.ts: a photo is
 * kept for the session, "no photo" (404) for a minute, a transient refusal
 * only for a short backoff, and a mounted component retries when the backoff
 * ends. The fetcher below is the only browser-specific part.
 */
async function fetchAvatar(userId: string): Promise<AvatarFetchOutcome> {
  let res: Response
  try {
    res = await apiFetch(`/api/users/${userId}/avatar`)
  } catch (error) {
    logError('[avatar] request failed:', error)
    return { kind: 'transient' }
  }
  const kind = outcomeForStatus(res.status)
  if (kind === 'ok') {
    try {
      const blob = await res.blob()
      return { kind: 'ok', url: URL.createObjectURL(blob) }
    } catch (error) {
      logError('[avatar] body unreadable:', error)
      return { kind: 'transient' }
    }
  }
  if (kind === 'transient') {
    // Named in the console so the next "initials again" report can say which
    // status it was, instead of "sometimes".
    logError(`[avatar] ${res.status} for ${userId}; will retry`)
  }
  return kind === 'missing' ? { kind: 'missing' } : { kind: 'transient', status: res.status }
}

const store = createAvatarStore(fetchAvatar)

/** The cached avatar for a user, or null. Shared with the timeline pin. */
export function useAvatarUrl(userId?: string | null, hasAvatar?: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  /**
   * 7.4.1: your OWN photo comes from the session, with no request at all.
   *
   * The session payload already carries it — that is what draws the account
   * menu — so fetching it again to put the same face on your own comment is a
   * round trip for something already in memory. It matters at the one moment
   * the difference is visible: posting a note, where a cold cache meant a flash
   * of initials before the picture caught up, which is exactly what Dragos
   * reported. Everyone else's still comes from the route.
   */
  const { user } = useAuth()
  const ownAvatar =
    userId && user?.id === userId ? (user.avatarUrl ?? null) : null

  useEffect(() => {
    if (ownAvatar) {
      setUrl(ownAvatar)
      return
    }
    if (!userId) {
      setUrl(null)
      return
    }
    // 7.14.1: a photo already fetched wins over a payload that carries no
    // flag — a row rebuilt by a route that does not select `avatarUrl`
    // must not turn a face that is on screen back into initials.
    const known = store.peek(userId)
    if (known) {
      setUrl(known)
      return
    }
    if (!hasAvatar) {
      setUrl(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const attempt = () => {
      void store.load(userId).then((result) => {
        if (cancelled) return
        if (result.url !== null) {
          setUrl(result.url)
          return
        }
        // Transient refusals are retried while this component is mounted —
        // the list stays on screen for minutes, and the face should arrive
        // without anyone reloading. A confirmed "no photo" waits its minute
        // out and is asked once more, in case the flag was the stale party.
        // Capped so a server that keeps refusing is asked six times, not
        // forever.
        attempts += 1
        if (attempts >= 6) return
        timer = setTimeout(attempt, result.retryInMs)
      })
    }
    attempt()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [userId, hasAvatar, ownAvatar])
  return url
}

export default function UserAvatar({
  userId,
  hasAvatar,
  name,
  size = 'sm',
  isInternal = false,
  className,
}: {
  userId?: string | null
  /** Whether the server says this person has one, so we never ask for nothing. */
  hasAvatar?: boolean
  name?: string | null
  size?: 'sm' | 'md' | 'lg'
  isInternal?: boolean
  className?: string
}) {
  const url = useAvatarUrl(userId, hasAvatar)

  // Initials while it loads, and for good if there is nothing to load. Never a
  // blank circle: a hole where a person should be reads as broken.
  return (
    <InitialsAvatar
      name={name}
      imageUrl={url}
      size={size}
      isInternal={isInternal}
      className={className}
    />
  )
}
