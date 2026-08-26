'use client'

import { useEffect, useRef, useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

/**
 * 7.3.1 — show the screenshot, rather than a broken-image icon.
 *
 * THE BUG THIS FIXES
 *
 * 7.3.0 put the endpoint straight into `<img src>` and `<video src>`. Every
 * attachment in the inbox came out broken, and the reason is the one written at
 * the top of ProjectCoverImage: this app authenticates with a bearer token that
 * lives in memory, and the refresh cookie is scoped to /api/auth. A native
 * `<img>` sends neither, so the request arrives with no credentials at all and
 * the founder guard answers 404. The picture was never missing — it was never
 * asked for in a way that could succeed.
 *
 * So the bytes are pulled with `apiFetch`, which attaches the header, and
 * handed to the tag as a blob: URL. Same shape as the project cover, for the
 * same reason. The alternative would be a signed URL on the endpoint, which is
 * a link that can be forwarded — the wrong trade for files that belong to one
 * company and are being read by another, which is exactly what this inbox is.
 *
 * Videos are loaded whole rather than streamed by range, which is acceptable
 * only because these are capped at 25MB at the upload end. If that cap ever
 * rises, this needs a real ranged endpoint instead.
 */
export default function FeedbackAttachment({
  feedbackId,
  attachmentId,
  fileName,
  fileType,
}: {
  feedbackId: string
  attachmentId: string
  fileName: string
  fileType: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const lastUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await apiFetch(`/api/feedback/${feedbackId}/attachments/${attachmentId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (cancelled) return
        const objectUrl = URL.createObjectURL(blob)
        if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current)
        lastUrlRef.current = objectUrl
        setSrc(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [feedbackId, attachmentId])

  // The blob pins the whole file in memory until it is revoked, and this inbox
  // holds every report from every organisation at once.
  useEffect(() => {
    return () => {
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current)
        lastUrlRef.current = null
      }
    }
  }, [])

  // The placeholders are flex boxes; the media is not. Putting `flex` on an
  // <img> or a <video> makes the element its own flex container, which is not
  // what centring a spinner needs and does strange things to how a video sizes
  // itself, so the two cases keep separate classes.
  const box = 'h-36 w-48 rounded-lg ring-1 ring-white/10 bg-black/40 flex items-center justify-center'
  const media = 'h-36 max-w-full rounded-lg ring-1 ring-white/10 bg-black/40'

  if (failed) {
    return (
      <div className={`${box} gap-1.5 px-3 text-[11px] text-muted-foreground`}>
        <ImageOff className="h-4 w-4 shrink-0" />
        <span className="truncate">{fileName}</span>
      </div>
    )
  }

  if (!src) {
    return (
      <div className={box}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (fileType.startsWith('video/')) {
    return <video src={src} controls className={media} />
  }

  return (
    // `object-contain`: a screenshot cropped to fill the box is a screenshot
    // with the broken part cut off, which defeats the purpose of attaching it.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={fileName} className={`${media} object-contain`} />
  )
}
