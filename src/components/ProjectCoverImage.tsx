'use client'

import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

/**
 * 1.2.0+: lazy <img> that pulls the admin project cover via apiFetch
 * (bearer-authed) and renders the result as a blob URL. We can't put
 * the endpoint URL directly into `<img src>` because the browser
 * wouldn't attach the admin Authorization header, so a native <img>
 * would 401. Going through fetch + URL.createObjectURL keeps the
 * cover private to admins without making the endpoint public.
 *
 * Falls back to nothing (parent should render the gradient layer
 * underneath) while loading and on error.
 */
export interface ProjectCoverImageProps {
  projectId: string
  /** Optional cache-bust value — passing `updatedAt` causes a refresh
   *  when the cover is replaced. */
  cacheKey?: string | number
  className?: string
  alt?: string
}

export default function ProjectCoverImage({
  projectId,
  cacheKey,
  className,
  alt = '',
}: ProjectCoverImageProps) {
  const [src, setSrc] = useState<string | null>(null)
  const lastUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const url = `/api/projects/${projectId}/cover${
          cacheKey !== undefined ? `?t=${encodeURIComponent(String(cacheKey))}` : ''
        }`
        const res = await apiFetch(url)
        if (!res.ok) {
          if (!cancelled) setSrc(null)
          return
        }
        const blob = await res.blob()
        if (cancelled) return
        const objectUrl = URL.createObjectURL(blob)
        if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current)
        lastUrlRef.current = objectUrl
        setSrc(objectUrl)
      } catch {
        if (!cancelled) setSrc(null)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [projectId, cacheKey])

  // Cleanup the blob URL on unmount so we don't leak memory.
  useEffect(() => {
    return () => {
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current)
        lastUrlRef.current = null
      }
    }
  }, [])

  if (!src) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} loading="lazy" />
}
