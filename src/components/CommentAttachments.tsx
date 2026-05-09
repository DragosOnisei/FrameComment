'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { FileText, Image as ImageIcon, Music, Film, Download, Loader2, X } from 'lucide-react'
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
    // Inline voice/audio attachment — just the native player. The music
    // icon and file-size label were removed (they were noise once the
    // player itself made the medium obvious). The player gets the full
    // width of the bubble so Chrome doesn't collapse the play button
    // on narrow sidebars.
    <div className="px-1 py-0.5">
      {loading && (
        <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
      {audioUrl && (
        <audio
          src={audioUrl}
          controls
          preload="metadata"
          className="h-9 w-full"
        />
      )}
    </div>
  )
}
