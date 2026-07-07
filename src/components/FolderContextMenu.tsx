'use client'

import { useEffect, useRef } from 'react'
import {
  ArrowUp,
  ArrowUpFromLine,
  Copy,
  Download,
  FolderUp,
  FolderPlus,
  FolderLock,
  Layers,
  Pencil,
  RefreshCw,
  FileText,
  Share2,
  Smartphone,
  Trash2,
  Youtube,
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
  /** 3.8.x: folder-structure templates. UGC → creates "9:16" + "4:5";
   *  YT → creates "IN EDIT" + "CLEAN" + "FINAL" inside the current folder. */
  onUgcTemplate?: () => void
  onYtTemplate?: () => void
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
  /** 1.1.0+: Share + Rename on a single selected item. Hidden when
   *  the selection is ≥ 2 (they don't make sense across a batch). */
  onBulkShare?: () => void
  onBulkRename?: () => void
  /** 1.1.0+: real-file Duplicate. Creates a copy of every selected
   *  item in the current folder with a `(1)`, `(2)`… suffix. */
  onBulkDuplicate?: () => void
  /** 3.5.x: Split versions on a single selected video that has >1
   *  version. Shown only when `canSplitVersions` is true (single
   *  multi-version video selected). */
  canSplitVersions?: boolean
  onSplitVersions?: () => void
  /** 3.8.x: regenerate the single selected video's thumbnail. Shown only
   *  when `canRegenerateThumbnail` (exactly one video selected). */
  canRegenerateThumbnail?: boolean
  onRegenerateThumbnail?: () => void
  /** 3.9.x: "Create Transcript" on a single video — same gate as
   *  regenerate thumbnail. */
  canCreateTranscript?: boolean
  onCreateTranscript?: () => void
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
  onUgcTemplate,
  onYtTemplate,
  bulkSelectionCount = 0,
  canBulkMoveUp = false,
  onBulkMoveUp,
  onBulkNewFolderWithSelection,
  onBulkDownload,
  onBulkDelete,
  onBulkShare,
  onBulkRename,
  onBulkDuplicate,
  canSplitVersions = false,
  onSplitVersions,
  canRegenerateThumbnail = false,
  onRegenerateThumbnail,
  canCreateTranscript = false,
  onCreateTranscript,
}: FolderContextMenuProps) {
  const hasSelection = bulkSelectionCount > 0
  // 1.1.0+: Share + Rename are single-target only — they don't make
  // sense across a multi-select.
  const singleTarget = bulkSelectionCount === 1
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
  const MENU_H = hasSelection ? 320 : 300
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
        w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left
        transition-colors whitespace-nowrap
        ${disabled || !onClick
          ? 'opacity-40 cursor-not-allowed text-white/40'
          : destructive
            ? 'hover:bg-destructive/15 text-destructive'
            : 'hover:bg-white/[0.08] text-white'}
      `}
    >
      <span
        className={`shrink-0 ${
          destructive ? 'text-destructive' : 'text-white/55'
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
      // 2.5.0+: matches the rest of the v2.5 dropdown chrome —
      // solid `#162533` fill (backdrop-filter glass doesn't
      // compose in this stacking context), white text + hairline
      // white/10 ring, soft outward shadow.
      className="fixed z-50 min-w-[240px] rounded-lg text-white ring-1 ring-white/10 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.65)] p-1 animate-in fade-in-0 slide-in-from-top-1 duration-100"
      style={{ left, top, backgroundColor: '#162533' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {hasSelection ? (
        // 1.1.0+: when there's an active selection (or the user right-
        // clicked a card, which auto-selects it), the context menu
        // shows ONLY the bulk actions. The Upload / New Folder block
        // is hidden — it's reserved for the empty-space right-click
        // gesture (no selection), where there's no obvious "item"
        // for those actions to target anyway.
        //
        // Section order (per user spec):
        //   1. Download, Share
        //   2. Duplicate, Rename
        //   3. Move up one folder, New Folder with selection
        //   4. Delete
        <>
          <Row
            icon={<Download className="w-4 h-4" />}
            label={
              singleTarget
                ? 'Download'
                : `Download ${bulkSelectionCount} items`
            }
            onClick={onBulkDownload}
          />
          {singleTarget && (
            <Row
              icon={<Share2 className="w-4 h-4" />}
              label="Share"
              onClick={onBulkShare}
            />
          )}
          <div className="my-1 h-px bg-white/10" role="separator" />
          <Row
            icon={<Copy className="w-4 h-4" />}
            label={
              singleTarget
                ? 'Duplicate'
                : `Duplicate ${bulkSelectionCount} items`
            }
            onClick={onBulkDuplicate}
          />
          {singleTarget && (
            <Row
              icon={<Pencil className="w-4 h-4" />}
              label="Rename"
              onClick={onBulkRename}
            />
          )}
          {singleTarget && canSplitVersions && (
            <Row
              icon={<Layers className="w-4 h-4" />}
              label="Split versions"
              onClick={onSplitVersions}
            />
          )}
          {singleTarget && canRegenerateThumbnail && (
            <Row
              icon={<RefreshCw className="w-4 h-4" />}
              label="Regenerate thumbnail"
              onClick={onRegenerateThumbnail}
            />
          )}
          {singleTarget && canCreateTranscript && (
            <Row
              icon={<FileText className="w-4 h-4" />}
              label="Create transcript"
              onClick={onCreateTranscript}
            />
          )}
          <div className="my-1 h-px bg-white/10" role="separator" />
          <Row
            icon={<ArrowUpFromLine className="w-4 h-4" />}
            label={
              singleTarget
                ? 'Move up one folder'
                : `Move ${bulkSelectionCount} up one folder`
            }
            onClick={canBulkMoveUp ? onBulkMoveUp : undefined}
            disabled={!canBulkMoveUp}
          />
          <Row
            icon={<FolderPlus className="w-4 h-4" />}
            label={
              singleTarget
                ? 'New Folder with selection'
                : `New Folder with ${bulkSelectionCount} items`
            }
            onClick={onBulkNewFolderWithSelection}
          />
          <div className="my-1 h-px bg-white/10" role="separator" />
          <Row
            icon={<Trash2 className="w-4 h-4" />}
            label={
              singleTarget
                ? 'Delete'
                : `Delete ${bulkSelectionCount} items`
            }
            onClick={onBulkDelete}
            destructive
          />
        </>
      ) : (
        <>
          <Row icon={<ArrowUp className="w-4 h-4" />} label="Upload Asset" onClick={onUploadAsset} />
          <Row icon={<FolderUp className="w-4 h-4" />} label="Upload Folder" onClick={onUploadFolder} />
          <div className="my-1 h-px bg-white/10" role="separator" />
          <Row icon={<FolderPlus className="w-4 h-4" />} label="New Folder" onClick={onNewFolder} />
          <Row
            icon={<FolderLock className="w-4 h-4" />}
            label="New Restricted Folder"
            onClick={onNewRestrictedFolder}
          />
          <div className="my-1 h-px bg-white/10" role="separator" />
          {/* 3.8.x: one-click folder-structure templates. */}
          <Row
            icon={<Smartphone className="w-4 h-4" />}
            label="UGC Template"
            onClick={onUgcTemplate}
          />
          <Row
            icon={<Youtube className="w-4 h-4" />}
            label="YT Template"
            onClick={onYtTemplate}
          />
        </>
      )}
    </div>
  )
}
