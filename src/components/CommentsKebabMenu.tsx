'use client'

import { useEffect, useRef, useState } from 'react'
import { MoreVertical, ClipboardCopy, ClipboardPaste, Check } from 'lucide-react'

/**
 * Three-dot menu that lives in the top-right of the comments sidebar
 * header. Houses workflow actions that don't fit on a per-comment row —
 * starting with **copy / paste comments between versions**, which is
 * the same pattern Frame.io uses for review sessions.
 *
 * The clipboard is client-side only (localStorage, scoped per project),
 * so it survives a page reload but doesn't leak across browsers. We
 * deliberately avoid a server-side clipboard for now: a single-user
 * review session is the dominant use-case, and the simplicity is
 * worth the trade-off.
 */
export interface CommentsKebabMenuProps {
  /** Total number of comments shown in the sidebar — drives whether
   *  Copy is enabled (nothing to copy → disabled).            */
  commentCount: number
  /** Callback fired when the user clicks "Copy comments". The host is
   *  responsible for serialising whatever subset they consider current
   *  (e.g. just the active video's comments) into the clipboard. */
  onCopy: () => Promise<{ count: number } | void> | { count: number } | void
  /** Callback fired when the user clicks "Paste comments". The host
   *  reads the clipboard, POSTs each entry against the current video
   *  and tells us how many it created so we can show feedback. */
  onPaste: () => Promise<{ count: number } | void> | { count: number } | void
  /** True iff the localStorage clipboard has anything to paste. The
   *  host computes this and re-renders us when it changes. */
  hasClipboard: boolean
}

export default function CommentsKebabMenu({
  commentCount,
  onCopy,
  onPaste,
  hasClipboard,
}: CommentsKebabMenuProps) {
  const [open, setOpen] = useState(false)
  const [recentAction, setRecentAction] = useState<
    | { kind: 'copied'; count: number }
    | { kind: 'pasted'; count: number }
    | { kind: 'error'; message: string }
    | null
  >(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape, identical pattern to
  // PlaybackSpeedMenu so the two feel the same.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
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

  // Auto-clear the inline toast after a few seconds so it doesn't
  // linger forever next to the menu.
  useEffect(() => {
    if (!recentAction) return
    const t = window.setTimeout(() => setRecentAction(null), 2400)
    return () => window.clearTimeout(t)
  }, [recentAction])

  const runCopy = async () => {
    setOpen(false)
    try {
      const r = await onCopy()
      if (r && typeof r === 'object' && 'count' in r) {
        setRecentAction({ kind: 'copied', count: r.count })
      }
    } catch (err) {
      setRecentAction({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Copy failed',
      })
    }
  }

  const runPaste = async () => {
    setOpen(false)
    try {
      const r = await onPaste()
      if (r && typeof r === 'object' && 'count' in r) {
        setRecentAction({ kind: 'pasted', count: r.count })
      }
    } catch (err) {
      setRecentAction({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Paste failed',
      })
    }
  }

  const canCopy = commentCount > 0
  const canPaste = hasClipboard

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`
          inline-flex items-center justify-center
          w-8 h-8 rounded-md
          text-muted-foreground hover:text-foreground hover:bg-muted/60
          transition-colors
          ${open ? 'bg-muted/60 text-foreground' : ''}
        `}
        title="More actions"
        aria-label="More actions"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {/* Inline status pill — small, next to the trigger, auto-dismisses */}
      {recentAction && (
        <span
          role="status"
          className={`
            absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap
            inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
            ${recentAction.kind === 'error'
              ? 'bg-destructive/15 text-destructive'
              : 'bg-success/15 text-success'}
          `}
        >
          {recentAction.kind !== 'error' && <Check className="w-3 h-3" />}
          {recentAction.kind === 'copied' && `Copied ${recentAction.count}`}
          {recentAction.kind === 'pasted' && `Pasted ${recentAction.count}`}
          {recentAction.kind === 'error' && recentAction.message}
        </span>
      )}

      {open && (
        <div
          role="menu"
          className="
            absolute top-full right-0 mt-1 z-50 min-w-[200px]
            bg-popover text-popover-foreground
            ring-1 ring-border shadow-2xl
            rounded-lg p-1
            animate-in fade-in-0 slide-in-from-top-1 duration-150
          "
        >
          <button
            role="menuitem"
            type="button"
            onClick={runCopy}
            disabled={!canCopy}
            className={`
              w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm
              transition-colors text-left
              ${canCopy ? 'hover:bg-muted' : 'opacity-40 cursor-not-allowed'}
            `}
          >
            <ClipboardCopy className="w-4 h-4 shrink-0" />
            <span className="flex-1">Copy comments</span>
            {commentCount > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {commentCount}
              </span>
            )}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={runPaste}
            disabled={!canPaste}
            className={`
              w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm
              transition-colors text-left
              ${canPaste ? 'hover:bg-muted' : 'opacity-40 cursor-not-allowed'}
            `}
          >
            <ClipboardPaste className="w-4 h-4 shrink-0" />
            <span className="flex-1">Paste comments</span>
          </button>
        </div>
      )}
    </div>
  )
}
