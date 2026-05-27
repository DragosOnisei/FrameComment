'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Film, Image as ImageIcon, Folder as FolderIcon } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { formatDuration } from '@/lib/utils'
import { formatBytes } from '@/lib/project-gradient'

/**
 * 1.7.0+: macOS Quick Look-style preview overlay. Opens when the
 * user has exactly one item selected in the folder grid and hits
 * Space. Two flavours:
 *
 *  - VIDEO/IMAGE: renders the asset in a centered card with the
 *    native `<video controls>` element (or `<img>` for images) at
 *    the source's real aspect ratio. Metadata strip below.
 *
 *  - FOLDER: renders the folder's contents as a compact grid of
 *    thumbnails / sub-folder tiles, hydrated from /api/folders/[id].
 *    Doubles as a "what's inside?" peek without leaving the parent
 *    folder.
 *
 * Esc or Space closes. The overlay traps focus, locks body scroll,
 * and stops Space from scrolling the page underneath.
 */

export interface QuickPreviewVideo {
  kind: 'video'
  id: string
  name: string
  duration?: number | null
  width?: number | null
  height?: number | null
  mediaType?: 'VIDEO' | 'IMAGE'
  thumbnailUrl?: string | null
  previewUrl?: string | null
  versionLabel?: string | null
  uploaderName?: string | null
  createdAt?: string | Date | null
}

export interface QuickPreviewFolder {
  kind: 'folder'
  id: string
  name: string
  /** Top-level item count shown in the header subtitle */
  itemCount?: number
  /** Optional pre-computed total bytes (BigInt-as-string) */
  totalSize?: string | null
}

export type QuickPreviewTarget = QuickPreviewVideo | QuickPreviewFolder | null

interface QuickPreviewOverlayProps {
  target: QuickPreviewTarget
  onClose: () => void
  /** 1.7.0+: project id we're previewing inside, used to build
   *  navigation URLs when the user double-clicks a sub-folder or
   *  video tile in the folder Quick Preview grid. Optional so the
   *  overlay still works standalone if needed; without it
   *  double-click is a no-op. */
  projectId?: string
}

export default function QuickPreviewOverlay({ target, onClose, projectId }: QuickPreviewOverlayProps) {
  // Esc / Space close. We listen on the document so the binding
  // works regardless of which child has focus. `preventDefault` on
  // Space also stops the page from scrolling.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.code === 'Space' || e.key === ' ') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, onClose])

  // Lock body scroll while open so the underlying grid doesn't
  // jump when the cursor crosses into the overlay.
  useEffect(() => {
    if (!target) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [target])

  if (!target) return null

  return (
    <div
      className="fixed inset-0 z-[110] bg-background/85 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Quick preview"
    >
      <div className="relative bg-card border border-border rounded-xl shadow-elevation-lg overflow-hidden max-w-[95vw] max-h-[92vh] w-full sm:w-auto flex flex-col">
        {/* Close button — top right corner, floats over the
            content so it works for both video and folder modes. */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-md bg-background/70 hover:bg-background border border-border/50 transition-colors"
          aria-label="Close preview (Space / Esc)"
          title="Close (Space / Esc)"
        >
          <X className="w-4 h-4 text-foreground" />
        </button>

        {target.kind === 'video' ? (
          <VideoPreviewBody video={target} />
        ) : (
          <FolderPreviewBody folder={target} projectId={projectId} onClose={onClose} />
        )}
      </div>
    </div>
  )
}

/* ---------------- VIDEO / IMAGE body ---------------- */

function VideoPreviewBody({ video }: { video: QuickPreviewVideo }) {
  const isImage = video.mediaType === 'IMAGE'
  const aspectRatio =
    video.width && video.height && video.width > 0 && video.height > 0
      ? `${video.width} / ${video.height}`
      : '16 / 9'
  return (
    <>
      <div
        className="bg-black flex items-center justify-center"
        // Cap the media at 75% of the viewport height so the
        // metadata strip below always stays visible. Width tracks
        // the aspect ratio naturally.
        style={{
          aspectRatio,
          maxHeight: '75vh',
          maxWidth: '95vw',
        }}
      >
        {isImage && video.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnailUrl}
            alt={video.name}
            className="w-full h-full object-contain"
          />
        ) : video.previewUrl ? (
          <video
            key={video.id}
            src={video.previewUrl}
            poster={video.thumbnailUrl || undefined}
            controls
            autoPlay
            preload="metadata"
            playsInline
            className="w-full h-full object-contain bg-black"
          />
        ) : video.thumbnailUrl ? (
          // No preview transcode yet (still processing): fall back
          // to the static thumbnail so we don't render an empty box.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnailUrl}
            alt={video.name}
            className="w-full h-full object-contain opacity-90"
          />
        ) : isImage ? (
          <ImageIcon className="w-12 h-12 text-muted-foreground" />
        ) : (
          <Film className="w-12 h-12 text-muted-foreground" />
        )}
      </div>
      <div className="px-4 py-3 border-t border-border/50 min-w-0">
        <div className="text-sm font-medium break-words [overflow-wrap:anywhere]">
          {video.name}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
          {video.versionLabel && <span>{video.versionLabel}</span>}
          {!isImage && typeof video.duration === 'number' && video.duration > 0 && (
            <span>{formatDuration(video.duration)}</span>
          )}
          {video.width && video.height ? (
            <span>{video.width}×{video.height}</span>
          ) : null}
          {video.uploaderName && <span>· {video.uploaderName}</span>}
          {video.createdAt && (
            <span>· {new Date(video.createdAt).toLocaleDateString()}</span>
          )}
        </div>
      </div>
    </>
  )
}

/* ---------------- FOLDER body ---------------- */

type PreviewTile =
  | { kind: 'video'; videoId: string; thumbnailUrl: string }
  | { kind: 'folder'; folderId: string }

interface FolderContents {
  folders: Array<{
    id: string
    name: string
    itemCount?: number
    previewItems?: PreviewTile[]
  }>
  videos: Array<{
    id: string
    name: string
    thumbnailUrl: string | null
    /** Low-quality preview URL — used as the legacy hover-scrub
     *  source when there's no storyboard sprite yet. */
    previewUrl?: string | null
    /** Storyboard sprite-sheet URL — preferred hover-scrub source
     *  (CSS background-position, instant). */
    storyboardUrl?: string | null
    duration?: number | null
    mediaType?: 'VIDEO' | 'IMAGE'
  }>
}

/**
 * Hover-scrubbable thumbnail for a video tile inside the Quick
 * Preview folder grid. Mirrors VideoCard's strategy:
 *
 *  - PREFERRED: storyboard sprite-sheet (10×10 grid of frames).
 *    Hovering shifts CSS background-position to the cell that
 *    matches the mouse-X fraction. Instant — no network seeking.
 *  - FALLBACK: low-quality <video> preview (the 720p transcode).
 *    Hover sets `currentTime` to fraction × duration. Slower than
 *    sprites but supports legacy rows without a storyboard.
 *  - Static fallback: when neither is available (still processing,
 *    images) we keep the plain thumbnail / icon.
 */
function ScrubThumbnail({ video: v }: { video: FolderContents['videos'][number] }) {
  const STORY_COLS = 10
  const STORY_ROWS = 10
  const STORY_CELLS = STORY_COLS * STORY_ROWS

  const [scrubFraction, setScrubFraction] = useState<number | null>(null)
  const [thumbErrored, setThumbErrored] = useState(false)
  const coverRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const isImage = v.mediaType === 'IMAGE'
  const hasThumb = !!v.thumbnailUrl && !thumbErrored
  const hasStoryboard = !!v.storyboardUrl && !isImage
  const canScrub =
    !isImage &&
    (hasStoryboard || !!v.previewUrl) &&
    typeof v.duration === 'number' &&
    v.duration > 0

  // Push the scrub fraction into the legacy <video> seek path.
  const applyScrub = (fraction: number) => {
    if (hasStoryboard) return
    const el = videoRef.current
    if (!el || !v.duration) return
    try {
      const target = v.duration * Math.max(0, Math.min(1, fraction))
      if (typeof (el as any).fastSeek === 'function') {
        ;(el as any).fastSeek(target)
      } else {
        el.currentTime = target
      }
    } catch {
      /* metadata not ready yet — ignore */
    }
  }

  const handleScrub = (e: React.MouseEvent | React.PointerEvent) => {
    if (!canScrub || !coverRef.current) return
    const rect = coverRef.current.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / Math.max(1, rect.width)
    const clamped = Math.max(0, Math.min(1, fraction))
    setScrubFraction(clamped)
    applyScrub(clamped)
  }

  // Compute sprite-sheet background-position for the current fraction.
  const storyboardStyle = (() => {
    if (!hasStoryboard || scrubFraction === null) return undefined
    const idx = Math.max(
      0,
      Math.min(STORY_CELLS - 1, Math.floor(scrubFraction * STORY_CELLS)),
    )
    const col = idx % STORY_COLS
    const row = Math.floor(idx / STORY_COLS)
    const xPct = (col / (STORY_COLS - 1)) * 100
    const yPct = (row / (STORY_ROWS - 1)) * 100
    return {
      backgroundImage: `url(${v.storyboardUrl})`,
      backgroundRepeat: 'no-repeat' as const,
      backgroundSize: `${STORY_COLS * 100}% ${STORY_ROWS * 100}%`,
      backgroundPosition: `${xPct}% ${yPct}%`,
    }
  })()

  const scrubbing = scrubFraction !== null
  const showSprite = hasStoryboard && scrubbing
  const showLegacyVideo = !hasStoryboard && canScrub && scrubbing

  return (
    <div
      ref={coverRef}
      className="relative aspect-video bg-black flex items-center justify-center overflow-hidden"
      onPointerMove={handleScrub}
      onPointerLeave={() => setScrubFraction(null)}
    >
      {/* Sprite-sheet layer — paints the current cell via CSS only,
          no <img> required. Hidden until the user hovers and we
          know which frame to show. */}
      {showSprite && (
        <div className="absolute inset-0" style={storyboardStyle} aria-hidden />
      )}
      {/* Legacy <video> fallback — only rendered when scrubbing AND
          we don't have a storyboard. We seek via currentTime; the
          element stays muted + paused so it doesn't autoplay. */}
      {showLegacyVideo && v.previewUrl && (
        <video
          ref={videoRef}
          src={v.previewUrl}
          muted
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />
      )}
      {/* Static thumbnail layer underneath — visible whenever we're
          not scrubbing, or as a fallback if the sprite hasn't loaded. */}
      {!showSprite && !showLegacyVideo && (
        hasThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={v.thumbnailUrl!}
            alt=""
            className="w-full h-full object-contain"
            onError={() => setThumbErrored(true)}
          />
        ) : isImage ? (
          <ImageIcon className="w-6 h-6 text-muted-foreground" />
        ) : (
          <Film className="w-6 h-6 text-muted-foreground" />
        )
      )}
      {v.mediaType !== 'IMAGE' &&
        typeof v.duration === 'number' &&
        v.duration > 0 && (
          <span className="absolute bottom-1.5 right-1.5 px-1 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium tabular-nums z-10">
            {formatDuration(v.duration)}
          </span>
        )}
    </div>
  )
}

/**
 * Frame.io-style mosaic cover for a folder tile inside the Quick
 * Preview grid. Identical layout to the cover used by FolderCard
 * (kept as a small, self-contained copy here so this file stays
 * decoupled from the heavier FolderCard component).
 *
 * Layout:
 *   1 item  → one full tile
 *   2 items → split 50/50 vertical
 *   3 items → 1 big left + 2 stacked right
 *   4 items → quad split
 */
function FolderCover({ previewItems }: { previewItems?: PreviewTile[] }) {
  const items = (previewItems ?? []).slice(0, 4)
  if (items.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
        <FolderIcon className="w-10 h-10 text-primary/70" />
      </div>
    )
  }
  const baseTile =
    'overflow-hidden bg-black/30 dark:bg-black/40 flex items-center justify-center'
  const tileKey = (t: PreviewTile) =>
    t.kind === 'video' ? `v:${t.videoId}` : `f:${t.folderId}`
  const renderTile = (t: PreviewTile, size: 'big' | 'small') => {
    if (t.kind === 'video') {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={t.thumbnailUrl}
          alt=""
          draggable={false}
          // `object-contain` so vertical clips show their full frame
          // (letter-boxed inside the tile) instead of being cropped
          // to the tile's box like the grid cards do — Quick Preview
          // is for SEEING the content, not for the high-density
          // dashboard scan, so the trade-off here flips.
          className="w-full h-full object-contain"
          loading="lazy"
        />
      )
    }
    return (
      <FolderIcon
        className={`text-primary/70 ${size === 'big' ? 'w-8 h-8' : 'w-5 h-5'}`}
      />
    )
  }
  return (
    <div className="absolute inset-0" aria-hidden>
      {items.length === 1 && (
        <div className={`${baseTile} w-full h-full`}>
          {renderTile(items[0], 'big')}
        </div>
      )}
      {items.length === 2 && (
        <div className="grid grid-cols-2 gap-1 w-full h-full bg-card">
          {items.map((it) => (
            <div key={tileKey(it)} className={baseTile}>
              {renderTile(it, 'small')}
            </div>
          ))}
        </div>
      )}
      {items.length === 3 && (
        <div className="grid grid-cols-2 grid-rows-2 gap-1 w-full h-full bg-card">
          <div className={`${baseTile} row-span-2`}>
            {renderTile(items[0], 'big')}
          </div>
          <div className={baseTile}>{renderTile(items[1], 'small')}</div>
          <div className={baseTile}>{renderTile(items[2], 'small')}</div>
        </div>
      )}
      {items.length === 4 && (
        <div className="grid grid-cols-2 grid-rows-2 gap-1 w-full h-full bg-card">
          {items.map((it) => (
            <div key={tileKey(it)} className={baseTile}>
              {renderTile(it, 'small')}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FolderPreviewBody({
  folder,
  projectId,
  onClose,
}: {
  folder: QuickPreviewFolder
  projectId?: string
  onClose: () => void
}) {
  const router = useRouter()
  const [contents, setContents] = useState<FolderContents | null>(null)
  const [loading, setLoading] = useState(true)

  // 1.7.0+: navigation handlers — double-click a sub-folder to
  // drill into its dedicated page; double-click a video to open
  // the admin player. We close the overlay AFTER firing
  // router.push so the destination page resolves before the
  // overlay unmounts (mirrors the search overlay race fix).
  const openFolder = (folderId: string) => {
    if (!projectId) return
    router.push(`/admin/projects/${projectId}/folder/${folderId}`)
    requestAnimationFrame(() => onClose())
  }
  const openVideo = (name: string) => {
    if (!projectId) return
    const params = new URLSearchParams({ video: name })
    // Scope the player to this folder so the version-flyout shows
    // its siblings, not the entire project tree.
    params.set('folderId', folder.id)
    router.push(`/admin/projects/${projectId}/share?${params.toString()}`)
    requestAnimationFrame(() => onClose())
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await apiFetch(`/api/folders/${folder.id}`)
        if (!res.ok) {
          if (!cancelled) setContents({ folders: [], videos: [] })
          return
        }
        const data = await res.json()
        if (cancelled) return
        // The endpoint wraps everything in `{ folder, breadcrumb }`.
        // Direct contents live as `folder.subfolders` and
        // `folder.videos` — earlier draft of this component read
        // `data.folders` / `data.videos` at the top level and
        // always rendered "empty" because those keys don't exist.
        const folderNode = (data && data.folder) || {}
        const subFolders: FolderContents['folders'] = Array.isArray(folderNode?.subfolders)
          ? folderNode.subfolders.map((f: any) => ({
              id: f.id,
              name: f.name,
              itemCount: typeof f.itemCount === 'number' ? f.itemCount : undefined,
              // The folder GET endpoint pre-computes the Frame.io
              // mosaic tiles for every subfolder so a Quick Preview
              // peek can render the same cover the actual folder
              // card shows. Pass them through untouched.
              previewItems: Array.isArray(f.previewItems) ? f.previewItems : [],
            }))
          : []
        // Dedupe stacked versions just like the search API does so
        // a folder full of versioned exports doesn't surface every
        // sibling on the preview grid.
        const seen = new Map<string, any>()
        const rawVideos: any[] = Array.isArray(folderNode?.videos) ? folderNode.videos : []
        for (const v of rawVideos) {
          const key = v.name as string
          const existing = seen.get(key)
          if (!existing || (v.version ?? 0) > (existing.version ?? 0)) {
            seen.set(key, v)
          }
        }
        const previewVideos = Array.from(seen.values()).map((v: any) => ({
          id: v.id,
          name: v.name,
          thumbnailUrl: v.thumbnailUrl ?? null,
          previewUrl: v.previewUrl ?? null,
          storyboardUrl: v.storyboardUrl ?? null,
          duration: typeof v.duration === 'number' ? v.duration : null,
          mediaType: v.mediaType,
        }))
        setContents({ folders: subFolders, videos: previewVideos })
      } catch {
        if (!cancelled) setContents({ folders: [], videos: [] })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folder.id])

  const subtitle = useMemo(() => {
    const parts: string[] = []
    if (typeof folder.itemCount === 'number') {
      parts.push(`${folder.itemCount} ${folder.itemCount === 1 ? 'item' : 'items'}`)
    }
    if (folder.totalSize) {
      const bytes = Number(folder.totalSize)
      if (bytes > 0) parts.push(formatBytes(bytes))
    }
    return parts.join(' · ')
  }, [folder.itemCount, folder.totalSize])

  return (
    <>
      <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2">
        <FolderIcon className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{folder.name}</div>
          {subtitle && (
            <div className="text-xs text-muted-foreground">{subtitle}</div>
          )}
        </div>
      </div>
      <div
        className="p-4 overflow-y-auto"
        // Width stays tight so a 1-col grid (single folder) doesn't
        // stretch to half the monitor — capped at 720px and floored
        // at 640px (or 80vw, whichever is smaller on narrow screens)
        // so 3-col layouts still have room for legible thumbnails.
        style={{ maxHeight: '75vh', minWidth: 'min(80vw, 640px)', maxWidth: '720px' }}
      >
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            Loading…
          </div>
        ) : !contents || (contents.folders.length === 0 && contents.videos.length === 0) ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            This folder is empty.
          </div>
        ) : (
          <div
            // Folders + videos render as a single grid. Column
            // count caps at 3; with fewer items the grid template
            // collapses (1 item = 1 col full row, 2 = 50/50, 3 =
            // thirds). Items 4-9 wrap onto rows 2 and 3 of the
            // same 3-col template. Past 9 items the parent's
            // overflow-y-auto adds a vertical scroll.
            //
            // Tile width is `1fr` (fills its track) — we keep the
            // overall panel bounded via the outer `max-w-[720px]`
            // wrapper so a lone tile in a 1-col grid doesn't grow
            // to half the viewport width on big monitors.
            className="grid gap-3"
            style={{
              gridTemplateColumns: `repeat(${Math.min(
                3,
                Math.max(
                  1,
                  contents.folders.length + contents.videos.length,
                ),
              )}, minmax(0, 1fr))`,
            }}
          >
            {contents.folders.map((f) => (
              <div
                key={`folder-${f.id}`}
                role="button"
                tabIndex={0}
                onDoubleClick={() => openFolder(f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    openFolder(f.id)
                  }
                }}
                className="rounded-md overflow-hidden border border-border/50 bg-muted flex flex-col cursor-pointer hover:border-primary/40 transition-colors"
                title={`${f.name} — double-click to open`}
              >
                <div className="relative aspect-video bg-black/30 dark:bg-black/40">
                  <FolderCover previewItems={f.previewItems} />
                </div>
                <div className="px-2 py-1.5 flex items-center gap-1.5 min-w-0">
                  <FolderIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs truncate" title={f.name}>
                    {f.name}
                  </span>
                </div>
              </div>
            ))}
            {contents.videos.map((v) => (
              <div
                key={`video-${v.id}`}
                role="button"
                tabIndex={0}
                onDoubleClick={() => openVideo(v.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    openVideo(v.name)
                  }
                }}
                className="rounded-md overflow-hidden border border-border/50 bg-muted flex flex-col cursor-pointer hover:border-primary/40 transition-colors"
                title={`${v.name} — double-click to open`}
              >
                <ScrubThumbnail video={v} />
                <div className="px-2 py-1.5 text-xs truncate" title={v.name}>
                  {v.name}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
