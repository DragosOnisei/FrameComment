'use client'

import { useEffect, useRef } from 'react'
import { ArrowUp, FolderUp, FolderPlus, FolderLock } from 'lucide-react'

/**
 * Frame.io-style right-click context menu that pops up over the
 * folder browser background. Wires four actions:
 *
 *  - Upload Asset           → trigger the existing video upload flow
 *  - Upload Folder          → multi-file upload (stub for 1.0.6)
 *  - New Folder             → public folder (authMode = NONE)
 *  - New Restricted Folder  → password-gated folder (authMode = PASSWORD)
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
}: FolderContextMenuProps) {
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

  // Clamp coordinates so the menu doesn't go off-screen. We assume
  // the menu is roughly 220×220 (4 items × ~40px + padding + divider).
  const MENU_W = 230
  const MENU_H = 220
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 768
  const left = Math.min(x, Math.max(8, viewportW - MENU_W - 8))
  const top = Math.min(y, Math.max(8, viewportH - MENU_H - 8))

  const Row = ({
    icon,
    label,
    onClick,
    disabled,
  }: {
    icon: React.ReactNode
    label: string
    onClick?: () => void
    disabled?: boolean
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
        transition-colors
        ${disabled || !onClick
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-muted text-foreground'}
      `}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[220px] rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-2xl p-1 animate-in fade-in-0 slide-in-from-top-1 duration-100"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
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
