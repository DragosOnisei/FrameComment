'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Film, Image as ImageIcon, Folder as FolderIcon } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { formatDuration } from '@/lib/utils'
import { formatBytes } from '@/lib/project-gradient'
import { ScrubTile } from './FolderCard'

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

  // 2.5.2+: PRE-FETCH folder contents BEFORE the overlay mounts.
  // The original implementation showed the modal frame instantly and
  // let FolderPreviewBody render a "Loading…" state while it fetched
  // /api/folders/[id] — that produced two visible flashes (the empty
  // popup arriving, then the width snapping when tiles landed). Now
  // the fetch runs while the overlay is still hidden, and the modal
  // only mounts once `folderContents` is in hand — so the popup
  // appears in one shot, already populated with real thumbnails. The
  // tradeoff is a brief invisible delay between Space-press and the
  // popup appearing; on a normal connection it's well under 200 ms.
  const folderKey = target?.kind === 'folder' ? target.id : null
  const [folderContents, setFolderContents] = useState<FolderContents | null>(null)
  useEffect(() => {
    if (!folderKey) {
      setFolderContents(null)
      return
    }
    // Reset to null so the modal stays hidden while we re-fetch when
    // the target switches from one folder to another.
    setFolderContents(null)
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`/api/folders/${folderKey}`)
        if (!res.ok) {
          if (!cancelled) setFolderContents({ folders: [], videos: [] })
          return
        }
        const data = await res.json()
        if (cancelled) return
        const folderNode = (data && data.folder) || {}
        const subFolders: FolderContents['folders'] = Array.isArray(folderNode?.subfolders)
          ? folderNode.subfolders.map((f: any) => ({
              id: f.id,
              name: f.name,
              itemCount: typeof f.itemCount === 'number' ? f.itemCount : undefined,
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
        setFolderContents({ folders: subFolders, videos: previewVideos })
      } catch {
        if (!cancelled) setFolderContents({ folders: [], videos: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folderKey])

  if (!target) return null

  // 2.5.2+: While we prefetch a folder's contents, render NOTHING.
  // The user pressed Space; the popup will appear in a moment with
  // real tiles. No empty frame, no skeleton, no width snap.
  if (target.kind === 'folder' && folderContents === null) return null

  return (
    <div
      // 2.5.1+: scrim made fully transparent — user explicitly
      // didn't want the dark backdrop behind the video preview
      // (a Quick Preview is a focused glance, not a modal that
      // demands page dismissal, so the page behind staying
      // visible & clickable on the outer area is the desired
      // affordance). Click-outside-to-close still works because
      // the wrapper catches the mouseDown.
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Quick preview"
    >
      {/* 2.5.1+: v2.5 frosted glass container — same recipe as
          ConfirmDialog / banners / tables (translucent navy +
          spotlight radial wash + 40px backdrop blur + hairline
          ring + elevation shadow). Replaces the old `bg-card`
          flat dark grey. */}
      <div
        className="relative rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white overflow-hidden max-w-[95vw] max-h-[92vh] w-full sm:w-auto flex flex-col"
        style={{
          backgroundColor: 'rgba(22, 37, 51, 0.62)',
          backgroundImage:
            'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          transform: 'translate3d(0, 0, 0)',
          willChange: 'backdrop-filter, transform',
          isolation: 'isolate',
        }}
      >
        {/* Close button — top right corner, floats over the
            content so it works for both video and folder modes.
            2.5.1+: glass pill matching Save Changes / Back. */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 inline-flex items-center justify-center w-8 h-8 rounded-md ring-1 ring-white/15 hover:ring-white/25 text-white/80 hover:text-white transition-colors"
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
            backdropFilter: 'blur(12px) saturate(140%)',
            WebkitBackdropFilter: 'blur(12px) saturate(140%)',
          }}
          aria-label="Close preview (Space / Esc)"
          title="Close (Space / Esc)"
        >
          <X className="w-4 h-4" />
        </button>

        {target.kind === 'video' ? (
          <VideoPreviewBody video={target} />
        ) : (
          <FolderPreviewBody
            folder={target}
            projectId={projectId}
            onClose={onClose}
            contents={folderContents!}
          />
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

  // 4.0.x: reliably start playback on open. `autoPlay` alone is blocked
  // by browsers for videos WITH sound (unless the site has a high media-
  // engagement score), which showed up as "the preview opens but just
  // sits paused at 0:00". We try to play with sound first; if the browser
  // rejects it, we retry MUTED (muted autoplay is always allowed) so the
  // clip actually runs — the user can unmute from the controls.
  const videoRef = useRef<HTMLVideoElement>(null)
  const tryAutoplay = () => {
    const el = videoRef.current
    if (!el) return
    const p = el.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        el.muted = true
        el.play().catch(() => {})
      })
    }
  }
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
            ref={videoRef}
            src={video.previewUrl}
            poster={video.thumbnailUrl || undefined}
            controls
            autoPlay
            preload="metadata"
            playsInline
            onLoadedData={tryAutoplay}
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
          <ImageIcon className="w-12 h-12 text-white/40" />
        ) : (
          <Film className="w-12 h-12 text-white/40" />
        )}
      </div>
      <div className="px-4 py-3 border-t border-white/10 min-w-0">
        <div className="text-sm font-medium break-words [overflow-wrap:anywhere] text-white">
          {video.name}
        </div>
        <div className="text-xs text-white/55 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
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
  | {
      kind: 'video'
      videoId: string
      thumbnailUrl: string
      // 3.5.x: hover-scrub the sub-folder mosaic tiles inside Quick
      // Preview too, same as the main folder grid.
      storyboardUrl?: string
    }
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
          <ImageIcon className="w-6 h-6 text-white/40" />
        ) : (
          <Film className="w-6 h-6 text-white/40" />
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
  // 2.5.2+: empty folders now show the same chunky centred glyph as
  // FolderCard (w-14 instead of the old w-10), so a Quick Preview
  // peek into a sub-folder reads consistently with the main folder
  // grid up top.
  if (items.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
        <FolderIcon className="w-14 h-14 text-primary/70" />
      </div>
    )
  }
  // 2.5.2+: tile fill matches FolderCard's `bg-white/[0.03]` so the
  // mosaic cells read as a frosted-glass surface, not as black boxes
  // covering the popup's glass tint.
  const baseTile =
    'overflow-hidden bg-white/[0.03] flex items-center justify-center'
  const tileKey = (t: PreviewTile) =>
    t.kind === 'video' ? `v:${t.videoId}` : `f:${t.folderId}`
  const renderTile = (t: PreviewTile, size: 'big' | 'small') => {
    if (t.kind === 'video') {
      // 3.5.x: reuse the grid's ScrubTile so each mosaic tile in Quick
      // Preview hover-scrubs its clip's storyboard too (and crops the
      // baked 16:9 letter-box for 9:16 clips), identical to the main
      // folder grid. Falls back to a static thumbnail when the clip has
      // no storyboard.
      return (
        <ScrubTile thumbnailUrl={t.thumbnailUrl} storyboardUrl={t.storyboardUrl} />
      )
    }
    // 2.5.2+: matches FolderCard's `w-10` / `w-7` so folder glyphs in
    // a sub-folder's mosaic stay legible at Quick Preview tile size.
    return (
      <FolderIcon
        className={`text-primary/70 ${size === 'big' ? 'w-10 h-10' : 'w-7 h-7'}`}
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
        <div className="grid grid-cols-2 gap-1 w-full h-full">
          {items.map((it) => (
            <div key={tileKey(it)} className={baseTile}>
              {renderTile(it, 'small')}
            </div>
          ))}
        </div>
      )}
      {items.length === 3 && (
        <div className="grid grid-cols-2 grid-rows-2 gap-1 w-full h-full">
          <div className={`${baseTile} row-span-2`}>
            {renderTile(items[0], 'big')}
          </div>
          <div className={baseTile}>{renderTile(items[1], 'small')}</div>
          <div className={baseTile}>{renderTile(items[2], 'small')}</div>
        </div>
      )}
      {items.length === 4 && (
        <div className="grid grid-cols-2 grid-rows-2 gap-1 w-full h-full">
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
  contents,
}: {
  folder: QuickPreviewFolder
  projectId?: string
  onClose: () => void
  /** 2.5.2+: Contents are now pre-fetched by the parent overlay and
   *  passed in as a prop, so the body renders fully-populated on
   *  first paint — no loading state, no skeleton, no width snap. */
  contents: FolderContents
}) {
  const router = useRouter()

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
      <div className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
        <FolderIcon className="w-5 h-5 text-primary/80 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate text-white">{folder.name}</div>
          {subtitle && (
            <div className="text-xs text-white/55">{subtitle}</div>
          )}
        </div>
      </div>
      <div
        className="p-4 overflow-y-auto custom-scrollbar"
        // Width is FIXED (not min/max) so any layout change inside
        // (e.g. a video tile's intrinsic dims showing through during
        // hover-scrub) can't jostle the panel. The 1/2/3-tile
        // breakpoints below pick a pixel-perfect width that fits the
        // columns + 12px gaps + 32px padding without overflow, capped
        // by viewport on narrow screens. Because contents are pre-
        // fetched by the parent, the width is correct on first paint.
        style={{
          maxHeight: '75vh',
          width: `min(95vw, ${
            Math.min(3, Math.max(1, contents.folders.length + contents.videos.length)) === 1
              ? 360
              : Math.min(3, Math.max(1, contents.folders.length + contents.videos.length)) === 2
              ? 520
              : 720
          }px)`,
        }}
      >
        {contents.folders.length === 0 && contents.videos.length === 0 ? (
          <div className="text-sm text-white/55 text-center py-8">
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
                // 2.0.x+: `min-w-0` so the tile inherits `minmax(0, 1fr)`
                // sizing properly. Without it, a grid item's default
                // `min-width: auto` falls back to its min-content —
                // and the moment ScrubThumbnail renders its <video>
                // (which has intrinsic dimensions like 1920×1080),
                // the column would grow / shrink to accommodate
                // those, jiggling the whole panel width.
                className="min-w-0 rounded-md overflow-hidden ring-1 ring-white/10 bg-white/[0.04] flex flex-col cursor-pointer hover:ring-primary/40 hover:bg-white/[0.07] transition-colors"
                title={`${f.name} — double-click to open`}
              >
                {/* 2.5.2+: same chunky-folder treatment as FolderCard
                    — light glass fill (white/[0.03]) + bigger glyphs
                    so the Quick Preview mosaic reads identically to
                    the main folder grid tiles, instead of the old
                    cramped icons on black. */}
                <div className="relative aspect-video bg-white/[0.03]">
                  <FolderCover previewItems={f.previewItems} />
                </div>
                <div className="px-2 py-1.5 flex items-center gap-1.5 min-w-0">
                  <FolderIcon className="w-3.5 h-3.5 text-primary/80 shrink-0" />
                  <span className="text-xs truncate text-white" title={f.name}>
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
                // 2.0.x+: see folder tile above — `min-w-0` keeps the
                // grid column from being inflated by the <video>'s
                // intrinsic size on first hover-scrub render.
                className="min-w-0 rounded-md overflow-hidden ring-1 ring-white/10 bg-white/[0.04] flex flex-col cursor-pointer hover:ring-primary/40 hover:bg-white/[0.07] transition-colors"
                title={`${v.name} — double-click to open`}
              >
                <ScrubThumbnail video={v} />
                <div className="px-2 py-1.5 text-xs truncate text-white" title={v.name}>
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
