'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUpFromLine, Folder as FolderIcon, MoreVertical, Pencil, Trash2, Share2, ArrowRight } from 'lucide-react'

/**
 * Frame.io-style folder card used in the admin folder browser. A
 * single tile shows the folder name, the count of items inside, and
 * a kebab menu with rename / share / delete actions.
 *
 * The whole card is clickable (drills into the folder); the kebab
 * button stops propagation so clicking it opens the menu without
 * also navigating away.
 *
 * Drag-and-drop (1.0.6 Phase F): the card is both a drag SOURCE and
 * a drop TARGET. Dragging it onto another folder card calls
 * `onMove(sourceId, targetId)`. The parent (FolderBrowser) wires the
 * actual PATCH /api/folders/[id] request and the in-flight visual
 * feedback (`isBeingDragged`, `isDropTarget`).
 */
export interface FolderCardProps {
  id: string
  name: string
  itemCount: number
  /** Slug of the folder share — opens an external preview link */
  slug: string
  /** Up to four mosaic tiles to render in the cover area (1.0.7+).
   *  Each tile is either a video thumbnail or a folder glyph. When
   *  the array is omitted/empty, a single big folder glyph is shown. */
  previewItems?: Array<
    | { kind: 'video'; videoId: string; thumbnailUrl: string }
    | { kind: 'folder'; folderId: string }
  >
  onOpen: (folderId: string) => void
  onRename?: (folderId: string) => void
  onShare?: (folderId: string) => void
  onDelete?: (folderId: string) => void
  /** Move this folder one level up the tree (1.0.7+). When omitted
   *  (e.g. we're at the project root where there is nothing above)
   *  the menu item is hidden. */
  onMoveUp?: (folderId: string) => void
  // Drag-and-drop (Phase F)
  onDragStart?: (folderId: string) => void
  onDragEnd?: () => void
  onDropFolder?: (sourceId: string, targetId: string) => void
  /** Triggered when a video card is dropped onto this folder card
   *  (1.0.7+). The parent (FolderBrowser) reparents the whole version
   *  group into this folder via PATCH /api/videos/batch. */
  onDropVideo?: (sourceVideoId: string, targetFolderId: string) => void
  /** True when *this* card is currently the drag source — render
   *  ghosted so the user sees what they're moving. */
  isBeingDragged?: boolean
  /** True when a folder is being dragged AND this card is a valid
   *  drop target (not the source itself). The browser highlights it. */
  isPotentialDropTarget?: boolean
  /** True when a video card is being dragged anywhere on the page —
   *  every folder card lights up as a potential drop target. */
  isPotentialVideoDropTarget?: boolean
}

// Custom MIME types — folders carry FOLDER_MIME, videos carry
// VIDEO_MIME. We accept both as drop sources but discriminate so a
// folder-drop and a video-drop fire different handlers.
const FOLDER_MIME = 'application/x-framecomment-folder'
const VIDEO_MIME = 'application/x-framecomment-video'

export default function FolderCard({
  id,
  name,
  itemCount,
  slug,
  previewItems,
  onOpen,
  onRename,
  onShare,
  onDelete,
  onMoveUp,
  onDragStart,
  onDragEnd,
  onDropFolder,
  onDropVideo,
  isBeingDragged,
  isPotentialDropTarget,
  isPotentialVideoDropTarget,
}: FolderCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [isHoveredDropTarget, setIsHoveredDropTarget] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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

  return (
    <div
      onClick={() => onOpen(id)}
      role="button"
      tabIndex={0}
      // Drag SOURCE
      draggable={!!onDragStart}
      onDragStart={(e) => {
        if (!onDragStart) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(FOLDER_MIME, id)
        // Also stash a plain-text fallback for browsers that prefer
        // text/plain — the drop handler reads our custom MIME first.
        e.dataTransfer.setData('text/plain', `folder:${id}`)
        onDragStart(id)
      }}
      onDragEnd={() => {
        setIsHoveredDropTarget(false)
        onDragEnd?.()
      }}
      // Drop TARGET — accepts folder drops (reparent) and, 1.0.7+,
      // video drops (move the video into this folder).
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer.types)
        const isFolder = types.includes(FOLDER_MIME)
        const isVideo = types.includes(VIDEO_MIME)
        if (isFolder && onDropFolder && !isBeingDragged) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          return
        }
        if (isVideo && onDropVideo) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }
      }}
      onDragEnter={(e) => {
        const types = Array.from(e.dataTransfer.types)
        const isFolder = types.includes(FOLDER_MIME)
        const isVideo = types.includes(VIDEO_MIME)
        if (isFolder && onDropFolder && !isBeingDragged) {
          setIsHoveredDropTarget(true)
          return
        }
        if (isVideo && onDropVideo) {
          setIsHoveredDropTarget(true)
        }
      }}
      onDragLeave={() => setIsHoveredDropTarget(false)}
      onDrop={(e) => {
        setIsHoveredDropTarget(false)
        const folderSource = e.dataTransfer.getData(FOLDER_MIME)
        if (folderSource && onDropFolder && folderSource !== id) {
          e.preventDefault()
          onDropFolder(folderSource, id)
          return
        }
        const videoSource = e.dataTransfer.getData(VIDEO_MIME)
        if (videoSource && onDropVideo) {
          e.preventDefault()
          onDropVideo(videoSource, id)
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(id)
        }
      }}
      className={`
        group relative flex flex-col
        rounded-xl border bg-card cursor-pointer
        transition-all
        focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60
        ${isBeingDragged
          ? 'opacity-40 border-border/50 scale-[0.98]'
          : isHoveredDropTarget
            ? 'border-primary/80 ring-2 ring-primary/30 bg-primary/5'
            : isPotentialDropTarget || isPotentialVideoDropTarget
              ? 'border-primary/40 ring-1 ring-primary/20'
              : 'border-border/50 hover:border-border hover:shadow-md'
        }
      `}
      data-folder-id={id}
    >
      {/* Frame.io-style cover (1.0.7+) — takes the full card width
          with a fixed aspect ratio. When the folder has video
          children we render a mosaic of up to 4 thumbnails; empty
          folders fall back to the plain folder glyph centred in the
          cover area. Visually it now matches VideoCard so folders
          and videos read as one consistent grid. */}
      <div className="relative aspect-video w-full bg-muted/30 rounded-t-xl overflow-hidden">
        <FolderCover previewItems={previewItems} />
      </div>

      {/* Info row — name + count on the left, kebab on the right. */}
      <div className="flex items-start justify-between gap-2 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-foreground truncate" title={name}>
            {name}
          </div>
          <div className="text-xs text-muted-foreground mt-1 tabular-nums">
            {itemCount === 1 ? '1 item' : `${itemCount} items`}
          </div>
        </div>
        {/* Kebab — only renders when the card has at least one
            action wired. On the public client share we omit every
            action prop so this disappears and the card stays
            read-only (1.0.7+). */}
        {(onRename || onShare || onDelete || onMoveUp) && (
        <div ref={menuRef} className="relative shrink-0 -mr-1 -mt-1">
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
            aria-label="Folder actions"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-2xl p-1"
              onClick={(e) => e.stopPropagation()}
            >
              {onRename && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onRename(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
                >
                  <Pencil className="w-4 h-4 shrink-0" />
                  Rename
                </button>
              )}
              {onShare && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onShare(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
                >
                  <Share2 className="w-4 h-4 shrink-0" />
                  Share folder
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
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
                >
                  <ArrowUpFromLine className="w-4 h-4 shrink-0" />
                  Move up one folder
                </button>
              )}
              {onDelete && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    // 1.0.8+: parent shows a Frame.io-style
                    // ConfirmModal instead of a window.confirm prompt.
                    setMenuOpen(false)
                    onDelete(id)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-destructive/10 text-destructive text-left"
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {/* "Open" affordance on hover, visible on focus too */}
      <div className="absolute right-3 bottom-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity text-muted-foreground">
        <ArrowRight className="w-4 h-4" />
      </div>

      {/* Hidden: keep slug accessible for future drag-drop / copy-link */}
      <span className="sr-only" aria-hidden data-folder-slug={slug}>
        {slug}
      </span>
    </div>
  )
}

/**
 * Frame.io-style mosaic cover for a folder card (1.0.7+). Reads from
 * the `previewItems` array on the parent card and paints up to four
 * tiles arranged the same way Frame.io does:
 *
 *   1 item  → one full tile
 *   2 items → split 50/50 vertical
 *   3 items → 1 big left + 2 stacked right
 *   4 items → 1 big left + 3 stacked right
 *
 * When the array is empty (or missing), we render the original folder
 * glyph so empty folders still read as folders.
 */
function FolderCover({
  previewItems,
}: {
  previewItems?: FolderCardProps['previewItems']
}) {
  const items = (previewItems ?? []).slice(0, 4)

  // Empty folder → big folder glyph centred in the cover area.
  if (items.length === 0) {
    return (
      <div
        aria-hidden
        className="absolute inset-0 flex items-center justify-center"
      >
        <FolderIcon className="w-14 h-14 text-primary/70" />
      </div>
    )
  }

  const baseTile =
    'overflow-hidden bg-black/30 dark:bg-black/40 flex items-center justify-center'

  type Tile = NonNullable<FolderCardProps['previewItems']>[number]
  const tileKey = (t: Tile) =>
    t.kind === 'video' ? `v:${t.videoId}` : `f:${t.folderId}`
  // Folder tiles use a slightly smaller icon when the cover splits
  // into multiple cells so the glyphs stay readable. The "big" size
  // is used for the single full-cover and the left-half-of-three
  // case (where the tile is the same size as a 1-item cover would
  // be).
  const renderTile = (t: Tile, size: 'big' | 'small') => {
    if (t.kind === 'video') {
      return (
        <img
          src={t.thumbnailUrl}
          alt=""
          draggable={false}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      )
    }
    return (
      <FolderIcon
        className={`text-primary/70 ${
          size === 'big' ? 'w-10 h-10' : 'w-7 h-7'
        }`}
      />
    )
  }

  return (
    <div aria-hidden className="absolute inset-0">
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
