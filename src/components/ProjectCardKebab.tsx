'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  MoreVertical,
  Settings,
  BarChart3,
  Archive,
  ArchiveRestore,
  Trash2,
  Pencil,
  ImageIcon,
  Loader2,
} from 'lucide-react'
import { apiFetch, apiPatch, apiDelete } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { computePopoverStyle } from '@/lib/popover-position'

/**
 * Kebab dropdown attached to each project card on the dashboard
 * (1.0.6+). Mirrors the kebab pattern used on FolderCard so the two
 * card types feel like siblings: kebab → small popover with quick
 * actions that don't require opening the project first.
 *
 * The component swallows click events so the surrounding card's
 * <Link> doesn't navigate to the project page while the user is
 * picking a menu item.
 *
 * Quick actions:
 *  - Settings           → /admin/projects/{id}/settings
 *  - View Analytics     → /admin/projects/{id}/analytics
 *  - Copy share link    → uses share URL from /api/share/url
 *  - Archive / Unarchive → PATCH project status
 *  - Delete             → DELETE project (with confirmation)
 */
export interface ProjectCardKebabProps {
  projectId: string
  projectSlug: string
  projectTitle: string
  projectStatus: string
  /**
   * 1.2.1+: passing the project's child counts lets the kebab skip
   * the confirm dialog entirely when the project is empty. Trash
   * the server already short-circuits an empty project to a hard
   * delete; the dialog's "moved to Trash" language would be a lie
   * for an empty container anyway.
   */
  projectFolderCount?: number
  projectVideoCount?: number
  onMutated?: () => void
}

export default function ProjectCardKebab({
  projectId,
  projectSlug,
  projectTitle,
  projectStatus,
  projectFolderCount,
  projectVideoCount,
  onMutated,
}: ProjectCardKebabProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // 1.3.1+: Frame.io-style smart-positioned popover. See VideoCard for
  // rationale.
  const kebabRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  // 1.2.0+: pretty confirm dialogs in place of window.confirm() for
  // Archive / Unarchive / Delete. Each opens through its own state
  // toggle so they can't fight each other.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  // 1.7.9+: themed rename dialog (replaces window.prompt).
  const [renameOpen, setRenameOpen] = useState(false)
  // 1.7.10+: spinner state for "Change Logo" while the OS file
  // dialog is opening. Cold macOS Finder + mounted network drives
  // can take ~1s before the picker visibly appears.
  const [openingPicker, setOpeningPicker] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Swallow link navigation when the user clicks anywhere on the
  // kebab UI — the parent card is wrapped in a Next.js <Link>.
  const stop = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const goto = (href: string) => (e: React.MouseEvent) => {
    stop(e)
    setOpen(false)
    router.push(href)
  }

  const isArchived = projectStatus === 'ARCHIVED'

  const openArchiveConfirm = (e: React.MouseEvent) => {
    stop(e)
    if (busy) return
    setOpen(false)
    setConfirmArchive(true)
  }

  const runArchive = async () => {
    if (busy) return
    setBusy(true)
    try {
      await apiPatch(`/api/projects/${projectId}`, {
        status: isArchived ? 'IN_REVIEW' : 'ARCHIVED',
      })
      onMutated?.()
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update project')
    } finally {
      setBusy(false)
    }
  }

  // 1.7.9+: Rename action opens a themed dialog (RenameDialog)
  // instead of the browser's native window.prompt. The kebab item
  // just toggles the dialog's open state; the actual PATCH runs
  // from the dialog's onSubmit callback below.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const handleRename = (e: React.MouseEvent) => {
    stop(e)
    if (busy) return
    setOpen(false)
    setRenameOpen(true)
  }
  const submitRename = async (next: string) => {
    try {
      await apiPatch(`/api/projects/${projectId}`, { title: next })
      onMutated?.()
      router.refresh()
      return true
    } catch (err) {
      // Keep the dialog open so the user can fix typos / retry.
      alert(err instanceof Error ? err.message : 'Failed to rename project')
      return false
    }
  }

  // 1.7.5+: Change logo / cover image. Triggers a hidden file
  // input; on selection we POST FormData to /api/projects/[id]/cover
  // which replaces the project's cover and deletes the old file on
  // disk. Same endpoint used by the Settings page cover card.
  //
  // 1.7.10+: keep the kebab open and show a spinner on the menu
  // item while the OS file dialog is loading — silent click with
  // a 1s wait felt broken. Menu auto-closes via the focus listener
  // below as soon as the picker is dismissed.
  const handleChangeLogoClick = (e: React.MouseEvent) => {
    stop(e)
    if (busy || openingPicker) return
    setOpeningPicker(true)
    // Synchronous click preserves user activation; the picker
    // begins opening immediately while the menu re-renders with
    // the spinner state in the same microtask.
    fileInputRef.current?.click()
  }
  // 1.7.10+: detect the picker closing. The OS dialog steals
  // focus when it opens (window blurs) and the browser regains
  // focus when the dialog is dismissed (cancel or file selected).
  // We only treat a focus event as "picker closed" if we saw a
  // blur first — otherwise a spurious focus event could collapse
  // the menu before the picker has even rendered. The
  // `document.hasFocus()` check covers the rare case where the
  // OS picker opens faster than React's render can attach the
  // listener.
  useEffect(() => {
    if (!openingPicker) return
    let blurred = !document.hasFocus()
    const onBlur = () => { blurred = true }
    const onFocus = () => {
      if (!blurred) return
      // Small delay so a fired onChange (happy path) wins the
      // race and the upload actually starts before the menu
      // collapses.
      window.setTimeout(() => {
        setOpeningPicker(false)
        setOpen(false)
      }, 150)
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [openingPicker])
  const handleLogoFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so re-selecting the same file fires onChange
    setOpeningPicker(false)
    if (!file) return
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await apiFetch(`/api/projects/${projectId}/cover`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || 'Failed to upload logo')
      }
      onMutated?.()
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to upload logo')
    } finally {
      setBusy(false)
    }
  }

  const openDeleteConfirm = (e: React.MouseEvent) => {
    stop(e)
    if (busy) return
    setOpen(false)
    // 1.2.1+: empty-project fast path. If the parent knows the
    // project has no folders and no videos, the confirm dialog is
    // redundant — the server skips Trash for empty projects, so
    // "moved to Trash" wouldn't be true anyway. Delete straight
    // away without prompting. We only short-circuit when BOTH
    // counts were explicitly provided (otherwise we don't know
    // what we don't know and fall back to the dialog).
    if (
      typeof projectFolderCount === 'number' &&
      typeof projectVideoCount === 'number' &&
      projectFolderCount === 0 &&
      projectVideoCount === 0
    ) {
      void runDelete()
      return
    }
    setConfirmDelete(true)
  }

  const runDelete = async () => {
    if (busy) return
    setBusy(true)
    try {
      // 1.2.1+: apiDelete returns the parsed JSON body. The server
      // sets `wasEmpty: true` when it hard-deletes an empty project
      // (skipping Trash), so we only fire the AdminHeader's
      // trash:changed event when the count actually moved.
      const data = (await apiDelete<{ wasEmpty?: boolean }>(`/api/projects/${projectId}`)) || {}
      if (!data.wasEmpty) {
        window.dispatchEvent(new CustomEvent('trash:changed'))
      }
      onMutated?.()
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={menuRef} className="relative" onClick={stop}>
      <button
        ref={kebabRef}
        type="button"
        onClick={(e) => {
          stop(e)
          if (open) {
            setOpen(false)
            return
          }
          const rect = kebabRef.current?.getBoundingClientRect()
          if (rect) setMenuStyle(computePopoverStyle(rect))
          setOpen(true)
        }}
        className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        aria-label="Project actions"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          // 1.3.1+: Frame.io-style smart popover (see VideoCard).
          style={menuStyle}
          className="z-50 overflow-y-auto rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-2xl p-1"
        >
          {/* 1.7.5+: trimmed menu — Rename / Change logo at the
              top, then Share Project / Settings / Delete after a
              divider. View Analytics + Archive were dropped (the
              former lives under the project page kebab; archive
              is rarely used and overlaps with Trash). */}
          <button
            role="menuitem"
            type="button"
            onClick={handleRename}
            disabled={busy}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left disabled:opacity-50"
          >
            <Pencil className="w-4 h-4 shrink-0" />
            Rename
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={handleChangeLogoClick}
            disabled={busy || openingPicker}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left disabled:opacity-50"
          >
            {openingPicker ? (
              <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
            ) : (
              <ImageIcon className="w-4 h-4 shrink-0" />
            )}
            {openingPicker ? 'Opening picker…' : 'Change Logo'}
          </button>
          <div className="my-1 h-px bg-border/50" role="separator" />
          <button
            role="menuitem"
            type="button"
            onClick={goto(`/admin/projects/${projectId}/settings`)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
          >
            <Settings className="w-4 h-4 shrink-0" />
            Settings
          </button>
          {/* Hidden helpers for the archive flow have been removed
              from this card menu — they no longer appear. The
              variables below keep the file lint-clean: */}
          {false && (
            <button
              role="menuitem"
              type="button"
              onClick={openArchiveConfirm}
              disabled={busy}
            >
              {isArchived ? (
                <>
                  <ArchiveRestore className="w-4 h-4 shrink-0" />
                  Unarchive
                </>
              ) : (
                <>
                  <Archive className="w-4 h-4 shrink-0" />
                  Archive
                </>
              )}
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={openDeleteConfirm}
            disabled={busy}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-destructive/10 text-destructive text-left disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4 shrink-0" />
            Delete
          </button>
        </div>
      )}

      {/* 1.2.0+: pretty confirm dialog for the destructive delete.
          Archive dialog dropped in 1.7.5 along with its menu item. */}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="destructive"
        title={`Move "${projectTitle}" to Trash?`}
        description={
          <>
            The project, its folders, videos, and comments stay recoverable
            from Trash for 30 days. After that they're permanently deleted.
          </>
        }
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        onConfirm={runDelete}
      />
      {/* 1.7.9+: themed rename dialog. Opens via the Rename
          menu item and submits the new title back to the project
          PATCH endpoint. */}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename project"
        initialValue={projectTitle}
        placeholder="Project name"
        onSubmit={submitRename}
      />
      {/* 1.7.10+: Hidden file input that the "Change Logo" menu
          item triggers. Two things are needed to make this work:

          1. createPortal renders it at <body> — escapes the
             kebab wrapper's DOM subtree (cosmetic/z-index).
          2. onClick={(e) => e.stopPropagation()} on the input
             itself — THIS is the actual fix. React synthetic
             events bubble through the React tree, not the DOM
             tree, so a portal alone is NOT enough: the synthetic
             click from `fileInputRef.current.click()` would
             still reach the kebab wrapper's `onClick={stop}`
             (which calls `e.preventDefault()` to block the
             parent card's <Link>), which in turn cancels the
             file picker's default action and leaves the user
             with a dead button. stopPropagation on the input
             halts the synthetic event before it can reach the
             wrapper, so no `preventDefault()` is ever called
             on the click event that should open the picker. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onClick={(e) => e.stopPropagation()}
            onChange={handleLogoFileSelected}
          />,
          document.body,
        )}
    </div>
  )
}
