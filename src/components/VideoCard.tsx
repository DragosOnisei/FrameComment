'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpFromLine,
  Film as FilmIcon,
  FolderPlus,
  Image as ImageIcon,
  MoreVertical,
  Pencil,
  Scissors,
  Share2,
  Trash2,
  MessageSquare,
  Check,
} from 'lucide-react'

/**
 * Frame.io-style video card used in the admin folder drill page
 * (1.0.6+). The card mirrors `FolderCard`'s overall shape so folders
 * and videos sit happily on the same row in the grid, but adds a
 * proper Frame.io-flavoured thumbnail on top:
 *
 *  - Aspect-video cover area that paints the real first-frame
 *    thumbnail (via a server-minted `/api/content/<token>` URL).
 *  - Duration badge overlaid in the corner.
 *  - Speech-bubble badge with the comment count.
 *  - Footer with the name, then a single-line "Uploader · Date"
 *    subtext, plus a kebab.
 *
 * The whole card is clickable (opens the video in the player); the
 * kebab stops propagation to expose Rename / Delete without
 * triggering the open.
 */
export interface VideoCardProps {
  id: string
  name: string
  versionLabel?: string
  duration?: number
  versionCount?: number
  thumbnailUrl?: string | null
  /** Signed URL to a low-quality preview — used as the FALLBACK
   *  hover-scrub source when there's no storyboard sprite. */
  previewUrl?: string | null
  /** Signed URL to the storyboard sprite-sheet JPEG (10×10 grid of
   *  192×108 frames). When present the card scrubs via CSS
   *  background-position — instant, no seek. */
  storyboardUrl?: string | null
  /** Video processing status — drives the "Processing…" / "Failed"
   *  overlay shown over the cover so the user knows why there's no
   *  thumbnail yet. */
  status?: string
  approved?: boolean
  commentCount?: number
  uploaderName?: string | null
  createdAt?: string | Date
  /** Multi-select state — when true the top-left checkbox is filled
   *  and the card gets a primary ring. */
  isSelected?: boolean
  /** Toggle handler — wired by FolderBrowser. When provided, the
   *  checkbox renders even when the card isn't hovered (so the
   *  user can see what's already selected). */
  onToggleSelect?: (id: string) => void
  /** True while ANY video on the page is selected. In that mode a
   *  click anywhere on the card toggles selection (Frame.io-style)
   *  instead of opening the video. */
  selectionMode?: boolean
  // Drag-to-stack (1.0.6+). The card is both a drag SOURCE and a
  // drop TARGET; dragging one card onto another asks the parent to
  // stack the source as the new top version of the target.
  onStartVideoDrag?: (id: string) => void
  onEndVideoDrag?: () => void
  onStackOnto?: (sourceId: string, targetId: string) => void
  /** Visual flag: this card is currently the drag source. Renders
   *  ghosted so the user sees what they're moving. */
  isBeingDragged?: boolean
  /** Visual flag: another video is being dragged AND this card is
   *  a valid drop target (not the source itself). */
  isPotentialStackTarget?: boolean
  onOpen: (name: string) => void
  onRename?: (id: string, currentName: string) => void
  onDelete?: (id: string, currentName: string) => void
  /** Move the whole version group one level up in the folder tree
   *  (1.0.7+). When omitted (e.g. the video is already at the
   *  top-level folder where the parent would be the project root)
   *  the menu item is hidden. */
  onMoveUp?: (id: string) => void
  /** Share this single video as a public link (1.0.7+). When omitted
   *  the menu item is hidden — used on the public share page where
   *  the client should not be able to re-share. */
  onShare?: (id: string, currentName: string) => void
  /** Open the Split-versions modal (1.0.8+). Only meaningful when
   *  `versionCount > 1`; the menu item is hidden otherwise so a
   *  single-version card never shows a useless action. */
  onSplitVersions?: (id: string, currentName: string) => void
  /** Number of selected video cards on the page (1.0.9+). Drives
   *  bulk-aware kebab gating:
   *    ≥ 2  → hides Rename / Share / Split versions (none of those
   *           make sense across a selection). Delete and Move-up
   *           stay visible — the parent applies them to the whole
   *           selection regardless of which card was clicked.
   *    ≥ 1  → "New Folder with Selection" appears in the menu.
   *    0    → kebab behaves as before. */
  bulkSelectionCount?: number
  /** "New Folder with Selection" menu item (1.0.9+). Creates a new
   *  folder named "New Folder" in the current location, moves every
   *  selected video card into it, and opens the folder name for
   *  immediate rename. */
  onNewFolderWithSelection?: () => void
  /** Thumbnail URLs of every currently-selected card on the page
   *  (1.0.9+). When this card kicks off a bulk drag (it's selected
   *  AND ≥ 2 cards are selected) we paint a stack of these
   *  thumbnails as the custom HTML5 drag image so the cursor visibly
   *  carries every video, not just the one the user grabbed. */
  bulkDragThumbnails?: string[]
  /** 1.0.9+: distinguishes a real video asset from an image upload.
   *  `IMAGE` hides duration / hover-scrub / version label / the
   *  Split-versions action — none of which make sense for a still
   *  image — and swaps the empty-state Film icon for a Photo icon. */
  mediaType?: 'VIDEO' | 'IMAGE'
}

// Custom MIME for video drag — separate from the folder DnD so the
// two systems don't collide on dragOver detection.
const VIDEO_MIME = 'application/x-framecomment-video'

/**
 * Build a Frame.io-style "stacked thumbnails + count badge" element
 * to hand to `dataTransfer.setDragImage` (1.0.9+). The element is
 * positioned offscreen, snapshotted by the browser at the moment of
 * the call, then removed on the next tick.
 *
 * Up to three of the supplied thumbnail URLs are drawn at slight
 * rotational offsets (left/centre/right) so the cursor visibly
 * carries multiple cards instead of just the one the user grabbed.
 * A blue pill in the corner shows the full selection count even when
 * we've only managed to paint two or three tiles.
 */
function buildStackedDragImage(
  thumbnails: string[],
  count: number,
): HTMLElement {
  const root = document.createElement('div')
  // Off-screen but still in the layout — required for Chrome to
  // include it in the drag bitmap.
  root.style.cssText = [
    'position: absolute',
    'top: -10000px',
    'left: -10000px',
    'width: 180px',
    'height: 120px',
    'pointer-events: none',
    'font-family: system-ui, -apple-system, sans-serif',
  ].join(';')

  // Pick the first three thumbnails. Missing/empty entries skip
  // their tile but still count toward the badge.
  const tiles = thumbnails.filter((u) => !!u).slice(0, 3)
  const TILE_W = 140
  const TILE_H = 80
  // Render bottom-up so the front tile overlaps the ones behind it.
  for (let i = tiles.length - 1; i >= 0; i--) {
    const offset = i * 8 // px stagger between tiles
    const rotate = (i - (tiles.length - 1) / 2) * 5 // -5°..+5°
    const tile = document.createElement('div')
    tile.style.cssText = [
      'position: absolute',
      `top: ${10 + offset}px`,
      `left: ${10 + offset}px`,
      `width: ${TILE_W}px`,
      `height: ${TILE_H}px`,
      'border-radius: 8px',
      'border: 2px solid #ffffff',
      'box-shadow: 0 6px 16px rgba(0,0,0,0.35)',
      `transform: rotate(${rotate}deg)`,
      'overflow: hidden',
      `background: #000 url(${tiles[i]}) center/cover no-repeat`,
      `z-index: ${10 - i}`,
    ].join(';')
    root.appendChild(tile)
  }

  // Count badge — Frame.io-style blue circle anchored to the top-
  // right of the stack. Sits above every tile.
  const badge = document.createElement('div')
  badge.textContent = String(count)
  badge.style.cssText = [
    'position: absolute',
    'top: 0',
    'right: 0',
    'min-width: 28px',
    'height: 28px',
    'padding: 0 8px',
    'border-radius: 9999px',
    'background: #2563eb',
    'color: #ffffff',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'font-size: 13px',
    'font-weight: 700',
    'border: 2px solid #ffffff',
    'box-shadow: 0 2px 6px rgba(0,0,0,0.35)',
    'z-index: 20',
  ].join(';')
  root.appendChild(badge)

  return root
}

/** Format seconds as "m:ss" — matches the public share page. */
function formatDuration(duration?: number): string | null {
  if (typeof duration !== 'number' || duration <= 0) return null
  return `${Math.floor(duration / 60)}:${String(
    Math.floor(duration % 60),
  ).padStart(2, '0')}`
}

/** Friendly upload date — "Apr 17, 2025 at 7:42 PM" style. */
function formatUploadDate(value?: string | Date): string | null {
  if (!value) return null
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return null
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${date} at ${time}`
}

export default function VideoCard({
  id,
  name,
  versionLabel,
  duration,
  versionCount = 1,
  thumbnailUrl,
  previewUrl,
  storyboardUrl,
  status,
  approved,
  commentCount = 0,
  uploaderName,
  createdAt,
  isSelected = false,
  onToggleSelect,
  selectionMode = false,
  onStartVideoDrag,
  onEndVideoDrag,
  onStackOnto,
  isBeingDragged,
  isPotentialStackTarget,
  onOpen,
  onRename,
  onDelete,
  onMoveUp,
  onShare,
  onSplitVersions,
  bulkSelectionCount = 0,
  onNewFolderWithSelection,
  bulkDragThumbnails,
  mediaType = 'VIDEO',
}: VideoCardProps) {
  const isImage = mediaType === 'IMAGE'
  // Bulk-aware kebab gating (1.0.9+). When the user has 2+ videos
  // selected, single-target actions (Rename, Share, Split versions)
  // are hidden because they don't make sense across the selection.
  // Delete and Move up stay visible — the parent treats them as a
  // selection action.
  const isBulk = bulkSelectionCount >= 2
  const showRename = !!onRename && !isBulk
  const showShare = !!onShare && !isBulk
  const showSplit = !!onSplitVersions && versionCount > 1 && !isBulk
  // "New Folder with Selection" surfaces as soon as there's a
  // selection — even of just 1 video — so the user can quickly box a
  // video into its own folder.
  const showNewFolder = !!onNewFolderWithSelection && bulkSelectionCount >= 1
  // Hover state for the drop-target ring. Only set when ANOTHER
  // video is being dragged over THIS card.
  const [isStackHover, setIsStackHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [thumbErrored, setThumbErrored] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // ─── hover-scrub state (1.0.6+) ───────────────────────────
  // `scrubFraction` ranges 0…1; null when not hovering. Driving the
  // preview <video> off this single number makes the playhead line
  // and the video position trivially in sync.
  const [scrubFraction, setScrubFraction] = useState<number | null>(null)
  // True once the user has hovered at least once — gates loading the
  // preview file so we don't fetch every video the moment the
  // folder paints. The browser keeps the data cached afterwards.
  const [previewArmed, setPreviewArmed] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  // Track whether the preview element has reported metadata so we
  // know seek calls won't be no-ops. Until then we keep the
  // thumbnail visible.
  const [previewReady, setPreviewReady] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const fmtDuration = formatDuration(duration)
  const uploadDate = formatUploadDate(createdAt)
  // Always show the version badge (Frame.io style) — even on v1 the
  // user wants to know which version they're looking at. We only
  // skip the badge when no label is supplied at all. Image cards
  // suppress the badge entirely — image versioning isn't a 1.0.9
  // feature, and a stray "v1" on every image card just looks noisy.
  const versionTag = isImage ? null : versionLabel || null
  const hasThumb = !!thumbnailUrl && !thumbErrored
  // Storyboard sprite-sheet scrub (instant — preferred). Fall back to
  // <video> seeking when only previewUrl is available (legacy rows
  // that pre-date the storyboard worker step). Images never scrub —
  // there's nothing to seek through.
  const hasStoryboard = !!storyboardUrl && !isImage
  const canScrub =
    !isImage &&
    (hasStoryboard || !!previewUrl) &&
    typeof duration === 'number' &&
    duration > 0

  // Storyboard grid constants — match the worker's
  // generateStoryboard defaults. Keep these in sync if you change
  // the FFmpeg tile dimensions.
  const STORY_COLS = 10
  const STORY_ROWS = 10
  const STORY_CELLS = STORY_COLS * STORY_ROWS

  // Surface "thumbnail is on the way" inside the cover box (in place
  // of the plain Film icon) when the worker hasn't finished yet.
  // The folder drill page auto-polls every 4s while any video is in
  // these states, so this placeholder swaps to the real thumbnail
  // without a manual refresh.
  const isProcessing = status === 'UPLOADING' || status === 'PROCESSING'

  // Push the new scrub fraction into the preview <video> (legacy
  // fallback). When a storyboard sprite is available we skip this
  // entirely — scrubbing is pure CSS background-position there.
  const applyScrub = (fraction: number) => {
    if (hasStoryboard) return // sprite scrub handles it
    const v = videoRef.current
    if (!v || !duration) return
    const clamped = Math.max(0, Math.min(1, fraction))
    try {
      const target = duration * clamped
      if (typeof (v as any).fastSeek === 'function') {
        ;(v as any).fastSeek(target)
      } else {
        v.currentTime = target
      }
    } catch {
      // Ignore — happens during the brief window between metadata
      // load and the first seek being accepted.
    }
  }

  // Compute the sprite-sheet background-position for the current
  // scrub fraction. Each cell is 1/STORY_COLS wide and 1/STORY_ROWS
  // tall; with background-size 1000%×1000% the cell that should be
  // visible is selected by negative-percentage offsets.
  const storyboardStyle = (() => {
    if (!hasStoryboard || scrubFraction === null) return undefined
    const idx = Math.max(
      0,
      Math.min(STORY_CELLS - 1, Math.floor(scrubFraction * STORY_CELLS)),
    )
    const col = idx % STORY_COLS
    const row = Math.floor(idx / STORY_COLS)
    // Each step is 100 / (cols - 1) % so percentages span 0..100.
    const xPct = (col / (STORY_COLS - 1)) * 100
    const yPct = (row / (STORY_ROWS - 1)) * 100
    return {
      backgroundImage: `url(${storyboardUrl})`,
      backgroundRepeat: 'no-repeat' as const,
      backgroundSize: `${STORY_COLS * 100}% ${STORY_ROWS * 100}%`,
      backgroundPosition: `${xPct}% ${yPct}%`,
    }
  })()

  const handleScrub = (e: React.MouseEvent | React.PointerEvent) => {
    if (!canScrub || !coverRef.current) return
    const rect = coverRef.current.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / Math.max(1, rect.width)
    const clamped = Math.max(0, Math.min(1, fraction))
    setScrubFraction(clamped)
    applyScrub(clamped)
  }

  // Footer subtext: "Uploader · date" — falls back gracefully when
  // either piece is missing (legacy rows without createdById).
  const subParts: string[] = []
  if (uploaderName) subParts.push(uploaderName)
  if (uploadDate) subParts.push(uploadDate)
  const subtext = subParts.join(' • ')

  return (
    <div
      onClick={() => {
        if (selectionMode && onToggleSelect) {
          onToggleSelect(id)
        } else {
          onOpen(name)
        }
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (selectionMode && onToggleSelect) onToggleSelect(id)
          else onOpen(name)
        }
      }}
      // Drag SOURCE. 1.0.9+: drag is now always armed (was disabled
      // in selection mode in 1.0.6). The HTML5 DnD API distinguishes
      // click from drag by mouse-move threshold, so click-to-toggle
      // still works fine on the same card. Without this the bulk
      // drag-to-folder gesture would do nothing — by definition the
      // user has 2+ selected which would otherwise lock the drag
      // source.
      draggable={!!onStartVideoDrag}
      onDragStart={(e) => {
        if (!onStartVideoDrag) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(VIDEO_MIME, id)
        e.dataTransfer.setData('text/plain', `video:${id}`)
        // 1.0.9+: paint a custom drag image when this card is part
        // of a multi-select drag, so the cursor visibly carries
        // every selected thumbnail (stacked) plus a count badge —
        // rather than just the one card the user happened to grab.
        const isBulkDrag =
          isSelected &&
          bulkSelectionCount >= 2 &&
          bulkDragThumbnails &&
          bulkDragThumbnails.length >= 1
        if (isBulkDrag && bulkDragThumbnails) {
          const ghost = buildStackedDragImage(
            bulkDragThumbnails,
            bulkSelectionCount,
          )
          // Element must be in the DOM at the moment we call
          // setDragImage — the browser snapshots it synchronously.
          // We tuck it offscreen so it doesn't flash on the page
          // before being removed on the next tick.
          document.body.appendChild(ghost)
          // Anchor near the top-left of the stack so the cursor
          // sits where the user expects "the grabbed item" to be.
          e.dataTransfer.setDragImage(ghost, 28, 28)
          // Remove on next tick — by then the snapshot has been
          // taken and the DOM node is no longer needed.
          window.setTimeout(() => ghost.remove(), 0)
        }
        onStartVideoDrag(id)
      }}
      onDragEnd={() => {
        setIsStackHover(false)
        onEndVideoDrag?.()
      }}
      // Drop TARGET — accept ONLY the custom video MIME (so OS file
      // drops and folder drags don't try to "stack" into a video).
      onDragOver={(e) => {
        if (!onStackOnto) return
        const isVideo = Array.from(e.dataTransfer.types).includes(VIDEO_MIME)
        if (!isVideo) return
        if (isBeingDragged) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDragEnter={(e) => {
        if (!onStackOnto) return
        if (!Array.from(e.dataTransfer.types).includes(VIDEO_MIME)) return
        if (isBeingDragged) return
        setIsStackHover(true)
      }}
      onDragLeave={() => setIsStackHover(false)}
      onDrop={(e) => {
        if (!onStackOnto) return
        const sourceId = e.dataTransfer.getData(VIDEO_MIME)
        setIsStackHover(false)
        if (!sourceId || sourceId === id) return
        e.preventDefault()
        onStackOnto(sourceId, id)
      }}
      className={`group relative flex flex-col rounded-xl border bg-card cursor-pointer transition-all hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        isBeingDragged
          ? 'opacity-40 border-border/50 scale-[0.98]'
          : isStackHover
            ? 'border-primary ring-2 ring-primary/60 bg-primary/5'
            : isSelected
              ? 'border-primary ring-2 ring-primary/40'
              : isPotentialStackTarget
                ? 'border-border'
                : 'border-border/50 hover:border-border'
      }`}
      data-video-id={id}
    >
      {/* Cover — thumbnail (or Film icon fallback) with overlays. The
          card area is a fixed 16:9 box, but we use `object-contain`
          so the FULL frame of the video is visible regardless of its
          actual aspect ratio. Vertical 9:16 → black bars left/right;
          portrait 4:5 → black bars top/bottom. Matches Frame.io. */}
      <div
        ref={coverRef}
        className="relative aspect-video bg-black rounded-t-xl overflow-hidden"
        onMouseEnter={() => canScrub && setPreviewArmed(true)}
        onMouseMove={handleScrub}
        onPointerMove={handleScrub}
        onMouseLeave={() => {
          setScrubFraction(null)
          if (videoRef.current) videoRef.current.pause()
        }}
      >
        {hasThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl!}
            alt=""
            draggable={false}
            onError={() => setThumbErrored(true)}
            className="absolute inset-0 w-full h-full object-contain"
          />
        ) : isProcessing && !isImage ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground/70">
            <span
              className="inline-block w-7 h-7 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin"
              aria-hidden
            />
            <span className="text-xs">Generating thumbnail…</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/60">
            {isImage ? (
              <ImageIcon className="w-8 h-8" />
            ) : (
              <FilmIcon className="w-8 h-8" />
            )}
          </div>
        )}
        {/* Storyboard sprite-sheet scrub (instant). One JPEG packs
            100 frames; we just shift background-position to swap
            cells. Sits on top of the thumbnail and is only visible
            while the cursor is hovering the cover. */}
        {hasStoryboard && (
          <div
            className={`absolute inset-0 pointer-events-none transition-opacity ${
              scrubFraction !== null ? 'opacity-100' : 'opacity-0'
            }`}
            style={storyboardStyle}
          />
        )}
        {/* Fallback: low-res preview <video> for rows that don't
            yet have a storyboard. Mounted lazily on first hover. */}
        {!hasStoryboard && canScrub && previewArmed && (
          <video
            ref={videoRef}
            src={previewUrl!}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={() => {
              setPreviewReady(true)
              if (scrubFraction !== null) applyScrub(scrubFraction)
            }}
            className={`absolute inset-0 w-full h-full object-contain pointer-events-none transition-opacity ${
              previewReady && scrubFraction !== null
                ? 'opacity-100'
                : 'opacity-0'
            }`}
          />
        )}
        {/* Approved tick (bottom-left), version tag (top-right) and
            duration badge (bottom-right) overlay the cover. */}
        {versionTag && (
          <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/65 text-white text-xs font-medium tabular-nums backdrop-blur-sm">
            {versionTag}
          </span>
        )}
        {/* Multi-select checkbox (1.0.6+). Visible on hover, or
            always when this card is selected or any sibling is
            (handled by FolderBrowser passing `onToggleSelect`). */}
        {onToggleSelect && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelect(id)
            }}
            className={`absolute top-2 left-2 z-10 inline-flex items-center justify-center w-5 h-5 rounded transition-colors ${
              isSelected
                ? 'bg-primary text-white'
                : 'bg-black/40 text-white border border-white/60 backdrop-blur-sm hover:bg-black/60'
            }`}
            aria-pressed={isSelected}
            aria-label={isSelected ? 'Deselect video' : 'Select video'}
            title={isSelected ? 'Deselect' : 'Select'}
          >
            {isSelected && <Check className="w-3.5 h-3.5" />}
          </button>
        )}
        {approved && (
          <span
            className="absolute top-2 left-9 inline-flex items-center justify-center w-5 h-5 rounded-full bg-success text-white text-[10px] leading-none ring-2 ring-card"
            title="Approved"
            aria-label="Approved"
          >
            ✓
          </span>
        )}
        {/* Comment count + duration row sits along the bottom of the
            cover, like Frame.io. */}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent text-white">
          <div className="inline-flex items-center gap-1 text-xs tabular-nums">
            <MessageSquare className="w-3.5 h-3.5" />
            {commentCount}
          </div>
          {fmtDuration && (
            <span className="text-xs tabular-nums">{fmtDuration}</span>
          )}
        </div>
      </div>

      {/* Footer: name + meta + kebab */}
      <div className="flex items-start gap-2 p-4">
        <div className="flex-1 min-w-0">
          <div
            className="text-base font-semibold text-foreground truncate"
            title={name}
          >
            {name}
          </div>
          {subtext && (
            <div
              className="text-xs text-muted-foreground mt-1 truncate"
              title={subtext}
            >
              {subtext}
            </div>
          )}
        </div>
        {/* Kebab — only renders when at least one action is wired.
            On the public client share we omit Rename/Delete entirely,
            so the kebab disappears and the card stays read-only.
            1.0.9+: also respects bulk-mode gating so we don't show an
            empty popover when every visible item happens to be a
            single-target action in a multi-select context. */}
        {(showRename || onDelete || onMoveUp || showShare || showSplit || showNewFolder) && (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More actions"
            aria-label="Video actions"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              // 1.0.9+: bumped the min-width and added whitespace-
              // nowrap on every menu item so bulk labels like
              // "Move 3 up one folder" / "New Folder with 3 videos"
              // sit on a single line.
              className="absolute right-0 top-full mt-1 z-30 min-w-[240px] rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-2xl p-1"
              onClick={(e) => e.stopPropagation()}
            >
              {showRename && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onRename!(id, name)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left whitespace-nowrap"
                >
                  <Pencil className="w-4 h-4 shrink-0" />
                  Rename
                </button>
              )}
              {showShare && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onShare!(id, name)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left whitespace-nowrap"
                >
                  <Share2 className="w-4 h-4 shrink-0" />
                  Share video
                </button>
              )}
              {onMoveUp && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onMoveUp(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left whitespace-nowrap"
                >
                  <ArrowUpFromLine className="w-4 h-4 shrink-0" />
                  {isBulk
                    ? `Move ${bulkSelectionCount} up one folder`
                    : 'Move up one folder'}
                </button>
              )}
              {showNewFolder && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onNewFolderWithSelection!()
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left whitespace-nowrap"
                >
                  <FolderPlus className="w-4 h-4 shrink-0" />
                  {bulkSelectionCount > 1
                    ? `New Folder with ${bulkSelectionCount} videos`
                    : 'New Folder with selection'}
                </button>
              )}
              {showSplit && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onSplitVersions!(id, name)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left whitespace-nowrap"
                >
                  <Scissors className="w-4 h-4 shrink-0" />
                  Split versions
                </button>
              )}
              {onDelete && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    // 1.0.8+: parent shows a Frame.io-style
                    // ConfirmModal — no native window.confirm here.
                    // 1.0.9+: the parent reads the current selection
                    // and bulk-deletes when 2+ are selected, no
                    // matter which card's kebab was clicked.
                    setMenuOpen(false)
                    onDelete(id, name)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-destructive/10 text-destructive text-left whitespace-nowrap"
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  {isBulk ? `Delete ${bulkSelectionCount} videos` : 'Delete'}
                </button>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
