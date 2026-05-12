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
  onMutated?: () => void
}

export default function ProjectCardKebab({
  projectId,
  projectSlug,
  projectTitle,
  projectStatus,
  onMutated,
}: ProjectCardKebabProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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

  const handleArchive = async (e: React.MouseEvent) => {
    stop(e)
    if (busy) return
    const confirmMsg = isArchived
      ? `Unarchive "${projectTitle}"?`
      : `Archive "${projectTitle}"? It will be moved out of the active list.`
    if (!window.confirm(confirmMsg)) return
    setBusy(true)
    try {
      await apiPatch(`/api/projects/${projectId}`, {
        status: isArchived ? 'IN_REVIEW' : 'ARCHIVED',
      })
      setOpen(false)
      onMutated?.()
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update project')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    stop(e)
    if (busy) return
    if (
      !window.confirm(
        `Delete project "${projectTitle}"? This is permanent — all folders, videos, and comments are removed.`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await apiDelete(`/api/projects/${projectId}`)
      setOpen(false)
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
        type="button"
        onClick={(e) => {
          stop(e)
          setOpen((v) => !v)
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
          className="absolute right-0 top-full mt-1 z-30 min-w-[200px] rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-2xl p-1"
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
            onClick={handleArchive}
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
            onClick={handleDelete}
            disabled={busy}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-destructive/10 text-destructive text-left disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4 shrink-0" />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
