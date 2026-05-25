'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import {
  Trash2,
  Brush,
  Pencil,
  Check,
  MoreHorizontal,
} from 'lucide-react'
import DOMPurify from 'isomorphic-dompurify'
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
  onReply?: () => void
  onSeekToTimecode?: (
    timecode: string,
    videoId: string,
    videoVersion: number | null,
    /** Sub-second precision capture moment in milliseconds. Takes priority
     *  over `timecode` for the actual seek when provided (1.0.3+). */
    timestampMs?: number | null
  ) => void
  onDelete?: () => void
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
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
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
    } finally {
      setResolving(false)
    }
  }

  const handleReactSelect = (emoji: string) => {
    if (!onReact) return
    void onReact(comment.id, emoji)
  }

  const threadReplies = !isReply && replies && replies.length > 0 ? replies : []
  const hasReplies = threadReplies.length > 0

  return (
    // Frame.io-style flat list item — no card wrapper, no border around the
    // whole comment, no shadow. Hover reveals the right-side action cluster
    // (emoji react / kebab / mark as done). When the comment is resolved
    // we dim the whole row and stamp a green ✓ where the sequence number
    // used to sit.
    <div className="w-full" id={`comment-${comment.id}`}>
      <div
        onClick={handleBubbleClick}
        className={`group relative cursor-pointer transition-colors py-2 pl-3 pr-1 -mx-2 rounded-md ${
          isAnnotationFocused
            ? 'bg-primary/5 ring-1 ring-primary/30'
            : 'hover:bg-muted/30'
        } ${isResolved ? 'opacity-70' : ''}`}
      >
        {hasReplies && (
          <div className="absolute left-[18px] top-9 bottom-9 w-px bg-border/50" aria-hidden="true" />
        )}

        <div className="grid grid-cols-[28px_1fr] gap-x-2.5 gap-y-3 items-start">
          <div className="flex justify-center pt-0.5">
            <InitialsAvatar name={effectiveAuthorName} size="sm" isInternal={comment.isInternal ?? false} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-foreground truncate">
                {effectiveAuthorName || t('anonymous')}
              </span>
              <span className="text-[11px] text-muted-foreground flex-shrink-0">
                {formatMessageTime(comment.createdAt)}
              </span>
              {/*
                1.2.0+: resolved replaces the sequence number badge with a
                green check chip; otherwise we keep the #N indicator.
              */}
              <div className="ml-auto shrink-0">
                {isResolved ? (
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white shadow-sm"
                    title={
                      (comment as any).resolvedBy
                        ? `${t('resolved') || 'Done'} · ${(comment as any).resolvedBy}`
                        : t('resolved') || 'Done'
                    }
                  >
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </span>
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
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={Math.min(8, Math.max(2, editValue.split('\n').length))}
                  autoFocus
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                <div className="flex items-center gap-3">
                  {!isReply && !commentsDisabled && onReply && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onReply()
                      }}
                      className="hover:text-foreground transition-colors font-medium whitespace-nowrap"
                    >
                      {t('reply')}
                    </button>
                  )}
                </div>

                <div
                  className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
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

                  {/* Kebab → Edit / Delete (rounded chip, matches Frame.io). */}
                  {(canEdit || onDelete) && (
                    <div ref={menuRef} className="relative">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpen((v) => !v)
                        }}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-border bg-transparent hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                        title={t('moreActions') || 'More'}
                        aria-label={t('moreActions') || 'More'}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      {menuOpen && (
                        <div
                          role="menu"
                          className="absolute right-0 top-full mt-1 z-30 min-w-[140px] rounded-md border border-border bg-popover shadow-md py-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {canEdit && onEdit && (
                            <button
                              type="button"
                              onClick={() => {
                                setMenuOpen(false)
                                handleStartEdit()
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                              role="menuitem"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                              {t('editComment') || 'Edit'}
                            </button>
                          )}
                          {onDelete && (
                            <button
                              type="button"
                              onClick={() => {
                                setMenuOpen(false)
                                onDelete()
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                              role="menuitem"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              {t('deleteComment') || 'Delete'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Mark as done — same circular chip as the kebab so the
                      two sit balanced next to each other. */}
                  {onResolveToggle && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleResolveToggle()
                      }}
                      disabled={resolving}
                      className={`inline-flex items-center justify-center w-7 h-7 rounded-full border bg-transparent transition-colors ${
                        isResolved
                          ? 'border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10'
                          : 'border-border text-muted-foreground hover:text-emerald-600 hover:bg-muted'
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
                      <Check
                        className="w-4 h-4"
                        strokeWidth={isResolved ? 3 : 2}
                      />
                    </button>
                  )}
                </div>
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
                    <div className="ml-auto flex items-center gap-1.5 text-muted-foreground/80">
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
                      <textarea
                        value={replyEditValue}
                        onChange={(e) => setReplyEditValue(e.target.value)}
                        rows={Math.min(8, Math.max(2, replyEditValue.split('\n').length))}
                        autoFocus
                        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
