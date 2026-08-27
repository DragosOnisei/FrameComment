'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageOff, Loader2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'

/**
 * 7.3.1 — show the screenshot, rather than a broken-image icon.
 *
 * THE BUG THIS FIXES
 *
 * 7.3.0 put the endpoint straight into `<img src>` and `<video src>`. Every
 * attachment in the inbox came out broken, and the reason is written at the top
 * of ProjectCoverImage: this app authenticates with a bearer token that lives
 * in memory, and the refresh cookie is scoped to /api/auth. A native `<img>`
 * sends neither, so the request arrives with no credentials at all and the
 * founder guard answers 404. The picture was never missing — it was never asked
 * for in a way that could succeed.
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
  const [zoomed, setZoomed] = useState(false)
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

  const isVideo = fileType.startsWith('video/')

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

  return (
    <>
      {isVideo ? (
        <video
          src={src}
          controls
          /**
           * 7.3.1: pressing play opens it big instead of playing it in a
           * 144-pixel box. The event fires after playback has begun, so the
           * inline element is stopped again immediately and the large copy
           * takes over from the start — which is what someone who pressed play
           * on a screen recording of a bug actually wanted.
           */
          onPlay={(e) => {
            e.currentTarget.pause()
            setZoomed(true)
          }}
          className={`${media} cursor-zoom-in`}
        />
      ) : (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          title="Open full size"
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {/* `object-contain`: a screenshot cropped to fill the box is a
              screenshot with the broken part cut off, which defeats the purpose
              of attaching it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={fileName} className={`${media} object-contain cursor-zoom-in`} />
        </button>
      )}

      {zoomed && (
        <Lightbox
          src={src}
          fileName={fileName}
          isVideo={isVideo}
          onClose={() => setZoomed(false)}
        />
      )}
    </>
  )
}

/**
 * 7.3.1 — the attachment at a size you can actually read.
 *
 * Portalled to <body> for the reason CommentAttachments' own lightbox records:
 * these cards sit on surfaces that use backdrop-filter and transforms, and any
 * such ancestor becomes the containing block for `position: fixed` children —
 * so a "full-screen" overlay rendered in place is trapped inside the card it
 * came from. Through a portal it covers the viewport.
 *
 * It reuses the blob URL the card already holds rather than fetching again.
 * That is not only cheaper: a second fetch would mint a second blob, and the
 * card revokes only its own on unmount.
 */
function Lightbox({
  src,
  fileName,
  isVideo,
  onClose,
}: {
  src: string
  fileName: string
  isVideo: boolean
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483600] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="flex max-h-[95vh] max-w-[95vw] flex-col items-center"
        // The media itself must not close the overlay: scrubbing a video means
        // pressing and dragging inside it, and that would dismiss the thing
        // being scrubbed.
        onClick={(e) => e.stopPropagation()}
      >
        {isVideo ? (
          <video
            src={src}
            controls
            autoPlay
            className="max-h-[92vh] max-w-full rounded-lg shadow-2xl"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={fileName}
            className="max-h-[92vh] max-w-full rounded-lg object-contain shadow-2xl"
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
