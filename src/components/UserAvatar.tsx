'use client'

import { useEffect, useState } from 'react'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'

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
 * A failed fetch is remembered as `null`, so a user whose avatar is missing or
 * unreadable is asked for once and then quietly draws initials for the rest of
 * the session instead of retrying on every render.
 */
const cache = new Map<string, Promise<string | null>>()

function loadAvatar(userId: string): Promise<string | null> {
  const hit = cache.get(userId)
  if (hit) return hit
  const p = (async () => {
    try {
      const res = await apiFetch(`/api/users/${userId}/avatar`)
      if (!res.ok) return null
      const blob = await res.blob()
      return URL.createObjectURL(blob)
    } catch {
      return null
    }
  })()
  cache.set(userId, p)
  return p
}

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
    if (!userId || !hasAvatar) {
      setUrl(null)
      return
    }
    let cancelled = false
    void loadAvatar(userId).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
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
