'use client'

import { useEffect, useRef } from 'react'
import {
  ArrowUp,
  ArrowUpFromLine,
  Download,
  FolderUp,
  FolderPlus,
  FolderLock,
  Trash2,
} from 'lucide-react'

/**
 * Frame.io-style right-click context menu that pops up over the
 * folder browser background. Wires:
 *
 *  - Upload Asset           → trigger the existing video upload flow
 *  - Upload Folder          → multi-file upload (stub for 1.0.6)
 *  - New Folder             → public folder (authMode = NONE)
 *  - New Restricted Folder  → password-gated folder (authMode = PASSWORD)
 *
 * 1.0.9+: when there's a multi-select active, the menu also surfaces
 * the same bulk actions available from the video kebab (Move up,
 * New Folder with Selection, Delete), so the user gets the full set
 * regardless of which gesture they use.
 *
 * Positioning is `fixed` at the click coordinates clamped inside the
 * viewport so the menu never overflows the page. Close on outside
 * click, Escape, scroll, or after picking an action.
 */
export interface FolderContextMenuProps {
  open: boolean
  x: number
  y: number
  onClose: () => void
  onUploadAsset?: () => void
  onUploadFolder?: () => void
  onNewFolder?: () => void
  onNewRestrictedFolder?: () => void
  /** Number of selected video cards on the page (1.0.9+). When >= 1
   *  the menu shows a bulk-actions block at the top; when 0 it stays
   *  exactly as before. */
  bulkSelectionCount?: number
  /** True when the bulk Move-up action is available (i.e. we're not
   *  already at the project root). When false the menu item is
   *  rendered disabled — the user sees it but can't trigger it. */
  canBulkMoveUp?: boolean
  onBulkMoveUp?: () => void
  onBulkNewFolderWithSelection?: () => void
  /** Sequentially downloads every selected video (1.0.9+). The
   *  parent already exposes the same flow via the floating
   *  selection toolbar; surfacing it here lets users grab the same
   *  files via right-click without scrolling to the toolbar. */
  onBulkDownload?: () => void
  onBulkDelete?: () => void
}

export default function FolderContextMenu({
  open,
  x,
  y,
  onClose,
  onUploadAsset,
  onUploadFolder,
  onNewFolder,
  onNewRestrictedFolder,
  bulkSelectionCount = 0,
  canBulkMoveUp = false,
  onBulkMoveUp,
  onBulkNewFolderWithSelection,
  onBulkDownload,
  onBulkDelete,
}: FolderContextMenuProps) {
  const hasSelection = bulkSelectionCount > 0
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = () => onClose()
    // capture: true so we close BEFORE another component handles the
    // click (e.g. clicking on a folder card shouldn't both navigate
    // AND keep the menu open).
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('touchstart', onPointerDown, { capture: true, passive: true })
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('touchstart', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, onClose])

  if (!open) return null

  // Clamp coordinates so the menu doesn't go off-screen. The menu
  // width changes with the selection (extra rows for bulk actions),
  // so we use a generous upper bound that fits the widest label
  // ("New Folder with N videos") on a single line.
  const MENU_W = 270
  const MENU_H = hasSelection ? 320 : 220
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 768
  const left = Math.min(x, Math.max(8, viewportW - MENU_W - 8))
  const top = Math.min(y, Math.max(8, viewportH - MENU_H - 8))

  const Row = ({
    icon,
    label,
    onClick,
    disabled,
    destructive,
  }: {
    icon: React.ReactNode
    label: string
    onClick?: () => void
    disabled?: boolean
    destructive?: boolean
  }) => (
    <button
      role="menuitem"
      type="button"
      onClick={() => {
        if (disabled) return
        onClose()
        onClick?.()
      }}
      disabled={disabled || !onClick}
      className={`
        w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-left
        transition-colors whitespace-nowrap
        ${disabled || !onClick
          ? 'opacity-40 cursor-not-allowed'
          : destructive
            ? 'hover:bg-destructive/10 text-destructive'
            : 'hover:bg-muted text-foreground'}
      `}
    >
      <span
        className={`shrink-0 ${
          destructive ? 'text-destructive' : 'text-muted-foreground'
        }`}
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[260px] rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-2xl p-1 animate-in fade-in-0 slide-in-from-top-1 duration-100"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {hasSelection && (
        <>
          <Row
            icon={<ArrowUpFromLine className="w-4 h-4" />}
            label={
              bulkSelectionCount === 1
                ? 'Move up one folder'
                : `Move ${bulkSelectionCount} up one folder`
            }
            onClick={canBulkMoveUp ? onBulkMoveUp : undefined}
            disabled={!canBulkMoveUp}
          />
          <Row
            icon={<FolderPlus className="w-4 h-4" />}
            label={
              bulkSelectionCount === 1
                ? 'New Folder with selection'
                : `New Folder with ${bulkSelectionCount} videos`
            }
            onClick={onBulkNewFolderWithSelection}
          />
          <Row
            icon={<Download className="w-4 h-4" />}
            label={
              bulkSelectionCount === 1
                ? 'Download'
                : `Download ${bulkSelectionCount} videos`
            }
            onClick={onBulkDownload}
          />
          <Row
            icon={<Trash2 className="w-4 h-4" />}
            label={
              bulkSelectionCount === 1
                ? 'Delete'
                : `Delete ${bulkSelectionCount} videos`
            }
            onClick={onBulkDelete}
            destructive
          />
          <div className="my-1 h-px bg-border/50" role="separator" />
        </>
      )}
      <Row icon={<ArrowUp className="w-4 h-4" />} label="Upload Asset" onClick={onUploadAsset} />
      <Row icon={<FolderUp className="w-4 h-4" />} label="Upload Folder" onClick={onUploadFolder} />
      <div className="my-1 h-px bg-border/50" role="separator" />
      <Row icon={<FolderPlus className="w-4 h-4" />} label="New Folder" onClick={onNewFolder} />
      <Row
        icon={<FolderLock className="w-4 h-4" />}
        label="New Restricted Folder"
        onClick={onNewRestrictedFolder}
      />
    </div>
  )
}
