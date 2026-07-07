'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpFromLine,
  Copy,
  Download,
  Film as FilmIcon,
  FolderPlus,
  Image as ImageIcon,
  MoreVertical,
  Pencil,
  RefreshCw,
  Scissors,
  Share2,
  Trash2,
  MessageSquare,
  Check,
  UploadCloud,
  FileText,
} from 'lucide-react'
import { computePopoverStyle } from '@/lib/popover-position'
import { useProcessingStatus } from '@/contexts/ProcessingStatusContext'

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
  /** TUS upload progress 0..100. Drives the thin bar overlaid on
   *  the bottom edge of the cover while `status === 'UPLOADING'`. */
  uploadProgress?: number | null
  /** Worker transcode progress 0..100. Drives the same thin bar
   *  while `status === 'PROCESSING'` so the user sees the worker
   *  chew through each tier rather than staring at a spinner. */
  processingProgress?: number | null
  /** 2.2.0+: ordered list of quality tiers the breadth-first
   *  pipeline plans to produce for this video (e.g.
   *  ['480p','720p','1080p']). NULL on legacy rows produced
   *  before 2.2.0 — readers MUST treat NULL as "we have no
   *  forward-looking tier info, fall back to the preview*Path
   *  columns to know what's playable". Only populated by the
   *  prepare-video job. */
  plannedTiers?: string[] | null
  /** 2.2.0+: tiers the encode-tier jobs have actually landed so
   *  far. NULL on legacy rows. When status===READY but this is
   *  strictly shorter than plannedTiers we know the video is
   *  playable but still climbing the ladder — that's the trigger
   *  for the "Encoding HD…" badge in the corner. */
  completedTiers?: string[] | null
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
  /** `additive` is true for Cmd/Ctrl-click (and the checkbox): toggle
   *  this card in/out of the selection, keeping the rest. `range` is
   *  true for Shift-click: select the contiguous range from the last
   *  anchor. A plain click (both false) selects ONLY this card
   *  (Finder/Explorer behaviour). */
  onToggleSelect?: (id: string, additive: boolean, range: boolean) => void
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
  /** 3.9.x: files dragged from the OS onto this card upload as a NEW
   *  VERSION of this video (same targeted-upload logic as dropping
   *  files onto a folder). The parent snapshots the DataTransfer and
   *  routes the upload through the stack-as-version path. */
  onDropOSFiles?: (targetVideoId: string, dataTransfer: DataTransfer) => void
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
  /** 3.8.x: regenerate this video's thumbnail (single-video only). Shown
   *  when wired — used when a clip ended up with a missing/broken cover. */
  onRegenerateThumbnail?: (id: string) => void
  /** 3.9.x: "Create Transcript" — generates a timecoded PDF transcript
   *  of this video (OpenAI whisper-1) into the current folder. */
  onCreateTranscript?: (id: string) => void
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
  /** 1.1.0+: download this card (sequential per version) — when
   *  ≥ 1 selected the parent's bulk download handler is called
   *  instead, which fans out across the full selection. */
  onDownload?: (id: string) => void
  /** 1.1.0+: real-file duplicate. Creates a copy in the current
   *  folder with a `(1)` / `(2)` suffix. When bulk (≥ 2), parent
   *  duplicates every selected item. */
  onDuplicate?: (id: string) => void
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
  uploadProgress,
  processingProgress,
  plannedTiers,
  completedTiers,
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
  onDropOSFiles,
  isBeingDragged,
  isPotentialStackTarget,
  onOpen,
  onRename,
  onDelete,
  onMoveUp,
  onShare,
  onSplitVersions,
  onRegenerateThumbnail,
  onCreateTranscript,
  bulkSelectionCount = 0,
  onNewFolderWithSelection,
  bulkDragThumbnails,
  mediaType = 'VIDEO',
  onDownload,
  onDuplicate,
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
  const showRegenThumb = !!onRegenerateThumbnail && !isBulk
  const showTranscript = !!onCreateTranscript && !isBulk
  // "New Folder with Selection" surfaces as soon as there's a
  // selection — even of just 1 video — so the user can quickly box a
  // video into its own folder.
  const showNewFolder = !!onNewFolderWithSelection && bulkSelectionCount >= 1
  // 1.1.0+: Download + Duplicate are always available when wired.
  const showDownload = !!onDownload
  const showDuplicate = !!onDuplicate
  // Hover state for the drop-target ring. Only set when ANOTHER
  // video is being dragged over THIS card.
  const [isStackHover, setIsStackHover] = useState(false)
  // 3.9.x: separate from `isStackHover` (in-app video→video stacking) —
  // lights up when the user drags real files from their OS over this
  // card, to upload them as a new version.
  const [isOSFileDropHover, setIsOSFileDropHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [thumbErrored, setThumbErrored] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // 1.3.1+: kebab popover uses smart fixed-positioning (Frame.io
  // style) — we anchor the menu to the kebab button via viewport
  // coordinates and clamp it inside the viewport edges so it never
  // overflows on phones, regardless of whether the card sits in the
  // left or right grid column.
  const kebabRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
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

  // 2.0.x+: sync the pulsing bar at the bottom of the cover with
  // whatever the global ProcessingStatusBanners is showing. That
  // endpoint already queries BullMQ + falls back to "N oldest
  // PROCESSING rows" + keeps READY-but-still-encoding videos in
  // the list, so reading from the same context here guarantees
  // the per-card indicator turns OFF at exactly the same moment
  // the banner says "All processing complete". The context's
  // hook returns empty arrays when no provider is mounted (e.g.
  // public share page), so this is safe in every render context.
  const { uploadingVideos, processingVideos } = useProcessingStatus()
  const isUploadingInQueue = uploadingVideos.some((v) => v.id === id)
  const isProcessingInQueue = processingVideos.some((v) => v.id === id)
  const showProgressBar = isUploadingInQueue || isProcessingInQueue
  const progressBarColour = isUploadingInQueue ? 'bg-primary' : 'bg-amber-500'

  // 2.2.0+: derive "still climbing the encode ladder" state for the
  // corner badge. The breadth-first pipeline writes plannedTiers
  // up front and appends to completedTiers per tier; status flips
  // to READY at the very first tier landing. So "READY but still
  // encoding HD" is the case where:
  //   - plannedTiers exists (post-2.2.0 row, NOT a legacy one)
  //   - completedTiers length is strictly less than plannedTiers
  //
  // Legacy rows produced before 2.2.0 will have plannedTiers ===
  // null and never trigger this badge — they retain their original
  // "tier badges from preview*Path columns" behaviour, controlled
  // elsewhere in the player's quality menu. This is the
  // backwards-compat invariant called out in the release plan.
  const planned: string[] = Array.isArray(plannedTiers) ? plannedTiers : []
  const completed: string[] = Array.isArray(completedTiers) ? completedTiers : []
  const stillClimbingTiers =
    status === 'READY' &&
    planned.length > 0 &&
    completed.length < planned.length

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
      // 1.7.0+: single-click ALWAYS toggles selection; the player
      // only opens on double-click. This mirrors how Finder /
      // Frame.io behave — single-click for selection state,
      // double-click to drill in. Falls back to `onOpen` only when
      // the card doesn't expose a select handler at all (legacy
      // call sites that don't wire multi-select).
      onClick={(e) => {
        if (onToggleSelect) {
          // Cmd/Ctrl extends, Shift selects a range; a plain click
          // selects only this card.
          onToggleSelect(id, e.metaKey || e.ctrlKey, e.shiftKey)
        } else {
          onOpen(name)
        }
      }}
      onDoubleClick={() => onOpen(name)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        // Enter on a focused card opens the video (keyboard
        // shortcut for "drill in"). Space is reserved for the
        // FolderBrowser-level Quick Preview overlay.
        if (e.key === 'Enter') {
          e.preventDefault()
          onOpen(name)
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
      // Drop TARGET — the custom video MIME stacks an in-app video as a
      // new version; 3.9.x adds OS file drops which UPLOAD as a new
      // version. Folder drags are ignored.
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer.types)
        const isVideo = types.includes(VIDEO_MIME)
        const isFiles = types.includes('Files')
        if (isVideo && onStackOnto) {
          if (isBeingDragged) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          return
        }
        // 3.9.x: real OS files → offer to upload as a new version. No
        // stopPropagation (container bails via data-accepts-os-files;
        // window resets its drop overlay).
        if (isFiles && !isVideo && onDropOSFiles) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!isOSFileDropHover) setIsOSFileDropHover(true)
        }
      }}
      onDragEnter={(e) => {
        const types = Array.from(e.dataTransfer.types)
        const isVideo = types.includes(VIDEO_MIME)
        const isFiles = types.includes('Files')
        if (isVideo && onStackOnto) {
          if (isBeingDragged) return
          setIsStackHover(true)
          return
        }
        if (isFiles && !isVideo && onDropOSFiles) {
          setIsOSFileDropHover(true)
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer truly leaves the card (children
        // fire spurious leaves otherwise).
        const next = e.relatedTarget as Node | null
        if (next && e.currentTarget.contains(next)) return
        setIsStackHover(false)
        setIsOSFileDropHover(false)
      }}
      onDrop={(e) => {
        const types = Array.from(e.dataTransfer.types)
        // OS file/folder drop → upload as a new version of this video.
        if (types.includes('Files') && onDropOSFiles) {
          e.preventDefault()
          setIsOSFileDropHover(false)
          onDropOSFiles(id, e.dataTransfer)
          return
        }
        if (!onStackOnto) return
        const sourceId = e.dataTransfer.getData(VIDEO_MIME)
        setIsStackHover(false)
        if (!sourceId || sourceId === id) return
        e.preventDefault()
        onStackOnto(sourceId, id)
      }}
      className={`group relative flex flex-col rounded-xl bg-white/[0.04] cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] ${
        isOSFileDropHover
          ? 'ring-2 ring-primary/70 bg-primary/15'
          : isBeingDragged
          ? 'opacity-40 ring-1 ring-white/10 scale-[0.98]'
          : isStackHover
            ? 'ring-2 ring-primary/60 bg-primary/10'
            : isSelected
              ? 'ring-2 ring-primary/50'
              : 'ring-1 ring-white/10 hover:ring-white/20 hover:shadow-[0_12px_28px_-12px_rgba(0,0,0,0.7)]'
      }`}
      data-video-id={id}
      // 3.9.x: marks this card as an OS-file drop target so the
      // FolderBrowser container drop handler bails (the card already
      // routed the files into a new version of this video).
      data-accepts-os-files={onDropOSFiles ? 'true' : undefined}
    >
      {/* Cover — thumbnail (or Film icon fallback) with overlays. The
          card area is a fixed 16:9 box, but we use `object-contain`
          so the FULL frame of the video is visible regardless of its
          actual aspect ratio. Vertical 9:16 → black bars left/right;
          portrait 4:5 → black bars top/bottom. Matches Frame.io. */}
      <div
        ref={coverRef}
        className="relative aspect-video bg-black/40 rounded-t-xl overflow-hidden"
        onMouseEnter={() => canScrub && setPreviewArmed(true)}
        onMouseMove={handleScrub}
        onPointerMove={handleScrub}
        onMouseLeave={() => {
          setScrubFraction(null)
          if (videoRef.current) videoRef.current.pause()
        }}
      >
        {/* 3.9.x: "New version" affordance shown only while dragging real
            files from the OS over this card. pointer-events-none so it
            never eats the drop. */}
        {isOSFileDropHover && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-1.5 bg-primary/25 backdrop-blur-[2px] pointer-events-none">
            <UploadCloud className="w-8 h-8 text-white drop-shadow" />
            <span className="text-xs font-semibold text-white drop-shadow">
              New version
            </span>
          </div>
        )}
        {hasThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl!}
            alt=""
            draggable={false}
            onError={() => setThumbErrored(true)}
            className="absolute inset-0 w-full h-full object-contain rounded-t-xl"
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
            className={`absolute inset-0 pointer-events-none transition-opacity rounded-t-xl ${
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
            className={`absolute inset-0 w-full h-full object-contain pointer-events-none transition-opacity rounded-t-xl ${
              previewReady && scrubFraction !== null
                ? 'opacity-100'
                : 'opacity-0'
            }`}
          />
        )}
        {/* Approved tick (bottom-left), version tag (top-right) and
            duration badge (bottom-right) overlay the cover. 2.5.0+:
            version tag picks up the v2.5 frosted-glass vocabulary
            so it visually composes with the rest of the chrome
            instead of feeling like a heavy black tab. */}
        {versionTag && (
          <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-white/10 text-white text-[11px] font-medium tabular-nums ring-1 ring-white/15 backdrop-blur-md">
            {versionTag}
          </span>
        )}
        {/* 2.2.0+: "Encoding HD…" pill — replaces the static quality
            badge for the small window between "video became playable
            at 480p" and "every higher tier (720p / 1080p / 2160p)
            also landed". We anchor right below the version tag, so
            both pieces of metadata are visible at once on the card.
            Backwards compat: legacy rows have plannedTiers === null
            and never trigger this branch — they keep their pre-2.2.0
            look. */}
        {stillClimbingTiers && !versionTag && (
          <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-amber-500/85 text-white text-[10px] font-semibold tracking-wide uppercase backdrop-blur-sm">
            Encoding HD…
          </span>
        )}
        {stillClimbingTiers && versionTag && (
          <span className="absolute top-9 right-2 px-2 py-0.5 rounded bg-amber-500/85 text-white text-[10px] font-semibold tracking-wide uppercase backdrop-blur-sm">
            Encoding HD…
          </span>
        )}
        {/* Multi-select checkbox (1.0.6+). 2.5.0+: glass when idle
            (transparent + hairline ring + backdrop-blur), brand
            blue when active — matches the FolderCard checkbox so
            the two card types pair visually in a mixed selection. */}
        {onToggleSelect && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              // The checkbox is the explicit multi-select affordance —
              // always toggle (additive), never collapse the selection.
              onToggleSelect(id, true, false)
            }}
            className={`absolute top-2 left-2 z-10 inline-flex items-center justify-center w-5 h-5 rounded-md transition-colors ${
              isSelected
                ? 'bg-primary text-white ring-1 ring-primary/60'
                : 'bg-white/10 text-white ring-1 ring-white/40 backdrop-blur-md hover:bg-white/20'
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
        {/* 2.0.x+: full-width pulsing bar pinned to the very bottom
            edge of the cover while the SAME video is listed as
            uploading or processing by ProcessingStatusBanners.
            That source of truth is the BullMQ active set + N-oldest
            fallback + READY-but-still-encoding extension, so the
            bar turns OFF at the exact moment the banner does — no
            more "video card says done, banner still says cooking"
            inconsistency. Mirrors the pulse animation the banner
            uses on its active status pip. */}
        {showProgressBar && (
          <div
            className={`absolute inset-x-0 bottom-0 h-1 animate-pulse z-10 ${progressBarColour}`}
            aria-hidden
          />
        )}
      </div>

      {/* Footer: name + meta + kebab. 2.5.0+ glass refresh — drops
          the opaque zinc tint in favour of a low-opacity white wash
          so the footer reads as one continuous surface with the
          cover above. Text steps to the v2.5 white hierarchy
          (`text-white` primary / `text-white/55` meta). */}
      <div className="flex items-start gap-2 p-4 rounded-b-xl">
        <div className="flex-1 min-w-0">
          {/* 2.5.0+: footer recipe sincronizat cu FolderCard —
              `p-4` peste tot + `text-base font-semibold` name +
              `text-xs mt-1` meta. Așa video, folder și New Folder
              ajung la exact aceeași înălțime în grid. */}
          <div
            className="text-base font-semibold text-white truncate"
            title={name}
            data-keep-title
          >
            {name}
          </div>
          {subtext && (
            <div
              className="text-xs text-white/55 mt-1 truncate"
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
        {(showRename || onDelete || onMoveUp || showShare || showSplit || showNewFolder || showDownload || showDuplicate) && (
        <div ref={menuRef} className="relative">
          <button
            ref={kebabRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (menuOpen) {
                setMenuOpen(false)
                return
              }
              // 1.3.1+: compute fixed coordinates anchored to the
              // kebab button. Right-align by default (menu's right
              // edge sits flush with the kebab's right edge), then
              // clamp so the menu never falls outside the visible
              // viewport on either side. This is what gives Frame.io
              // its phone-friendly popover that floats over adjacent
              // cards instead of overflowing off-screen.
              const rect = kebabRef.current?.getBoundingClientRect()
              // 2.5.0+: pin width to ~240px so bulk-aware labels
              // ("New Folder with N items", "Duplicate N items")
              // never overflow into a horizontal scrollbar.
              if (rect) setMenuStyle(computePopoverStyle(rect, { width: 240 }))
              setMenuOpen(true)
            }}
            className="rounded-md p-1.5 text-white/55 hover:text-white hover:bg-white/[0.08] transition-colors"
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
              // 1.3.1+: positioned via inline style (computed from
              // kebab bounding rect on open) so the menu can float
              // freely over adjacent cards and stay clamped inside the
              // viewport on phones — Frame.io style.
              style={{ ...menuStyle, backgroundColor: '#162533' }}
              className="z-50 overflow-y-auto rounded-lg text-white ring-1 ring-white/10 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.65)] p-1"
              onClick={(e) => e.stopPropagation()}
            >
              {/* 1.1.0+ menu order:
                  1. Download · Share
                  2. Duplicate · Rename · Split versions (single-only)
                  3. Move up · New Folder with selection
                  4. Delete                                          */}
              {showDownload && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onDownload!(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <Download className="w-4 h-4 shrink-0" />
                  {isBulk ? `Download ${bulkSelectionCount} items` : 'Download'}
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
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <Share2 className="w-4 h-4 shrink-0" />
                  Share video
                </button>
              )}
              {(showDownload || showShare) && (showDuplicate || showRename || showSplit || showRegenThumb || showTranscript) && (
                <div className="my-1 h-px bg-white/10" role="separator" />
              )}
              {showDuplicate && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onDuplicate!(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <Copy className="w-4 h-4 shrink-0" />
                  {isBulk ? `Duplicate ${bulkSelectionCount} items` : 'Duplicate'}
                </button>
              )}
              {showRename && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onRename!(id, name)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <Pencil className="w-4 h-4 shrink-0" />
                  Rename
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
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <Scissors className="w-4 h-4 shrink-0" />
                  Split versions
                </button>
              )}
              {showRegenThumb && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onRegenerateThumbnail!(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <RefreshCw className="w-4 h-4 shrink-0" />
                  Regenerate thumbnail
                </button>
              )}
              {showTranscript && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onCreateTranscript!(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <FileText className="w-4 h-4 shrink-0" />
                  Create transcript
                </button>
              )}
              {(showDuplicate || showRename || showSplit || showRegenThumb || showTranscript) && (onMoveUp || showNewFolder) && (
                <div className="my-1 h-px bg-white/10" role="separator" />
              )}
              {onMoveUp && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onMoveUp(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
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
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] text-left whitespace-nowrap"
                >
                  <FolderPlus className="w-4 h-4 shrink-0" />
                  {bulkSelectionCount > 1
                    ? `New Folder with ${bulkSelectionCount} items`
                    : 'New Folder with selection'}
                </button>
              )}
              {onDelete && (onMoveUp || showNewFolder || showDuplicate || showRename || showSplit || showRegenThumb || showTranscript || showDownload || showShare) && (
                <div className="my-1 h-px bg-white/10" role="separator" />
              )}
              {onDelete && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete(id, name)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-destructive/15 text-destructive text-left whitespace-nowrap"
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  {isBulk ? `Delete ${bulkSelectionCount} items` : 'Delete'}
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
