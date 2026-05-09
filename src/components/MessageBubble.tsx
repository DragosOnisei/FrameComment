'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import { Clock, Trash2, Brush, Pencil } from 'lucide-react'
import DOMPurify from 'isomorphic-dompurify'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import CommentAttachments from './CommentAttachments'
import { useOptionalAnnotation } from '@/contexts/AnnotationContext'

type CommentWithReplies = Comment & {
  replies?: Comment[]
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
    // Tell the timeline (via CommentSection) about the comment we're
    // editing so it can paint the existing in/out range with the
    // draggable handle. The user can then adjust the range as part of
    // the edit.
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

  const threadReplies = !isReply && replies && replies.length > 0 ? replies : []
  const hasReplies = threadReplies.length > 0

  return (
    // Frame.io-style flat list item \u2014 no card wrapper, no border
    // around the whole comment, no shadow. Just a small avatar +
    // metadata row + content + actions, separated from siblings by
    // a thin divider. The active comment (annotation focused) gets
    // a subtle ring on the LEFT margin instead of around the whole
    // box, so the visual emphasis is light.
    <div className="w-full" id={`comment-${comment.id}`}>
      <div
        onClick={handleBubbleClick}
        className={`relative cursor-pointer transition-colors py-2 pl-3 pr-1 -mx-2 rounded-md ${
          isAnnotationFocused
            ? 'bg-primary/5 ring-1 ring-primary/30'
            : 'hover:bg-muted/30'
        }`}
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
              {typeof sequenceNumber === 'number' && sequenceNumber > 0 && (
                <span className="ml-auto text-[11px] text-muted-foreground/70 shrink-0 tabular-nums">
                  #{sequenceNumber}
                </span>
              )}
            </div>

            {!isReply && timestampLabel && (
              <div className="flex items-center gap-1.5 mt-1 mb-0.5 flex-wrap">
                <button
                  type="button"
                  onClick={handleTimestampClick}
                  className="inline-flex items-center gap-1 rounded-md bg-warning-visible px-1.5 py-0.5 text-[11px] font-semibold text-warning hover:opacity-90 transition-opacity"
                  title={t('seekToTimecode')}
                >
                  <Clock className="w-3 h-3" />
                  <span className="font-mono tabular-nums">
                    {timestampLabel}{timecodeEndLabel ? ` \u2192 ${timecodeEndLabel}` : ''}
                  </span>
                </button>
                {hasAnnotation && (
                  <span className="inline-flex items-center rounded-md bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400" title={t('hasAnnotation')}>
                    <Brush className="w-3 h-3" />
                  </span>
                )}
              </div>
            )}

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
              <div className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words leading-snug">
                <div
                  className="[&>p]:m-0"
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

            {!isEditing && (
              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground/80 min-w-0">
                {!isReply && !commentsDisabled && onReply && (
                  <button
                    onClick={onReply}
                    className="hover:text-foreground transition-colors font-medium whitespace-nowrap"
                  >
                    {t('reply')}
                  </button>
                )}
                {canEdit && onEdit && (
                  <button
                    onClick={handleStartEdit}
                    className="inline-flex items-center hover:text-foreground transition-colors"
                    title={t('editComment')}
                    aria-label={t('editComment')}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                {onDelete && (
                  <button
                    onClick={onDelete}
                    className="inline-flex items-center hover:text-destructive transition-colors"
                    title={t('deleteComment')}
                    aria-label={t('deleteComment')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
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
