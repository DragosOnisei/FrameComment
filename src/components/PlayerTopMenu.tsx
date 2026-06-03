'use client'

import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  MoreVertical,
  Link2,
  Trash2,
  ClipboardCopy,
  ClipboardPaste,
  Check,
  Loader2,
  Download,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'
import { copyToClipboard } from '@/lib/clipboard'
import { getPublicShareOrigin } from '@/lib/public-share-origin'
import { hasClippedComments } from '@/lib/comments-clipboard'
import { ConfirmModal } from './ConfirmModal'
import { ShareModal } from './ShareModal'

/**
 * 1.3.2+: top-right "..." menu that lives on the admin share page only.
 * Consolidates the actions an admin actually reaches for while reviewing
 * a version into a single Frame.io-style popover so the title-bar stays
 * uncluttered. The previous standalone ThemeToggle moves in here as the
 * last entry, since theme is a low-frequency action and doesn't deserve
 * a permanent slot.
 *
 *   ┌──────────────┐
 *   │  ↗  Share link
 *   │  🗑  Delete this version
 *   │  ─────────────
 *   │  ⎘  Copy comments  (N)
 *   │  ⎘  Paste comments
 *   │  ─────────────
 *   │  ☾  Switch to dark / Switch to light
 *   └──────────────┘
 *
 * Cross-talk with CommentSection is done via custom window events so we
 * don't have to hoist the comment clipboard state up to the page level:
 *   - `commentClipboard:copy` ⇒ CommentSection runs its copy handler and
 *     fires `commentClipboard:result` with `{ kind: 'copied', count }`.
 *   - `commentClipboard:paste` ⇒ same shape, kind: 'pasted'.
 *   - On error the result event carries `{ kind: 'error', message }`.
 */
export interface PlayerTopMenuProps {
  /** Project id — used for video delete + comment-clipboard scoping. */
  projectId: string
  /** Project slug — used by `/api/share/url` to generate the public link. */
  projectSlug: string
  /** Active video version id — Delete and Copy/Paste both target this. */
  currentVideoId?: string | null
  /** Optional friendly label for the version (e.g. "v2") — shown in the
   *  Delete confirm dialog so the admin knows exactly which one they're
   *  about to nuke. */
  currentVersionLabel?: string | null
  /** Optional friendly label for the title (e.g. "IMG_5007"). */
  currentVideoName?: string | null
  /** 2.2.8+: folder the player was opened from. Forwarded to the
   *  `/api/share-video-link` server-side filter so the resulting URL
   *  scopes the public share to a single video, not the whole project. */
  currentFolderId?: string | null
  /** Total number of comments visible in the sidebar for the active
   *  video — drives whether "Copy comments" is enabled. */
  commentCount: number
  /** Called after a successful video delete so the page can refetch /
   *  navigate back to the project. */
  onVideoDeleted?: (videoId: string) => void
}

type Toast =
  | { kind: 'copied'; count: number }
  | { kind: 'pasted'; count: number }
  | { kind: 'link-copied' }
  | { kind: 'deleted' }
  | { kind: 'error'; message: string }

export default function PlayerTopMenu({
  projectId,
  projectSlug,
  currentVideoId,
  currentVersionLabel,
  currentVideoName,
  currentFolderId,
  commentCount,
  onVideoDeleted,
}: PlayerTopMenuProps) {
  const router = useRouter()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [busy, setBusy] = useState<null | 'share' | 'delete' | 'copy' | 'paste' | 'download'>(null)
  // 1.3.2+: viewport-anchored position for the portalled popover. We
  // render the popover at document.body level (escaping the toolbar's
  // backdrop-root so backdrop-blur actually samples the video pixels
  // behind it), and lay it out as `position: fixed` next to the kebab
  // trigger's bounding rect. Recomputed on open + on scroll/resize.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)

  // ── Track Copy/Paste clipboard locally so the menu can self-derive
  // whether "Paste comments" is enabled, without forcing the page to
  // bubble localStorage events. The clipboard helper already keys per
  // project, so we re-evaluate on storage events. Re-checks also run
  // on `commentClipboard:result` so a fresh Copy enables Paste in the
  // same tab immediately (storage events don't fire on the writer tab).
  const [hasClipboard, setHasClipboard] = useState(false)

  // 2.2.8+: ShareModal state for video-scoped share. Replaces the
  // pre-2.2.8 silent "copy project URL to clipboard" flow that
  // accidentally handed reviewers access to every other video in
  // the project. The new flow mirrors `FolderBrowser.handleShareVideo`:
  //   1) ask `/api/share-video-link` for an HMAC-signed URL filtered
  //      to this video name (+ folder when present)
  //   2) seed the modal with the project's current `shareExpiresAt`
  //      so the admin can adjust it inline
  //   3) `onSaveExpiration` PATCHes the project endpoint
  const [shareState, setShareState] = useState<{
    open: boolean
    title: string
    shareUrl: string
    initialExpiresAt: string | null
  }>({ open: false, title: '', shareUrl: '', initialExpiresAt: null })
  useEffect(() => {
    setHasClipboard(hasClippedComments(projectId))
    const recheck = () => setHasClipboard(hasClippedComments(projectId))
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('framecomment:clipboard:comments')) return
      recheck()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('commentClipboard:result', recheck as EventListener)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(
        'commentClipboard:result',
        recheck as EventListener,
      )
    }
  }, [projectId])

  // ── Close on outside click / Escape. With the popover portalled to
  // body it's no longer a DOM child of the trigger wrapper, so we have
  // to check BOTH refs before treating a click as "outside".
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (wrapperRef.current && wrapperRef.current.contains(target)) return
      if (popoverRef.current && popoverRef.current.contains(target)) return
      setOpen(false)
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

  // ── Compute / track the portal popover's anchor position.
  // We use the trigger's bounding rect as the source of truth and
  // recompute on scroll + resize so the popover stays glued to the
  // kebab even if the user scrolls underneath it (rare on this page
  // because the layout is locked to 100dvh, but cheap insurance).
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const el = wrapperRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setAnchor({
        // 4px gap below the trigger, matching the previous `mt-1`.
        top: rect.bottom + 4,
        // distance from the right edge of the viewport to the right
        // edge of the trigger — mirrors `right-0` relative to the
        // trigger but in fixed-positioning terms.
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open])

  // ── Auto-clear toast after a few seconds.
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(t)
  }, [toast])

  // ── Listen for results from CommentSection so we can surface a toast.
  useEffect(() => {
    const onResult = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      if (detail.kind === 'copied' && typeof detail.count === 'number') {
        setToast({ kind: 'copied', count: detail.count })
      } else if (detail.kind === 'pasted' && typeof detail.count === 'number') {
        setToast({ kind: 'pasted', count: detail.count })
      } else if (detail.kind === 'error') {
        setToast({
          kind: 'error',
          message: typeof detail.message === 'string' ? detail.message : 'Action failed',
        })
      }
      setBusy(null)
    }
    window.addEventListener('commentClipboard:result', onResult as EventListener)
    return () =>
      window.removeEventListener('commentClipboard:result', onResult as EventListener)
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────

  const handleShare = async () => {
    if (busy) return
    setOpen(false)
    setBusy('share')
    try {
      const videoName = currentVideoName?.trim()
      if (!videoName) {
        throw new Error('No video selected')
      }
      // 2.2.8+: SECURITY FIX. Pre-2.2.8 this called `/api/share/url`
      // which returns the WHOLE PROJECT share URL — copying it
      // straight to the clipboard handed reviewers access to every
      // other video in the project. Now we mirror the folder-browser
      // share flow:
      //   - `/api/share-video-link` mints an HMAC-signed URL the
      //     server enforces down to a single video name (and folder
      //     when present), so siblings stay invisible.
      //   - We seed `initialExpiresAt` from the project's current
      //     `shareExpiresAt` so the modal's expiration toggle starts
      //     in the right place.
      //   - The same `ShareModal` UX shows everywhere now (folder
      //     kebab, project kebab, player kebab) — popup with expiry
      //     row, no silent clipboard write.
      let initialExpiresAt: string | null = null
      try {
        const meta = await apiFetch(`/api/projects/${projectId}`)
        if (meta.ok) {
          const data = await meta.json()
          const raw =
            data?.project?.shareExpiresAt ?? data?.shareExpiresAt ?? null
          if (raw) {
            initialExpiresAt =
              typeof raw === 'string' ? raw : new Date(raw).toISOString()
          }
        }
      } catch {
        /* best-effort — fall back to "no expiration" UI */
      }

      let shareUrl: string | null = null
      try {
        const res = await apiFetch('/api/share-video-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            videoName,
            folderId: currentFolderId || undefined,
          }),
        })
        if (res.ok) {
          const data = (await res.json()) as { url?: string }
          if (data?.url) shareUrl = data.url
        }
      } catch {
        /* fall through to unsigned URL */
      }

      if (!shareUrl) {
        // Legacy fallback when SHARE_TOKEN_SECRET isn't configured
        // — better to share an unsigned per-video URL than the full
        // project link the pre-2.2.8 code used. Mirrors the fallback
        // in FolderBrowser.handleShareVideo.
        const origin = getPublicShareOrigin()
        const params = new URLSearchParams({ video: videoName })
        if (currentFolderId) params.set('folderId', currentFolderId)
        shareUrl = `${origin}/share/${projectSlug}?${params.toString()}`
      }

      setShareState({
        open: true,
        title: videoName,
        shareUrl,
        initialExpiresAt,
      })
      // 2.2.8+: the modal auto-copies the URL on open, so we don't
      // race-copy from here. The Copy button inside the modal is the
      // one source of truth.
    } catch (err) {
      setToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to share video',
      })
    } finally {
      setBusy(null)
    }
  }
  // Silence eslint when the project share URL helper isn't reached.
  // `projectSlug` and `copyToClipboard` are still referenced in the
  // legacy fallback path above, so this is a no-op marker for the
  // linter; do not remove.
  void projectSlug
  void copyToClipboard

  // 1.7.0+: download the active version's original file. Same
  // pattern as the search overlay's Download button — mint a one-
  // shot signed token then open the URL in a new tab. Admins skip
  // the project-level "allowAssetDownload" gate (we trust them).
  const handleDownload = async () => {
    if (busy) return
    if (!currentVideoId) {
      setToast({ kind: 'error', message: 'No video selected' })
      return
    }
    setOpen(false)
    setBusy('download')
    try {
      const res = await apiFetch(`/api/videos/${currentVideoId}/download-token`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { url?: string }
      if (!data.url) throw new Error('No download URL returned')
      window.open(data.url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to download',
      })
    } finally {
      setBusy(null)
    }
  }

  // 1.4.x: themed ConfirmModal state for the Delete action. Replaces
  // the old `window.confirm()` (the OS-native gray "localhost:3000
  // says…" prompt on Mac, and the equally ugly Safari sheet on
  // mobile) with the same Frame.io-style modal we use on the project
  // dashboard. Two-step flow: clicking "Delete v1" in the kebab opens
  // the modal; clicking the modal's Delete button calls
  // `performDelete()` which does the actual API call.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const handleDelete = () => {
    if (busy) return
    if (!currentVideoId) {
      setToast({ kind: 'error', message: 'No video selected' })
      return
    }
    setOpen(false)
    setConfirmDeleteOpen(true)
  }
  const performDelete = async () => {
    if (!currentVideoId) return
    setBusy('delete')
    try {
      const res = await apiFetch(`/api/videos/${currentVideoId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const body = await res.json()
          if (body?.error) msg = body.error
        } catch {
          /* ignore parse errors */
        }
        throw new Error(msg)
      }
      setConfirmDeleteOpen(false)
      setToast({ kind: 'deleted' })
      if (onVideoDeleted) {
        onVideoDeleted(currentVideoId)
      } else {
        // Reasonable fallback — bounce back to the project page so the
        // admin doesn't sit on a player whose video no longer exists.
        router.refresh()
      }
    } catch (err) {
      setToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete',
      })
    } finally {
      setBusy(null)
    }
  }

  const handleCopyComments = () => {
    if (busy) return
    setOpen(false)
    setBusy('copy')
    // CommentSection owns the state — fire an event and wait for the
    // matching `commentClipboard:result` to land. If nothing comes back
    // in 3s we clear the busy flag so the menu doesn't stay disabled.
    window.dispatchEvent(new CustomEvent('commentClipboard:copy'))
    window.setTimeout(() => setBusy((b) => (b === 'copy' ? null : b)), 3000)
  }

  const handlePasteComments = () => {
    if (busy) return
    setOpen(false)
    setBusy('paste')
    window.dispatchEvent(new CustomEvent('commentClipboard:paste'))
    window.setTimeout(() => setBusy((b) => (b === 'paste' ? null : b)), 5000)
  }

  // ── Rendering ───────────────────────────────────────────────────────

  const canCopy = commentCount > 0 && !busy
  const canPaste = hasClipboard && !!currentVideoId && !busy
  const canDelete = !!currentVideoId && !busy

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`
          inline-flex items-center justify-center
          p-2 rounded-lg border border-border bg-background
          hover:bg-accent transition-colors shadow-sm
          ${open ? 'bg-accent' : ''}
        `}
        title="More actions"
        aria-label="More actions"
      >
        {busy ? (
          <Loader2 className="h-5 w-5 text-foreground animate-spin" />
        ) : (
          <MoreVertical className="h-5 w-5 text-foreground" />
        )}
      </button>

      {/* Inline toast — small pill anchored to the left of the trigger,
          auto-dismisses. Identical pattern to CommentsKebabMenu so the
          two feel consistent. */}
      {toast && (
        <span
          role="status"
          className={`
            absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap
            inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
            ${toast.kind === 'error'
              ? 'bg-destructive/15 text-destructive'
              : 'bg-emerald-500/15 text-emerald-500'}
          `}
        >
          {toast.kind !== 'error' && <Check className="w-3 h-3" />}
          {toast.kind === 'copied' && `Copied ${toast.count}`}
          {toast.kind === 'pasted' && `Pasted ${toast.count}`}
          {toast.kind === 'link-copied' && 'Link copied'}
          {toast.kind === 'deleted' && 'Deleted'}
          {toast.kind === 'error' && toast.message}
        </span>
      )}

      {open && anchor && typeof document !== 'undefined' &&
        createPortal(
        <div
          role="menu"
          ref={popoverRef}
          // 1.3.2+: portalled to document.body. The parent ThumbnailReel
          // toolbar already has `backdrop-blur-sm`, which on iOS Safari
          // creates a "backdrop root" that prevents any descendant's
          // backdrop-filter from sampling pixels behind the toolbar —
          // result: blur silently no-ops. Rendering at body level
          // escapes that root so the filter actually reaches the video.
          // The viewport-anchored `position: fixed` keeps the popover
          // glued to the kebab trigger's bottom-right corner.
          className="
            fixed z-[100] min-w-[260px]
            text-popover-foreground
            ring-1 ring-border shadow-[0_8px_30px_rgba(0,0,0,0.55)]
            rounded-xl p-1
            animate-in fade-in-0 slide-in-from-top-1 duration-150
          "
          style={{
            top: anchor.top,
            right: anchor.right,
            backgroundColor: 'hsl(var(--card) / 0.65)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          }}
        >
          {/* ─── Share / Delete (page-level video actions).
                1.3.2+: `whitespace-nowrap` on every label so the popup
                never wraps a single action across two lines — the
                outer min-w grows to fit instead. ─── */}
          <button
            role="menuitem"
            type="button"
            onClick={handleShare}
            disabled={!!busy}
            className="
              w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm
              hover:bg-muted transition-colors text-left whitespace-nowrap
              disabled:opacity-40 disabled:cursor-not-allowed
            "
          >
            <Link2 className="w-4 h-4 shrink-0" />
            <span className="flex-1 whitespace-nowrap">Share Video</span>
          </button>
          {/* 1.7.0+: download the active version's original file.
              Disabled while a request is in flight; the spinner
              swaps in so the user knows the click registered. */}
          <button
            role="menuitem"
            type="button"
            onClick={handleDownload}
            disabled={!currentVideoId || busy === 'download'}
            className="
              w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm
              hover:bg-muted transition-colors text-left whitespace-nowrap
              disabled:opacity-40 disabled:cursor-not-allowed
            "
          >
            {busy === 'download' ? (
              <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
            ) : (
              <Download className="w-4 h-4 shrink-0" />
            )}
            <span className="flex-1 whitespace-nowrap">Download</span>
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={handleDelete}
            disabled={!canDelete}
            className={`
              w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm
              transition-colors text-left whitespace-nowrap
              ${canDelete
                ? 'hover:bg-destructive/10 text-destructive'
                : 'opacity-40 cursor-not-allowed'}
            `}
          >
            <Trash2 className="w-4 h-4 shrink-0" />
            {/* 1.7.0+: the version label was dropped from the
                button copy. It lives in the title bar already and
                the confirm dialog still spells it out explicitly,
                so "Delete" on its own keeps the menu clean. */}
            <span className="flex-1 whitespace-nowrap">Delete</span>
          </button>

          {/* 1.7.0+: theme toggle was removed from this kebab —
              the global AdminHeader already exposes Light/Dark in
              the right cluster, so duplicating it here just made
              the menu longer. Comment Copy/Paste also lives in
              the "All comments" kebab below the video. */}
        </div>,
        document.body,
      )}
      {/* 1.4.x: themed Delete confirmation. Same ConfirmModal used on
          the project dashboard, so the admin sees one consistent
          delete UX everywhere instead of the OS-native gray prompt
          that used to fire from `window.confirm()`. */}
      <ConfirmModal
        open={confirmDeleteOpen}
        onOpenChange={(next) => { if (!busy) setConfirmDeleteOpen(next) }}
        variant="destructive"
        title={
          [currentVideoName, currentVersionLabel].filter(Boolean).length > 0
            ? `Delete "${[currentVideoName, currentVersionLabel].filter(Boolean).join(' · ')}"?`
            : 'Delete this video version?'
        }
        description="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        busy={busy === 'delete'}
        onConfirm={performDelete}
      />
      {/* 2.2.8+: per-video ShareModal — same component the folder
          browser uses for its kebab share. Mounts here so the modal
          renders above the player chrome. */}
      <ShareModal
        open={shareState.open}
        onOpenChange={(next) =>
          setShareState((s) => ({ ...s, open: next }))
        }
        title={shareState.title}
        shareUrl={shareState.shareUrl}
        initialExpiresAt={shareState.initialExpiresAt}
        onSaveExpiration={async (next) => {
          try {
            const res = await apiFetch(`/api/projects/${projectId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ shareExpiresAt: next }),
            })
            if (!res.ok) {
              const err = await res.json().catch(() => ({}))
              setToast({
                kind: 'error',
                message: err.error || 'Failed to save expiration',
              })
            }
          } catch (err) {
            setToast({
              kind: 'error',
              message:
                err instanceof Error ? err.message : 'Failed to save expiration',
            })
          }
        }}
      />
    </div>
  )
}
