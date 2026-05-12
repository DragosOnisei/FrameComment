'use client'

import { useEffect, useRef, useState } from 'react'
import { Folder as FolderIcon, MoreVertical, Pencil, Trash2, Share2, ArrowRight } from 'lucide-react'

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
  onOpen: (folderId: string) => void
  onRename?: (folderId: string) => void
  onShare?: (folderId: string) => void
  onDelete?: (folderId: string) => void
  // Drag-and-drop (Phase F)
  onDragStart?: (folderId: string) => void
  onDragEnd?: () => void
  onDropFolder?: (sourceId: string, targetId: string) => void
  /** True when *this* card is currently the drag source — render
   *  ghosted so the user sees what they're moving. */
  isBeingDragged?: boolean
  /** True when a folder is being dragged AND this card is a valid
   *  drop target (not the source itself). The browser highlights it. */
  isPotentialDropTarget?: boolean
}

// Custom MIME type for the folder-drag payload. Custom types are
// preserved in DataTransfer across the drag lifecycle and let drop
// targets ignore non-folder drops (file uploads, OS files, etc).
const FOLDER_MIME = 'application/x-framecomment-folder'

export default function FolderCard({
  id,
  name,
  itemCount,
  slug,
  onOpen,
  onRename,
  onShare,
  onDelete,
  onDragStart,
  onDragEnd,
  onDropFolder,
  isBeingDragged,
  isPotentialDropTarget,
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
      // Drop TARGET
      onDragOver={(e) => {
        if (!onDropFolder) return
        // Only accept folder drops; ignore OS file drops etc.
        const isFolder = Array.from(e.dataTransfer.types).includes(FOLDER_MIME)
        if (!isFolder) return
        // Don't accept drops onto self.
        if (isBeingDragged) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDragEnter={(e) => {
        if (!onDropFolder) return
        if (!Array.from(e.dataTransfer.types).includes(FOLDER_MIME)) return
        if (isBeingDragged) return
        setIsHoveredDropTarget(true)
      }}
      onDragLeave={() => setIsHoveredDropTarget(false)}
      onDrop={(e) => {
        if (!onDropFolder) return
        const sourceId = e.dataTransfer.getData(FOLDER_MIME)
        setIsHoveredDropTarget(false)
        if (!sourceId || sourceId === id) return
        e.preventDefault()
        onDropFolder(sourceId, id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(id)
        }
      }}
      className={`
        group relative flex flex-col gap-4
        rounded-xl border bg-card
        p-5 cursor-pointer
        transition-all
        focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60
        ${isBeingDragged
          ? 'opacity-40 border-border/50 scale-[0.98]'
          : isHoveredDropTarget
            ? 'border-primary/80 ring-2 ring-primary/30 bg-primary/5'
            : isPotentialDropTarget
              ? 'border-border'
              : 'border-border/50 hover:border-border hover:shadow-md'
        }
      `}
      data-folder-id={id}
    >
      {/* Folder glyph + arrow on hover */}
      <div className="flex items-start justify-between">
        <div className="rounded-md bg-foreground/5 dark:bg-foreground/10 p-3">
          <FolderIcon className="w-7 h-7 text-primary" />
        </div>
        {/* Kebab — stops click from drilling into the folder */}
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
              {onDelete && (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    if (window.confirm(`Delete folder "${name}"? Subfolders will be deleted too. Videos inside will move back to the project root.`)) {
                      onDelete(id)
                    }
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
      </div>

      {/* Name + count */}
      <div className="min-w-0">
        <div className="text-base font-semibold text-foreground truncate" title={name}>
          {name}
        </div>
        <div className="text-xs text-muted-foreground mt-1 tabular-nums">
          {itemCount === 1 ? '1 item' : `${itemCount} items`}
        </div>
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
