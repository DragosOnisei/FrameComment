'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import {
  Trash2,
  Brush,
  Pencil,
  Check,
  Copy,
  X,
  MoreHorizontal,
} from 'lucide-react'
import DOMPurify from 'isomorphic-dompurify'
import { cn } from '@/lib/utils'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import CommentAttachments from './CommentAttachments'
import { useOptionalAnnotation } from '@/contexts/AnnotationContext'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

// 1.2.0+: shape of the per-emoji reaction groups returned by sanitizeComment.
type ReactionGroup = {
  emoji: string
  count: number
  mine: boolean
  reactors: { id: string; authorName: string | null; createdAt: string | Date }[]
}

interface MessageBubbleProps {
  comment: CommentWithReplies
  isReply: boolean
  /**
   * 6.15.2: takes an optional name to address. Clicking Reply on a REPLY
   * routes here too — the thread stays one level deep (that is deliberate:
   * nested trees turn a review into a forum), so the new reply attaches to
   * the same root comment and simply opens with "@Name " already typed.
   */
  onReply?: (mentionName?: string | null) => void
  onSeekToTimecode?: (
    timecode: string,
    videoId: string,
    videoVersion: number | null,
    /** Sub-second precision capture moment in milliseconds. Takes priority
     *  over `timecode` for the actual seek when provided (1.0.3+). */
    timestampMs?: number | null
  ) => void
  onDelete?: () => void
  /**
   * 7.1.0: hand this one thread to the project paste clipboard.
   *
   * The sidebar kebab copies EVERY comment on the video, which is the wrong
   * granularity when a single note applies to the other cuts in the folder and
   * the rest do not. Copy here now does both jobs: the plain text still goes to
   * the system clipboard (for an email or a chat message, which is what it was
   * always for) and the thread also becomes the thing Paste will write.
   *
   * The host owns the conversion and the storage key, so this is a callback
   * rather than a direct write.
   */
  onCopyForPaste?: (comment: CommentWithReplies) => void
  /**
   * 7.3.0: multi-select.
   *
   * The avatar sits top-left of every bubble; this puts a hollow circle
   * bottom-left, in the row that already holds Reply. Selecting several threads
   * and right-clicking them is how you copy, resolve or delete a batch — the
   * alternative was doing it one comment at a time down a list of twenty.
   *
   * Replies are not selectable. A batch of answers detached from their questions
   * is not a thing anyone wants to copy, and deleting a reply out from under a
   * thread is what the per-reply control is for.
   */
  selectable?: boolean
  isSelected?: boolean
  onToggleSelect?: () => void
  /**
   * 7.3.0: clicking the bubble itself selects it, so the tick is a target you
   * can hit rather than the only one. Modifiers are forwarded because the
   * parent owns the range anchor: Shift extends, ⌘/Ctrl toggles — the same
   * three gestures the folder browser uses on videos.
   */
  onSelectFromClick?: (mods: { shift: boolean; toggle: boolean }) => void
  /** Called when the user saves an edited version of this comment */
  onEdit?: (newContent: string) => Promise<void> | void
  /** Called when the user saves an edited reply (only used in main bubble) */
  onEditReply?: (replyId: string, newContent: string) => Promise<void> | void
  /** Whether the current viewer is allowed to edit this comment */
  canEdit?: boolean
  /** Per-reply edit permission (mirrors `canEdit` for the main comment) */
  canEditReply?: (reply: Comment) => boolean
  formatMessageTime: (date: Date) => string
  commentsDisabled: boolean
  sequenceNumber?: number
  replies?: Comment[]
  onDeleteReply?: (replyId: string) => void
  timestampLabel?: string | null
  timecodeEndLabel?: string | null
  hasAnnotation?: boolean
  shareToken?: string | null
  /**
   * 1.2.0+: Frame.io-style "Mark as done". Toggling flips `isResolved` on
   * the server. Returns the updated comment so the parent can splice it
   * into its cache without a full refetch.
   */
  onResolveToggle?: (commentId: string, nextResolved: boolean) => Promise<void> | void
  /**
   * 1.2.0+: emoji reaction toggle. Same emoji from the same viewer twice
   * removes their reaction (toggle semantics handled server-side).
   */
  onReact?: (commentId: string, emoji: string) => Promise<void> | void
  /**
   * 1.3.2+: when the user is currently replying to THIS comment the
   * parent passes its `<CommentInput>` here so we can render it
   * directly under the bubble's action row — Frame.io style.
   */
  inlineReplyInput?: React.ReactNode
}

/**
 * Sanitize HTML content for display
 * Defense in depth: Even though content is sanitized on backend,
 * we sanitize again on frontend for extra security
 */
function sanitizeContent(content: string): string {
  return DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i, // Only allow https://, http://, mailto: URLs
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['rel'], // Add rel="noopener noreferrer" to all links for security
    FORCE_BODY: true, // Parse content as body to prevent context-breaking attacks
  })
}

export default function MessageBubble({
  comment,
  isReply,
  onReply,
  onSeekToTimecode,
  onDelete,
  onCopyForPaste,
  selectable,
  isSelected,
  onToggleSelect,
  onSelectFromClick,
  onEdit,
  onEditReply,
  canEdit,
  canEditReply,
  formatMessageTime,
  commentsDisabled,
  sequenceNumber,
  replies,
  onDeleteReply,
  timestampLabel,
  timecodeEndLabel,
  hasAnnotation,
  shareToken,
  onResolveToggle,
  onReact,
  inlineReplyInput,
}: MessageBubbleProps) {
  const t = useTranslations('comments')

  // Local edit state for the main comment
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  const [isSaving, setIsSaving] = useState(false)

  // Local edit state for replies (keyed by reply id)
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null)
  const [replyEditValue, setReplyEditValue] = useState('')
  const [isSavingReply, setIsSavingReply] = useState(false)

  // 1.2.0+: kebab dropdown open state + click-outside to close.
  // 4.x: the dropdown is now PORTALLED to <body> with fixed coords so it can
  // never be clipped / covered by the mobile "Leave your comment" bar (which
  // is a fixed z-40 layer) — the old `absolute top-full z-30` menu on the last
  // comment rendered underneath it. Coords are measured from the trigger and
  // the menu flips ABOVE the button when there isn't room below.
  const [menuOpen, setMenuOpen] = useState(false)
  // Brief "Copied" confirmation state for the menu's Copy action.
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const menuPopoverRef = useRef<HTMLDivElement | null>(null)
  const [menuCoords, setMenuCoords] = useState<
    { top?: number; bottom?: number; right: number } | null
  >(null)
  useEffect(() => {
    if (!menuOpen) return
    const compute = () => {
      const el = menuTriggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const right = Math.max(8, window.innerWidth - rect.right)
      const MENU_EST_HEIGHT = 108 // ~2 items + padding
      const spaceBelow = window.innerHeight - rect.bottom
      if (spaceBelow < MENU_EST_HEIGHT + 16) {
        // Not enough room below (last comment sits near the input bar) → open
        // upward, anchored just above the trigger.
        setMenuCoords({ bottom: window.innerHeight - rect.top + 4, right })
      } else {
        setMenuCoords({ top: rect.bottom + 4, right })
      }
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [menuOpen])
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (menuPopoverRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('touchstart', onDocClick, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('touchstart', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // 1.2.0+: optimistic guard so rapid clicks don't double-toggle.
  const [resolving, setResolving] = useState(false)
  const isResolved = !!(comment as any).isResolved

  // 1.2.0+: reactions array (grouped by emoji) — already shaped server-side.
  const reactions: ReactionGroup[] = Array.isArray((comment as any).reactions)
    ? ((comment as any).reactions as ReactionGroup[])
    : []

  /** Strip HTML tags so the textarea shows plain text the user can edit. */
  const htmlToPlainText = (html: string): string => {
    if (typeof document === 'undefined') return html
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    return (tmp.textContent || tmp.innerText || '').trim()
  }

  // Copy the comment's plain text to the clipboard. Uses the async
  // Clipboard API when available (HTTPS / localhost) and falls back to a
  // hidden-textarea execCommand copy for insecure-origin / older browsers.
  const handleCopy = async () => {
    // 7.1.0: the paste clipboard first, so it is populated even if the system
    // clipboard write is refused (insecure origin, denied permission). The two
    // are independent and the in-app one is the one Paste depends on.
    onCopyForPaste?.(comment)
    const text = htmlToPlainText(comment.content)
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      // Show the "Copied" confirmation briefly, then close the menu.
      window.setTimeout(() => {
        setCopied(false)
        setMenuOpen(false)
      }, 900)
    } catch {
      // Copy failed (permissions / no clipboard) — just close the menu.
      setMenuOpen(false)
    }
  }

  const handleStartEdit = () => {
    setEditValue(htmlToPlainText(comment.content))
    setIsEditing(true)
    setMenuOpen(false)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('commentEditStart', {
          detail: {
            commentId: comment.id,
            videoId: comment.videoId,
            timecode: comment.timecode,
            timecodeEnd: (comment as any).timecodeEnd ?? null,
          },
        })
      )
    }
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditValue('')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('commentEditCancel', { detail: { commentId: comment.id } })
      )
    }
  }

  const handleSaveEdit = async () => {
    if (!onEdit) return
    const trimmed = editValue.trim()
    if (!trimmed) return
    try {
      setIsSaving(true)
      /*
       * 6.16.0: Save ends the drawing.
       *
       * Shapes live on the canvas until `finishDrawingMode` commits them, and
       * nothing else on screen calls it — the send arrow in the composer does,
       * but expecting someone to press THAT before pressing Save is a hidden
       * second step nobody would guess. So Save does it: you draw, you hit
       * Save, the arrow lands on the comment.
       *
       * The listener that stores the committed shapes runs synchronously off
       * the event, but we still yield a tick before the PATCH — the same
       * caution the composer's own submit path takes — so the value is
       * definitely readable by the time the request is built.
       */
      if (annotationCtx?.isDrawingMode) {
        if (annotationCtx.drawing.hasShapes) {
          annotationCtx.finishDrawingMode()
        } else {
          // Entered drawing mode and drew nothing. Leaving it open would keep
          // the canvas swallowing clicks on the video after the edit closed.
          annotationCtx.cancelDrawingMode()
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      // No extras are gathered here. Anything drawn or attached while this edit
      // is open lives in the composer at the bottom — the same controls used
      // for a new comment — and CommentSection folds it into the PATCH.
      // Duplicating those buttons inside the edit box gave two places to
      // attach a file and no way to tell which one a drawing belonged to.
      await onEdit(trimmed)
      setIsEditing(false)
      setEditValue('')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('commentEditCancel', { detail: { commentId: comment.id } })
        )
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleStartEditReply = (reply: Comment) => {
    setEditingReplyId(reply.id)
    setReplyEditValue(htmlToPlainText(reply.content))
  }

  const handleCancelEditReply = () => {
    setEditingReplyId(null)
    setReplyEditValue('')
  }

  const handleSaveEditReply = async (replyId: string) => {
    if (!onEditReply) return
    const trimmed = replyEditValue.trim()
    if (!trimmed) return
    try {
      setIsSavingReply(true)
      await onEditReply(replyId, trimmed)
      setEditingReplyId(null)
      setReplyEditValue('')
    } finally {
      setIsSavingReply(false)
    }
  }

  // Get effective author name for color generation
  // For internal comments without authorName, fall back to user.name or user.email
  const effectiveAuthorName = comment.authorName ||
    (comment.isInternal && (comment as any).user ?
      ((comment as any).user.name || (comment as any).user.email) :
      null)

  // Drawing-annotation focus: click anywhere on the bubble to surface this
  // comment's drawing on the video. Toggles off when clicking the same
  // comment again. Falls back to no-op when no provider is mounted.
  const annotationCtx = useOptionalAnnotation()
  const isAnnotationFocused = annotationCtx?.activeCommentId === comment.id
  const handleBubbleClick = (e: React.MouseEvent) => {
    // Don't toggle while interacting with form fields, buttons or links
    // inside the bubble — those have their own click semantics.
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, textarea, select')) return

    // 7.3.0: the click selects first. A modified click (Shift, ⌘, Ctrl) is a
    // selection gesture and nothing else — seeking the playhead and opening a
    // drawing while somebody is building a range would be the player reacting to
    // a request that was never about it. A plain click still does both: it picks
    // the comment AND jumps to its moment, which is what clicking a note has
    // always meant here.
    const isRangeOrToggle = e.shiftKey || e.metaKey || e.ctrlKey
    if (selectable && onSelectFromClick) {
      onSelectFromClick({
        shift: e.shiftKey,
        toggle: e.metaKey || e.ctrlKey,
      })
    }
    if (isRangeOrToggle) return

    // Seek the playhead to this comment's timecode whenever the bubble is
    // clicked, so the user can jump to the moment the comment was left
    // without having to hit the small timestamp badge. We forward the
    // precise `timestampMs` (1.0.3+) so the parent can land on the exact
    // capture moment instead of the frame-quantized timecode.
    if (comment.timecode && onSeekToTimecode) {
      onSeekToTimecode(
        comment.timecode,
        comment.videoId,
        comment.videoVersion,
        (comment as any).timestampMs ?? null
      )
    }

    // Toggle annotation focus (highlights the bubble + surfaces drawing on
    // the video). Only relevant inside an AnnotationProvider.
    if (annotationCtx) {
      annotationCtx.setActiveCommentId(isAnnotationFocused ? null : comment.id)
    }
  }

  const handleTimestampClick = () => {
    if (comment.timecode && onSeekToTimecode) {
      onSeekToTimecode(
        comment.timecode,
        comment.videoId,
        comment.videoVersion,
        (comment as any).timestampMs ?? null
      )
    }
    // Also surface this comment's drawing.
    annotationCtx?.setActiveCommentId(comment.id)
  }

  const handleResolveToggle = async () => {
    if (!onResolveToggle || resolving) return
    try {
      setResolving(true)
      await onResolveToggle(comment.id, !isResolved)
    } catch (err) {
      // 2.2.6+: surface resolve failures to the user. Pre-2.2.6 the
      // catch was missing — if the PATCH 4xx'd (permission, expired
      // session, etc) the promise rejected, the `void` swallowed it,
      // the badge stayed un-toggled, and the user thought clicking
      // "Done" did literally nothing. An alert is unrefined but
      // strictly better than the silent failure; future iteration
      // can replace it with a toast.
      const message =
        err instanceof Error ? err.message : 'Failed to mark comment'
      if (typeof window !== 'undefined') {
        // eslint-disable-next-line no-alert
        window.alert(message)
      }
      // eslint-disable-next-line no-console
      console.error('[MessageBubble] resolve toggle failed:', err)
    } finally {
      setResolving(false)
    }
  }

  const handleReactSelect = (emoji: string) => {
    if (!onReact) return
    void onReact(comment.id, emoji)
  }

  /**
   * 6.16.0: a note carried over from an earlier cut.
   *
   * `isCopied` (3.8.x) only said THAT a comment was pasted. The version label
   * is what makes it actionable — looking at v3, "written on v1" tells you the
   * note has survived two rounds without being addressed, which is a very
   * different signal from "someone pasted this".
   *
   * Comments pasted before 6.16.0 have no label; they keep the plain "Copied"
   * tag rather than being shown a version we never recorded.
   */
  const sourceVersionLabel: string | null =
    (comment as any).sourceVersionLabel || null
  const isFromPreviousVersion = !!sourceVersionLabel
  /**
   * Any carried-over note, whether it remembers its version or not.
   *
   * A pasted comment is a RECORD of what someone said on another cut. Editing
   * it would quietly rewrite history: the text in front of you would no longer
   * be the text that was written, and there is nothing left to check it
   * against. So carried-over notes are read-only — you resolve them, reply to
   * them, or delete them, but you do not put words in the original author's
   * mouth. If the note needs rewording for this cut, that is a new comment.
   */
  const isCarriedOver = isFromPreviousVersion || !!(comment as any).isCopied

  /**
   * 7.3.0: the right-click menu asks THIS bubble to start editing.
   *
   * Edit was in the kebab, which is gone for threads; the menu that replaced it
   * lives in CommentSection and cannot reach in here, because the edit textarea
   * and its draft are this component's own state. A window event addressed by id
   * is the pattern the file already uses for the copy/paste bridge, and it
   * beats hoisting an editing session up to the parent just so a menu item can
   * open it.
   */
  useEffect(() => {
    const onStartEdit = (e: Event) => {
      const id = (e as CustomEvent).detail?.commentId
      if (id !== comment.id) return
      if (!canEdit || isCarriedOver) return
      handleStartEdit()
    }
    window.addEventListener('comment:startEdit', onStartEdit as EventListener)
    return () =>
      window.removeEventListener('comment:startEdit', onStartEdit as EventListener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comment.id, canEdit, isCarriedOver, comment.content])

  const threadReplies = !isReply && replies && replies.length > 0 ? replies : []
  const hasReplies = threadReplies.length > 0

  return (
    // 1.9.1+: Frame.io-style cards. Each comment sits inside its own
    // rounded card (bg-card/50 + thin border) with breathing space
    // between cards (mb-2). Replies keep the flat-list look so the
    // thread reads as nested inside the parent card. Hover bumps the
    // card brightness one notch; the `comment-focused-glass` class
    // (toggled from CommentSection on avatar click) bumps it harder
    // with a frosted-glass feel — replaces the old box-shadow ring.
    <div
      className="w-full"
      id={`comment-${comment.id}`}
    >
      <div
        /**
         * 7.3.0: stop Shift-click from painting a text selection across the
         * range.
         *
         * The browser extends a text selection on MOUSEDOWN, not on click, so by
         * the time `handleBubbleClick` runs the highlight has already been drawn
         * from wherever the caret last was to here — every comment in between
         * turned blue behind the range that was being selected.
         *
         * Only for a Shift-click, and only where selection is offered. The
         * comments panel deliberately re-enables text selection on itself so
         * feedback stays copyable; suppressing it wholesale, or setting
         * `user-select: none`, would take that away to fix a modifier.
         *
         * `removeAllRanges` clears a highlight left over from an earlier drag —
         * preventDefault stops the extension but does not undo what is already
         * on screen.
         */
        onMouseDown={(e) => {
          if (selectable && e.shiftKey) {
            e.preventDefault()
            window.getSelection()?.removeAllRanges()
          }
        }}
        onClick={handleBubbleClick}
        // 2.5.1+: glass card. Drops `bg-card/50 + border` for the
        // v2.5 white-tint + hairline-ring pattern used everywhere
        // else (project cards, folder cards, profile sections).
        // Hover lifts the tint; focused / annotation-targeted
        // state uses the brand-blue accent ring.
        className={`group relative cursor-pointer transition-colors py-3 px-3 ${
          isReply
            ? 'rounded-md hover:bg-white/[0.04]'
            : 'rounded-xl bg-white/[0.04] ring-1 ring-white/10 hover:bg-white/[0.08] hover:ring-white/15 shadow-[0_6px_18px_-12px_rgba(0,0,0,0.5)]'
        } ${
          // 2.5.1+: drop hard-coded primary tint here — the
          // `.comment-card.is-selected` global rule paints the
          // accent-tinted glass surface so the focused / selected
          // state stays in sync with the user's chosen accent and
          // the rest of the v2.5 system. Annotation focus still
          // gets a slightly brighter base bg as a hint, with the
          // ring delegated to .is-selected when it eventually fires.
          isAnnotationFocused ? 'bg-white/[0.08]' : ''
        } ${isResolved ? 'opacity-70' : ''} ${
          // Carried-over notes sit back a step so the eye finds feedback
          // written ON this cut first. Not hidden — often the old note is the
          // whole reason you are here — just clearly second in line. Full
          // opacity on hover, because the moment you reach for it you want to
          // read it properly.
          isCarriedOver && !isResolved ? 'opacity-60 hover:opacity-100' : ''
        } comment-card`}
      >
        {hasReplies && (
          <div className="absolute left-[18px] top-9 bottom-9 w-px bg-border/50" aria-hidden="true" />
        )}

        <div className="grid grid-cols-[28px_1fr] gap-x-2.5 gap-y-3 items-start">
          {/* 7.3.0: the select circle belongs in THIS column, under the avatar,
              not out in the content beside Reply — Dragos wants the two on the
              same vertical line, which is the only way the ticks in a long list
              read as a column you can run your eye down.

              `self-stretch` keeps the stretching inside the parent comment's own
              grid row: replies are separate rows, so the circle lands at the
              bottom of the note it belongs to rather than at the foot of the
              whole thread. */}
          <div className="flex flex-col items-center justify-between self-stretch pt-0.5 pb-0.5">
            <InitialsAvatar name={effectiveAuthorName} size="sm" isInternal={comment.isInternal ?? false} />
            {selectable && !isReply && onToggleSelect && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleSelect()
                }}
                aria-pressed={!!isSelected}
                aria-label={isSelected ? 'Deselect comment' : 'Select comment'}
                title={isSelected ? 'Deselect' : 'Select'}
                className={cn(
                  // `relative z-10` so the reply thread's vertical rule passes
                  // behind it rather than through the ring.
                  // 7.3.0: 20px, not the avatar's 28. Matching the avatar
                  // exactly put two heavy discs at the two ends of every comment
                  // and the list stopped looking like text. It still sits centred
                  // in the avatar's column, which is the part that mattered.
                  'relative z-10 shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-full',
                  'transition-colors',
                  isSelected
                    ? 'bg-primary text-primary-foreground ring-1 ring-primary'
                    : 'ring-1 ring-white/30 hover:ring-white/60 opacity-60 group-hover:opacity-100',
                )}
              >
                {isSelected && <Check className="w-3 h-3" strokeWidth={3} />}
              </button>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-white truncate">
                {effectiveAuthorName || t('anonymous')}
              </span>
              <span className="text-[11px] text-white/55 flex-shrink-0">
                {formatMessageTime(comment.createdAt)}
              </span>
              {/*
                1.2.0+: resolved replaces the sequence number badge with a
                green check chip; otherwise we keep the #N indicator.
              */}
              <div className="ml-auto shrink-0 flex items-center gap-1.5">
                {/* 3.8.x: "Copied" tag for comments pasted in from another
                    version (Frame.io-style), so carried-over notes are
                    distinguishable from fresh ones.
                    6.16.0: when we know WHICH version, say it — and say it in
                    amber, because "this was already raised on an older cut" is
                    a thing you want to catch while scanning, not something to
                    find by reading every tag. */}
                {isFromPreviousVersion ? (
                  <span
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300 bg-amber-400/12 ring-1 ring-amber-400/25 whitespace-nowrap"
                    title={`Written on ${sourceVersionLabel}, carried over to this version`}
                  >
                    {t('previousVersion') || 'Previous version'}
                    <span className="font-mono normal-case text-amber-200/70">
                      {sourceVersionLabel}
                    </span>
                  </span>
                ) : (comment as any).isCopied ? (
                  // Pasted before 6.16.0, or pasted from the kebab rather than
                  // from a version — we know it was carried over, just not
                  // from where. Say exactly that much and no more.
                  <span
                    className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300/80 bg-amber-400/10 ring-1 ring-amber-400/20 whitespace-nowrap"
                    title="Copied from another version"
                  >
                    Copied
                  </span>
                ) : null}
                {isResolved ? (
                  /* 7.3.0: the green tick undoes itself.
                     It was a <span> — a label saying "done" with no way to say
                     otherwise, now that the resolve button has left the hover
                     row. Marking a comment complete by mistake had no undo
                     except the right-click menu. As a <button> it is also
                     excluded from the bubble's own click handler, which skips
                     buttons, so undoing does not also seek the player. */
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleResolveToggle()
                    }}
                    disabled={resolving || !onResolveToggle}
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white shadow-sm transition-colors hover:bg-emerald-400 disabled:opacity-60"
                    title={
                      (comment as any).resolvedBy
                        ? `${t('markUnresolved') || 'Mark as not done'} · ${(comment as any).resolvedBy}`
                        : t('markUnresolved') || 'Mark as not done'
                    }
                    aria-label={t('markUnresolved') || 'Mark as not done'}
                    aria-pressed
                  >
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </button>
                ) : (
                  typeof sequenceNumber === 'number' &&
                  sequenceNumber > 0 && (
                    <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                      #{sequenceNumber}
                    </span>
                  )
                )}
              </div>
            </div>

            {/*
              1.2.0+: timestamp + content live on the SAME visual row. The
              timecode badge sits inline at the start of the text flow
              (like Frame.io), so a short reply reads as one continuous
              line instead of stacked.
            */}
            {isEditing ? (
              <div className="mt-1 flex flex-col gap-2">
                <EditTextarea
                  value={editValue}
                  onChange={setEditValue}
                  onSave={handleSaveEdit}
                  onCancel={handleCancelEdit}
                  disabled={isSaving}
                  ariaLabel={t('editComment')}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    disabled={isSaving || !editValue.trim()}
                    className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                  >
                    {isSaving ? t('saving') : t('save')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    disabled={isSaving}
                    className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t('cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={`mt-0.5 text-sm whitespace-pre-wrap break-words leading-snug ${
                  isResolved ? 'text-muted-foreground' : 'text-foreground'
                }`}
              >
                {!isReply && timestampLabel && (
                  <>
                    <button
                      type="button"
                      onClick={handleTimestampClick}
                      className="inline-flex items-center align-baseline gap-1 rounded-md bg-warning-visible px-1.5 py-0.5 text-[11px] font-semibold text-warning hover:opacity-90 transition-opacity mr-1.5"
                      title={t('seekToTimecode')}
                    >
                      <span className="font-mono tabular-nums">
                        {timestampLabel}
                        {timecodeEndLabel ? ` → ${timecodeEndLabel}` : ''}
                      </span>
                    </button>
                    {hasAnnotation && (
                      <span
                        className="inline-flex items-center rounded-md bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400 mr-1.5 align-baseline"
                        title={t('hasAnnotation')}
                      >
                        <Brush className="w-3 h-3" />
                      </span>
                    )}
                  </>
                )}
                <span
                  className="[&>p]:m-0 [&>p]:inline"
                  dangerouslySetInnerHTML={{ __html: sanitizeContent(comment.content) }}
                />
              </div>
            )}

            {!isEditing && (comment as any).assets && (comment as any).assets.length > 0 && (
              <div className="mt-1.5">
                <CommentAttachments
                  assets={(comment as any).assets}
                  videoId={comment.videoId}
                  shareToken={shareToken}
                />
              </div>
            )}

            {/* 1.2.0+: reactions chip row */}
            {!isEditing && reactions.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {reactions.map((r) => (
                  <button
                    key={r.emoji}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleReactSelect(r.emoji)
                    }}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-none transition-colors border ${
                      r.mine
                        ? 'bg-primary/10 border-primary/30 text-primary'
                        : 'bg-muted/40 border-border hover:bg-muted'
                    }`}
                    title={r.reactors
                      .map((rc) => rc.authorName || t('anonymous'))
                      .join(', ')}
                  >
                    <span className="text-base leading-none">{r.emoji}</span>
                    <span className="tabular-nums">{r.count}</span>
                  </button>
                ))}
              </div>
            )}

            {/*
              1.2.0+: action row. "Reply" is always visible; the rest of
              the cluster (react / kebab / done) only appears on hover so
              the comment list reads cleanly.
            */}
            {!isEditing && (
              <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground/80 min-w-0">
                {/* 7.3.0: Reply takes the slot the kebab and the tick used to
                    occupy — bottom right. Everything those two offered now lives
                    on right-click, so the row carries one control instead of
                    three, and it is always visible. Hiding the only remaining
                    control until hover meant a comment showed no way to answer
                    it, which is the one thing a comment is for. */}
                {!isReply && !commentsDisabled && onReply && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onReply(null)
                    }}
                    className="ml-auto hover:text-foreground transition-colors font-medium whitespace-nowrap"
                  >
                    {t('reply')}
                  </button>
                )}

                {/* The cluster survives for REPLIES only.
                    A reply is not selectable — a batch of answers torn from
                    their questions is not something anyone copies — so it is
                    never covered by the right-click menu, and removing this from
                    replies as well would have left them with no way to be edited
                    or deleted at all. Threads get the menu; replies keep their
                    kebab until they get one of their own. */}
                {isReply && (
                <div
                  className="flex items-center gap-1 ml-auto opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/*
                    1.2.0+: reactions live behind the kebab dropdown — the
                    standalone smiley button was removed at the user's
                    request to keep the action row visually quiet. The
                    `onReact` prop is still wired in via the reactions
                    pills above, and a future iteration can move it into
                    the kebab menu if the picker is still desired.
                  */}

                  {/* Kebab → Edit / Delete. 2.5.1+: v2.5 glass styling to
                      match CommentsKebabMenu / PlayerTopMenu / FolderCard.
                      Trigger = soft white tint + hairline ring. Dropdown
                      = solid `#162533` + ring-white/10 (backdrop-blur
                      doesn't compose reliably in this stacking context
                      so we go solid like the rest of the dropdowns). */}
                  {((canEdit && !isCarriedOver) || onDelete) && (
                    <div ref={menuRef} className="relative">
                      <button
                        ref={menuTriggerRef}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpen((v) => !v)
                        }}
                        className={`inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 transition-colors text-white/65 hover:text-white ${
                          menuOpen ? 'bg-white/[0.12] ring-white/20 text-white' : ''
                        }`}
                        title={t('moreActions') || 'More'}
                        aria-label={t('moreActions') || 'More'}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      {menuOpen && menuCoords && typeof document !== 'undefined' && createPortal(
                        <div
                          ref={menuPopoverRef}
                          role="menu"
                          className="fixed z-[120] min-w-[160px] rounded-lg ring-1 ring-white/15 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-1 text-white animate-in fade-in-0 duration-150 overflow-hidden"
                          // True glass surface: lighter navy base + accent
                          // radial bleed in the top-left so the dropdown
                          // reads as a translucent panel sitting on top of
                          // the comments sidebar, not the same flat slab
                          // as the comment card behind it. Portalled to <body>
                          // + z-[120] so the fixed mobile input bar (z-40) can
                          // never cover it.
                          style={{
                            top: menuCoords.top,
                            bottom: menuCoords.bottom,
                            right: menuCoords.right,
                            backgroundColor: 'rgba(28, 44, 64, 0.92)',
                            backgroundImage:
                              'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
                            backdropFilter: 'blur(20px) saturate(150%)',
                            WebkitBackdropFilter: 'blur(20px) saturate(150%)',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              void handleCopy()
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-white hover:bg-white/[0.10] transition-colors text-left"
                            role="menuitem"
                          >
                            {copied ? (
                              <Check className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span className="flex-1">
                              {copied
                                ? t('copiedComment') || 'Copied'
                                : t('copyComment') || 'Copy'}
                            </span>
                          </button>
                          {/* Carried-over notes are a record of what someone
                              said elsewhere; editing them would rewrite that
                              record with nothing left to check it against.
                              Delete and Copy stay — removing a note you no
                              longer need is not the same as rewording it. */}
                          {canEdit && onEdit && !isCarriedOver && (
                            <button
                              type="button"
                              onClick={() => {
                                setMenuOpen(false)
                                handleStartEdit()
                              }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-white hover:bg-white/[0.10] transition-colors text-left"
                              role="menuitem"
                            >
                              <Pencil className="w-3.5 h-3.5 shrink-0" />
                              <span className="flex-1">{t('editComment') || 'Edit'}</span>
                            </button>
                          )}
                          {onDelete && (
                            <button
                              type="button"
                              onClick={() => {
                                setMenuOpen(false)
                                onDelete()
                              }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors text-left"
                              role="menuitem"
                            >
                              <Trash2 className="w-3.5 h-3.5 shrink-0" />
                              <span className="flex-1">{t('deleteComment') || 'Delete'}</span>
                            </button>
                          )}
                        </div>,
                        document.body
                      )}
                    </div>
                  )}

                  {/* Mark as done — same circular chip as the kebab so the
                      two sit balanced next to each other.
                      2.2.6+: when the comment is already resolved, the
                      chip flips to a red X to make the "click to
                      undo" affordance unambiguous. Previously it kept
                      showing a check (just with a slightly thicker
                      stroke) and several users read it as "still
                      pending" — clicking made the green badge in the
                      top corner disappear and felt like a regression
                      instead of an undo. */}
                  {onResolveToggle && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleResolveToggle()
                      }}
                      disabled={resolving}
                      className={`inline-flex items-center justify-center w-7 h-7 rounded-full transition-colors ${
                        isResolved
                          ? 'bg-red-500/10 ring-1 ring-red-500/30 text-red-400 hover:bg-red-500/20 hover:ring-red-500/50 hover:text-red-300'
                          : 'bg-white/[0.06] ring-1 ring-white/10 text-white/65 hover:bg-emerald-500/15 hover:ring-emerald-400/40 hover:text-emerald-300'
                      }`}
                      title={
                        isResolved
                          ? t('markUnresolved') || 'Mark as not done'
                          : t('markResolved') || 'Mark as done'
                      }
                      aria-label={
                        isResolved
                          ? t('markUnresolved') || 'Mark as not done'
                          : t('markResolved') || 'Mark as done'
                      }
                      aria-pressed={isResolved}
                    >
                      {isResolved ? (
                        <X className="w-4 h-4" strokeWidth={2.5} />
                      ) : (
                        <Check className="w-4 h-4" strokeWidth={2} />
                      )}
                    </button>
                  )}
                </div>
                )}
              </div>
            )}

            {/* 1.3.2+: inline reply input — rendered directly under
                the action row when the user clicks "Reply" on THIS
                bubble. The parent (CommentSection) passes the actual
                <CommentInput> only for the matched comment so the
                reply lands in context instead of jumping to the
                global input at the top / bottom of the screen. */}
            {inlineReplyInput && (
              <div className="mt-3">{inlineReplyInput}</div>
            )}
          </div>

          {threadReplies.map((reply) => {
            const replyEffectiveName = reply.authorName ||
              (reply.isInternal && (reply as any).user ?
                ((reply as any).user.name || (reply as any).user.email) :
                null)

            return (
              <div key={reply.id} className="contents">
                <div className="flex justify-center pt-0.5">
                  <InitialsAvatar name={replyEffectiveName} size="sm" isInternal={reply.isInternal ?? false} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold text-foreground truncate">
                      {replyEffectiveName || t('anonymous')}
                    </span>
                    <span className="text-[11px] text-muted-foreground flex-shrink-0">
                      {formatMessageTime(reply.createdAt)}
                    </span>
                    <div className="ml-auto flex items-center gap-2 text-muted-foreground/80">
                      {/*
                        6.15.2: you can answer a reply. Before, only the root
                        comment carried a Reply button, so the moment a thread
                        had one answer the conversation had nowhere to go —
                        you had to start a second top-level comment and lose
                        the context.

                        It attaches to the same root comment rather than
                        nesting deeper: the data model allows arbitrary depth,
                        but a review thread that indents forever stops being
                        readable next to a video. Addressing the person by
                        name keeps it clear who is being answered.
                      */}
                      {!commentsDisabled && onReply && editingReplyId !== reply.id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onReply(replyEffectiveName || null)
                          }}
                          className="hover:text-foreground transition-colors font-medium whitespace-nowrap text-[11px]"
                        >
                          {t('reply')}
                        </button>
                      )}
                      {canEditReply && canEditReply(reply) && onEditReply && editingReplyId !== reply.id && (
                        <button
                          onClick={() => handleStartEditReply(reply)}
                          className="hover:text-foreground transition-colors"
                          title={t('editComment')}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {onDeleteReply && editingReplyId !== reply.id && (
                        <button
                          onClick={() => onDeleteReply(reply.id)}
                          className="hover:text-destructive transition-colors"
                          title={t('deleteReply')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {editingReplyId === reply.id ? (
                    <div className="mt-1 flex flex-col gap-2">
                      <EditTextarea
                        value={replyEditValue}
                        onChange={setReplyEditValue}
                        onSave={() => handleSaveEditReply(reply.id)}
                        onCancel={handleCancelEditReply}
                        disabled={isSavingReply}
                        ariaLabel={t('editComment')}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSaveEditReply(reply.id)}
                          disabled={isSavingReply || !replyEditValue.trim()}
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                        >
                          {isSavingReply ? t('saving') : t('save')}
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelEditReply}
                          disabled={isSavingReply}
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div
                        className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words leading-snug [&>p]:m-0"
                        dangerouslySetInnerHTML={{ __html: sanitizeContent(reply.content) }}
                      />
                      {(reply as any).assets && (reply as any).assets.length > 0 && (
                        <div className="mt-1.5">
                          <CommentAttachments
                            assets={(reply as any).assets}
                            videoId={reply.videoId}
                            shareToken={shareToken}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * 3.9.x: glass edit input for comments/replies. Replaces the old
 * `bg-background` (near-black) textarea with the app's v2.5 glass
 * vocabulary, and fixes two UX papercuts:
 *   - AUTO-GROW: the box expands to fit the whole comment (no inner
 *     scrollbar) instead of being capped at 8 rows.
 *   - Enter SAVES, Shift+Enter inserts a newline, Esc cancels — matches
 *     the "Leave your comment" composer.
 */
function EditTextarea({
  value,
  onChange,
  onSave,
  onCancel,
  disabled,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
  disabled?: boolean
  ariaLabel?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow the textarea to fit its content so the full comment is visible
  // without an inner scrollbar.
  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // Size + focus (caret at end) on mount.
  useEffect(() => {
    resize()
    const el = ref.current
    if (el) {
      el.focus()
      const len = el.value.length
      try {
        el.setSelectionRange(len, len)
      } catch {
        /* some browsers throw on programmatic selection — ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-grow whenever the value changes (typing, paste, external set).
  useEffect(() => {
    resize()
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // Enter saves; Shift+Enter is a newline; Esc cancels.
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          onSave()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      className="w-full resize-none overflow-hidden rounded-lg bg-white/[0.06] ring-1 ring-white/15 px-3 py-2 text-sm text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
    />
  )
}
