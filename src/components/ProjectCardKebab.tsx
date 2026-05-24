'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  MoreVertical,
  Settings,
  BarChart3,
  Copy,
  Archive,
  ArchiveRestore,
  Trash2,
  Check,
} from 'lucide-react'
import { apiFetch, apiPatch, apiDelete } from '@/lib/api-client'
import { logError } from '@/lib/logging'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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
  const [copied, setCopied] = useState(false)
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

  const handleCopyLink = async (e: React.MouseEvent) => {
    stop(e)
    try {
      const res = await apiFetch(`/api/share/url?slug=${projectSlug}`)
      const data = res.ok ? await res.json() : null
      const url =
        data?.shareUrl ||
        `${window.location.origin}/share/${projectSlug}`
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      logError('[ProjectCardKebab] copy link failed:', err)
    }
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
          <button
            role="menuitem"
            type="button"
            onClick={goto(`/admin/projects/${projectId}/settings`)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
          >
            <Settings className="w-4 h-4 shrink-0" />
            Settings
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={goto(`/admin/projects/${projectId}/analytics`)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
          >
            <BarChart3 className="w-4 h-4 shrink-0" />
            View Analytics
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={handleCopyLink}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left"
          >
            {copied ? (
              <Check className="w-4 h-4 shrink-0 text-success" />
            ) : (
              <Copy className="w-4 h-4 shrink-0" />
            )}
            {copied ? 'Link copied' : 'Copy share link'}
          </button>
          <div className="my-1 h-px bg-border/50" role="separator" />
          <button
            role="menuitem"
            type="button"
            onClick={openArchiveConfirm}
            disabled={busy}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-muted text-left disabled:opacity-50"
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

      {/* 1.2.0+: pretty confirm dialogs replace the native browser
          confirm() box for these two destructive actions. */}
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={isArchived ? `Unarchive "${projectTitle}"?` : `Archive "${projectTitle}"?`}
        description={
          isArchived
            ? 'It will return to your active list of projects.'
            : 'It will be moved out of the active list. You can restore it any time from the archive.'
        }
        confirmLabel={isArchived ? 'Unarchive' : 'Archive'}
        cancelLabel="Cancel"
        onConfirm={runArchive}
      />
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
    </div>
  )
}
