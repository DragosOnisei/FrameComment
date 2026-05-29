'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FileText, Image as ImageIcon, Music, Film, Download, Loader2, X, Play, Pause } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { formatFileSize } from '@/lib/utils'

interface CommentAsset {
  id: string
  fileName: string
  fileSize: string
  fileType: string
  category: string | null
  createdAt: string
}

interface CommentAttachmentsProps {
  assets: CommentAsset[]
  videoId: string
  shareToken?: string | null
}

function getCategoryIcon(category: string | null, fileType: string) {
  if (category === 'image' || fileType.startsWith('image/')) return ImageIcon
  if (category === 'audio' || fileType.startsWith('audio/')) return Music
  if (category === 'video' || fileType.startsWith('video/')) return Film
  return FileText
}

export default function CommentAttachments({
  assets,
  videoId,
  shareToken,
}: CommentAttachmentsProps) {
  const t = useTranslations('comments')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  // Lightbox state — index of the image asset currently being previewed.
  const [lightboxAssetId, setLightboxAssetId] = useState<string | null>(null)

  if (!assets || assets.length === 0) return null

  const lightboxAsset = lightboxAssetId
    ? assets.find((a) => a.id === lightboxAssetId) || null
    : null

  const handleDownload = async (assetId: string) => {
    setDownloadingId(assetId)
    setDownloadError(null)
    try {
      let response: Response
      if (shareToken) {
        // Share page: use raw fetch with share token
        response = await fetch(
          `/api/videos/${videoId}/assets/${assetId}/download-token`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${shareToken}` },
          }
        )
      } else {
        // Admin page: use apiFetch which includes JWT
        response = await apiFetch(
          `/api/videos/${videoId}/assets/${assetId}/download-token`,
          { method: 'POST' }
        )
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || t('downloadFailed'))
      }

      const { url } = await response.json()
      window.location.href = url
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : t('downloadFailed'))
    } finally {
      setDownloadingId(null)
    }
  }

  // Group images so we can lay them out as a grid of thumbnails.
  const imageAssets = assets.filter(
    (a) => a.category === 'image' || a.fileType.startsWith('image/')
  )
  const otherAssets = assets.filter(
    (a) => !(a.category === 'image' || a.fileType.startsWith('image/'))
  )

  return (
    <div className="mt-2 space-y-1.5">
      {downloadError && (
        <p className="text-xs text-destructive">{downloadError}</p>
      )}

      {imageAssets.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {imageAssets.map((asset) => (
            <ImageThumbnail
              key={asset.id}
              asset={asset}
              videoId={videoId}
              shareToken={shareToken}
              onClick={() => setLightboxAssetId(asset.id)}
            />
          ))}
        </div>
      )}

      {otherAssets.map((asset) => {
        const isAudio = asset.category === 'audio' || asset.fileType.startsWith('audio/')

        if (isAudio) {
          return (
            <AudioAttachment
              key={asset.id}
              asset={asset}
              videoId={videoId}
              shareToken={shareToken}
            />
          )
        }

        const Icon = getCategoryIcon(asset.category, asset.fileType)
        const isDownloading = downloadingId === asset.id

        return (
          <button
            key={asset.id}
            onClick={() => handleDownload(asset.id)}
            disabled={isDownloading}
            className="flex items-center gap-2 px-2.5 py-1.5 bg-muted/40 border border-border/50 rounded-md text-sm hover:bg-muted/60 transition-colors w-full text-left group"
          >
            <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="truncate flex-1 text-foreground">{asset.fileName}</span>
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {formatFileSize(Number(asset.fileSize))}
            </span>
            {isDownloading ? (
              <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" />
            ) : (
              <Download className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
            )}
          </button>
        )
      })}

      {lightboxAsset && (
        <ImageLightbox
          asset={lightboxAsset}
          videoId={videoId}
          shareToken={shareToken}
          onClose={() => setLightboxAssetId(null)}
        />
      )}
    </div>
  )
}

/**
 * Hook: fetch a signed URL for an asset and return it. Re-runs on token / id
 * changes. Used by both the inline thumbnail and the lightbox so each one
 * pays for its own short-lived download URL.
 */
function useAssetUrl(
  videoId: string,
  assetId: string,
  shareToken: string | null | undefined
) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setUrl(null)
    ;(async () => {
      try {
        const path = `/api/videos/${videoId}/assets/${assetId}/download-token`
        const response = shareToken
          ? await fetch(path, {
              method: 'POST',
              headers: { Authorization: `Bearer ${shareToken}` },
            })
          : await apiFetch(path, { method: 'POST' })
        if (!response.ok) throw new Error('Failed to load')
        const json = await response.json()
        if (!cancelled) setUrl(json.url)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [videoId, assetId, shareToken])

  return { url, loading, error }
}

/** Thumbnail tile rendered inside the image grid. Click opens the lightbox. */
function ImageThumbnail({
  asset,
  videoId,
  shareToken,
  onClick,
}: {
  asset: CommentAsset
  videoId: string
  shareToken?: string | null
  onClick: () => void
}) {
  const { url, loading, error } = useAssetUrl(videoId, asset.id, shareToken)
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative aspect-square rounded-md overflow-hidden bg-muted border border-border/50 hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-primary/40"
      title={asset.fileName}
      aria-label={asset.fileName}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-destructive p-1 text-center">
          {error}
        </div>
      )}
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={asset.fileName}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      )}
    </button>
  )
}

/** Full-screen modal that shows a single image. Closes on click outside / Esc. */
function ImageLightbox({
  asset,
  videoId,
  shareToken,
  onClose,
}: {
  asset: CommentAsset
  videoId: string
  shareToken?: string | null
  onClose: () => void
}) {
  const { url, loading, error } = useAssetUrl(videoId, asset.id, shareToken)

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </button>
      <div
        className="max-w-[95vw] max-h-[95vh] flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {loading && <Loader2 className="w-8 h-8 animate-spin text-white" />}
        {error && <span className="text-white">{error}</span>}
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.fileName}
            className="max-w-full max-h-[85vh] object-contain rounded-md"
          />
        )}
        <div className="text-xs text-white/70">
          {asset.fileName} · {formatFileSize(Number(asset.fileSize))}
        </div>
      </div>
    </div>
  )
}

/**
 * Inline audio player for voice messages and other audio attachments.
 * Fetches a signed download URL on mount and feeds it into a native <audio>.
 */
function AudioAttachment({
  asset,
  videoId,
  shareToken,
}: {
  asset: CommentAsset
  videoId: string
  shareToken?: string | null
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchUrl = async () => {
      setLoading(true)
      setError(null)
      try {
        let response: Response
        if (shareToken) {
          response = await fetch(
            `/api/videos/${videoId}/assets/${asset.id}/download-token`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${shareToken}` },
            }
          )
        } else {
          response = await apiFetch(
            `/api/videos/${videoId}/assets/${asset.id}/download-token`,
            { method: 'POST' }
          )
        }
        if (!response.ok) throw new Error('Failed to load audio')
        const { url } = await response.json()
        if (!cancelled) setAudioUrl(url)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load audio')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchUrl()
    return () => {
      cancelled = true
    }
  }, [asset.id, videoId, shareToken])

  return (
    // 1.9.1+: themed custom player instead of the native <audio
    // controls> (which was an ugly white pill on our dark UI).
    // Mirrors the VoiceRecorderButton preview: bg-muted/40 chip
    // with a play/pause circle, a continuous track + fill + thumb,
    // driven by rAF at 60fps + click/drag-to-scrub.
    <div className="py-0.5 w-full">
      {loading && (
        <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
      {audioUrl && <ThemedAudioPlayer src={audioUrl} />}
    </div>
  )
}

/**
 * 1.9.1+: themed inline audio player used for voice-message
 * comment attachments. Mirrors the VoiceRecorderButton preview UI
 * exactly so a voice comment looks the same whether it's about to
 * be sent or already saved. Play/pause + continuous-line scrubber
 * + draggable thumb + rAF-driven smoothness.
 */
function ThemedAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [audioDuration, setAudioDuration] = useState(0)
  const [isScrubbing, setIsScrubbing] = useState(false)

  const INSET = 8 // matches px-2 on the outer chip, keeps the thumb in bounds

  // 1.9.1+: resolve duration BEFORE play, while the audio is
  // paused. Chrome's MediaRecorder webm blobs report
  // `audio.duration === Infinity` until you seek past the end —
  // but if we do that seek while the audio is PLAYING it races
  // to the end, fires `ended`, and forces the user to click Play
  // again (the original "thumb jumps to end → start → play" bug).
  // Doing it while paused, the seek just updates metadata; no
  // `ended` fires because the audio isn't advancing.
  const togglePlay = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    if (!a.paused) {
      a.pause()
      return
    }
    const needsResolve =
      !Number.isFinite(a.duration) || a.duration <= 0
    if (!needsResolve) {
      void a.play()
      return
    }
    // First play on a webm with no embedded duration: force-seek
    // past the end while paused, wait for durationchange, then
    // rewind to 0 and play.
    const onResolved = () => {
      a.removeEventListener('durationchange', onResolved)
      try {
        a.currentTime = 0
      } catch {}
      void a.play()
    }
    a.addEventListener('durationchange', onResolved)
    try {
      a.currentTime = 1e10
    } catch {
      a.removeEventListener('durationchange', onResolved)
      void a.play()
    }
  }, [])

  // Just record the duration whenever the browser tells us about
  // it — no seek trick here. The seek-to-resolve only happens in
  // togglePlay above, while paused.
  const handleLoadedMetadata = useCallback(() => {
    const a = audioRef.current
    if (a && Number.isFinite(a.duration) && a.duration > 0) {
      setAudioDuration(a.duration)
    }
  }, [])
  const handleDurationChange = useCallback(() => {
    const a = audioRef.current
    if (a && Number.isFinite(a.duration) && a.duration > 0) {
      setAudioDuration(a.duration)
    }
  }, [])

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const a = audioRef.current
      const rect = trackRef.current?.getBoundingClientRect()
      if (!a || !rect) return
      const trackWidth = rect.width - INSET * 2
      if (trackWidth <= 0) return
      const x = clientX - rect.left - INSET
      const pct = Math.max(0, Math.min(1, x / trackWidth))
      const total =
        Number.isFinite(a.duration) && a.duration > 0
          ? a.duration
          : audioDuration
      if (total <= 0) return
      try {
        a.currentTime = pct * total
      } catch {}
      setProgress(pct)
    },
    [audioDuration],
  )
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      seekFromClientX(e.clientX)
      setIsScrubbing(true)
    },
    [seekFromClientX],
  )
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      seekFromClientX(t.clientX)
      setIsScrubbing(true)
    },
    [seekFromClientX],
  )
  useEffect(() => {
    if (!isScrubbing) return
    const onMouseMove = (e: MouseEvent) => seekFromClientX(e.clientX)
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t) seekFromClientX(t.clientX)
    }
    const onUp = () => setIsScrubbing(false)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchend', onUp)
    window.addEventListener('touchcancel', onUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchend', onUp)
      window.removeEventListener('touchcancel', onUp)
    }
  }, [isScrubbing, seekFromClientX])

  // 60 fps progress updates via rAF — onTimeUpdate fires only
  // 4–6 Hz so the thumb stuttered.
  useEffect(() => {
    if (!isPlaying || isScrubbing) return
    let raf = 0
    const tick = () => {
      const a = audioRef.current
      if (a) {
        const total =
          Number.isFinite(a.duration) && a.duration > 0
            ? a.duration
            : audioDuration
        if (total > 0) {
          setProgress(Math.min(1, a.currentTime / total))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, isScrubbing, audioDuration])

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 border border-border min-w-0 w-full">
      <button
        type="button"
        onClick={togglePlay}
        className="w-6 h-6 shrink-0 flex items-center justify-center rounded-full bg-foreground/10 hover:bg-foreground/20 text-foreground transition-colors"
        title={isPlaying ? 'Pause' : 'Play'}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <Pause className="w-3 h-3" fill="currentColor" />
        ) : (
          <Play className="w-3 h-3 ml-[1px]" fill="currentColor" />
        )}
      </button>
      <div
        ref={trackRef}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className="relative h-5 flex-1 min-w-0 cursor-pointer touch-none flex items-center px-2"
      >
        <div className="relative w-full h-[3px] rounded-full bg-muted-foreground/40">
          <div
            className="absolute inset-y-0 left-0 bg-primary rounded-full"
            style={{ width: `${progress * 100}%` }}
          />
          <div
            className="absolute top-1/2 w-3 h-3 rounded-full bg-primary shadow-md ring-2 ring-background pointer-events-none"
            style={{
              left: `${progress * 100}%`,
              transform: 'translate(-50%, -50%)',
            }}
          />
        </div>
      </div>
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleDurationChange}
        onEnded={() => {
          setIsPlaying(false)
          setProgress(0)
          if (audioRef.current) audioRef.current.currentTime = 0
        }}
        className="hidden"
        preload="metadata"
      />
    </div>
  )
}
