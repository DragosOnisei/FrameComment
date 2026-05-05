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
  onSeekToTimecode?: (timecode: string, videoId: string, videoVersion: number | null) => void
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
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditValue('')
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
    if (annotationCtx) {
      annotationCtx.setActiveCommentId(isAnnotationFocused ? null : comment.id)
    }
  }

  const handleTimestampClick = () => {
    if (comment.timecode && onSeekToTimecode) {
      onSeekToTimecode(comment.timecode, comment.videoId, comment.videoVersion)
    }
    // Also surface this comment's drawing.
    annotationCtx?.setActiveCommentId(comment.id)
  }

  const threadReplies = !isReply && replies && replies.length > 0 ? replies : []
  const hasReplies = threadReplies.length > 0

  return (
    <div className="w-full" id={`comment-${comment.id}`}>
      <div
        onClick={handleBubbleClick}
        className={`bg-card border rounded-lg p-4 shadow-elevation-sm relative cursor-pointer transition-colors ${
          isAnnotationFocused
            ? 'border-primary/60 ring-1 ring-primary/40'
            : 'border-border/50 hover:border-border'
        }`}
      >
        {hasReplies && (
          <div className="absolute left-9 top-12 bottom-10 w-px bg-border/50" aria-hidden="true" />
        )}

        <div className="grid grid-cols-[40px_1fr] gap-x-3 gap-y-6 items-start">
          <div className="flex justify-center">
            <InitialsAvatar name={effectiveAuthorName} size="md" isInternal={comment.isInternal ?? false} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 min-w-0">
              <span className="text-base font-semibold text-foreground truncate">
                {effectiveAuthorName || t('anonymous')}
              </span>
              <span className="ml-auto text-sm text-muted-foreground flex-shrink-0">
                {formatMessageTime(comment.createdAt)}
              </span>
            </div>

            {!isReply && timestampLabel && (
              <div className="flex items-center gap-1.5 mb-1.5">
                <button
                  type="button"
                  onClick={handleTimestampClick}
                  className="inline-flex items-center gap-1 rounded-md bg-warning-visible px-2 py-0.5 text-xs font-semibold text-warning hover:opacity-90 transition-opacity"
                  title={t('seekToTimecode')}
                >
                  <Clock className="w-3 h-3" />
                  <span className="font-mono">
                    {timestampLabel}{timecodeEndLabel ? ` \u2192 ${timecodeEndLabel}` : ''}
                  </span>
                </button>
                {hasAnnotation && (
                  <span className="inline-flex items-center rounded-md bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400" title={t('hasAnnotation')}>
                    <Brush className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
            )}

            {isEditing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={Math.min(8, Math.max(2, editValue.split('\n').length))}
                  autoFocus
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    disabled={isSaving || !editValue.trim()}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                  >
                    {isSaving ? t('saving') : t('save')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    disabled={isSaving}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t('cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-base text-foreground whitespace-pre-wrap break-words leading-relaxed">
                <div
                  className="[&>p]:m-0"
                  dangerouslySetInnerHTML={{ __html: sanitizeContent(comment.content) }}
                />
              </div>
            )}

            {!isEditing && (comment as any).assets && (comment as any).assets.length > 0 && (
              <CommentAttachments
                assets={(comment as any).assets}
                videoId={comment.videoId}
                shareToken={shareToken}
              />
            )}

            {!isEditing && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {!isReply && !commentsDisabled && onReply && (
                  <button
                    onClick={onReply}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors font-medium"
                  >
                    {t('reply')}
                  </button>
                )}
                {canEdit && onEdit && (
                  <button
                    onClick={handleStartEdit}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors font-medium flex items-center gap-1"
                    title={t('editComment')}
                  >
                    <Pencil className="w-4 h-4" />
                    {t('editComment')}
                  </button>
                )}
                {onDelete && (
                  <button
                    onClick={onDelete}
                    className="text-sm text-muted-foreground hover:text-destructive transition-colors font-medium flex items-center gap-1"
                    title={t('deleteComment')}
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('deleteComment')}
                  </button>
                )}
              </div>
              {typeof sequenceNumber === 'number' && sequenceNumber > 0 && (
                <span className="text-sm text-muted-foreground">
                  #{sequenceNumber}
                </span>
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
                <div className="flex justify-center">
                  <InitialsAvatar name={replyEffectiveName} size="md" isInternal={reply.isInternal ?? false} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-2 min-w-0">
                    <span className="text-base font-semibold text-foreground truncate">
                      {replyEffectiveName || t('anonymous')}
                    </span>
                    <span className="text-sm text-muted-foreground flex-shrink-0">
                      {formatMessageTime(reply.createdAt)}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      {canEditReply && canEditReply(reply) && onEditReply && editingReplyId !== reply.id && (
                        <button
                          onClick={() => handleStartEditReply(reply)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title={t('editComment')}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      {onDeleteReply && editingReplyId !== reply.id && (
                        <button
                          onClick={() => onDeleteReply(reply.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          title={t('deleteReply')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  {editingReplyId === reply.id ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={replyEditValue}
                        onChange={(e) => setReplyEditValue(e.target.value)}
                        rows={Math.min(8, Math.max(2, replyEditValue.split('\n').length))}
                        autoFocus
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSaveEditReply(reply.id)}
                          disabled={isSavingReply || !replyEditValue.trim()}
                          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                        >
                          {isSavingReply ? t('saving') : t('save')}
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelEditReply}
                          disabled={isSavingReply}
                          className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div
                        className="text-base text-foreground whitespace-pre-wrap break-words leading-relaxed [&>p]:m-0"
                        dangerouslySetInnerHTML={{ __html: sanitizeContent(reply.content) }}
                      />
                      {(reply as any).assets && (reply as any).assets.length > 0 && (
                        <CommentAttachments
                          assets={(reply as any).assets}
                          videoId={reply.videoId}
                          shareToken={shareToken}
                        />
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
