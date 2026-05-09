'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Clock, Send, X, Keyboard, Paperclip, Pencil, PenTool } from 'lucide-react'
import { formatCommentTimestamp, secondsToTimecode } from '@/lib/timecode'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import CommentAttachmentButton from './CommentAttachmentButton'
import VoiceRecorderButton from './VoiceRecorderButton'
import AnnotationToolbarInline from './AnnotationToolbarInline'
import { useOptionalAnnotation } from '@/contexts/AnnotationContext'

interface CommentInputProps {
  newComment: string
  onCommentChange: (value: string) => void
  /** Fires when the textarea receives focus. The host hook captures the
   *  current playhead and stores it as the comment's "in" point. */
  onInputFocus?: () => void
  onSubmit: () => void
  loading: boolean

  // Timestamp
  selectedTimestamp: number | null
  onClearTimestamp: () => void
  selectedVideoFps: number // FPS of the currently selected video
  selectedVideoDurationSeconds?: number | null
  timestampDisplayMode?: 'TIMECODE' | 'AUTO'

  // Timecode range (in/out)
  selectedTimecodeEnd?: string | null
  onSetTimecodeEnd?: () => void
  onClearTimecodeEnd?: () => void

  // Reply state
  replyingToComment: Comment | null
  onCancelReply: () => void

  // Author name (for clients on password-protected shares)
  showAuthorInput: boolean
  authorName: string
  onAuthorNameChange: (value: string) => void
  namedRecipients: Array<{ id: string; name: string | null }>
  nameSource: 'recipient' | 'custom' | 'none'
  selectedRecipientId: string
  onNameSourceChange: (source: 'recipient' | 'custom' | 'none', recipientId?: string) => void
  isOtpAuthenticated?: boolean

  // Restrictions
  currentVideoRestricted: boolean
  restrictionMessage?: string
  commentsDisabled: boolean

  // Attachments
  allowClientAssetUpload?: boolean
  selectedVideoId?: string | null
  pendingAttachments?: Array<{ assetId: string; videoId: string; fileName: string; fileSize: string; fileType: string; category: string }>
  onAttachmentAdded?: (attachment: { assetId: string; videoId: string; fileName: string; fileSize: string; fileType: string; category: string }) => void
  onRemoveAttachment?: (assetId: string) => void
  attachmentError?: string | null
  attachmentNotice?: string | null
  onAttachmentErrorChange?: (message: string | null) => void
  shareToken?: string | null
  maxCommentAttachments?: number

  // Annotation drawing
  pendingAnnotation?: boolean
  onStartDrawing?: () => void
  onClearAnnotation?: () => void

  // Optional shortcuts UI (share pages)
  showShortcutsButton?: boolean
  onShowShortcuts?: () => void
}

export default function CommentInput({
  newComment,
  onCommentChange,
  onInputFocus,
  onSubmit,
  loading,
  selectedTimestamp,
  onClearTimestamp,
  selectedVideoFps,
  selectedVideoDurationSeconds = null,
  timestampDisplayMode = 'TIMECODE',
  selectedTimecodeEnd = null,
  onSetTimecodeEnd,
  onClearTimecodeEnd,
  replyingToComment,
  onCancelReply,
  showAuthorInput,
  authorName,
  onAuthorNameChange,
  namedRecipients,
  nameSource,
  selectedRecipientId,
  onNameSourceChange,
  isOtpAuthenticated = false,
  currentVideoRestricted,
  restrictionMessage,
  commentsDisabled,
  allowClientAssetUpload = false,
  selectedVideoId: selectedVideoIdProp = null,
  pendingAttachments = [],
  onAttachmentAdded,
  onRemoveAttachment,
  attachmentError = null,
  attachmentNotice = null,
  onAttachmentErrorChange,
  shareToken = null,
  maxCommentAttachments,
  pendingAnnotation = false,
  onStartDrawing,
  onClearAnnotation,
  showShortcutsButton = false,
  onShowShortcuts,
}: CommentInputProps) {
  const t = useTranslations('comments')
  // Optional — provider may not be present in every host page (e.g. preview
  // contexts). Falls back to null and we render the legacy icon row.
  const annotationCtx = useOptionalAnnotation()
  const tCommon = useTranslations('common')

  // True while the voice recorder is recording or showing its post-record
  // preview. While active, we hide the sibling icon buttons (draw,
  // paperclip) so the recorder UI gets the whole input row to itself.
  const [isVoiceActive, setIsVoiceActive] = useState(false)

  if (commentsDisabled) {
    // Still show the shortcuts button when comments are disabled (e.g. after approval)
    if (showShortcutsButton && onShowShortcuts) {
      return (
        <div className="p-3 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onShowShortcuts}
            className="hidden lg:inline-flex"
          >
            <Keyboard className="w-4 h-4 lg:mr-2" />
            <span className="hidden lg:inline">{t('shortcuts')}</span>
          </Button>
        </div>
      )
    }
    return null
  }

  // Check if name selection is required but not provided
  const isNameRequired = showAuthorInput && namedRecipients.length > 0 && nameSource === 'none'
  const hasAttachments = pendingAttachments.length > 0
  const canSubmit = !loading && (newComment.trim() || hasAttachments || pendingAnnotation) && !isNameRequired
  const timestampLabel =
    selectedTimestamp !== null && selectedTimestamp !== undefined
      ? formatCommentTimestamp({
          timecode: secondsToTimecode(selectedTimestamp, selectedVideoFps),
          fps: selectedVideoFps,
          videoDurationSeconds: selectedVideoDurationSeconds,
          mode: timestampDisplayMode,
        })
      : null

  const timecodeEndLabel = selectedTimecodeEnd
    ? formatCommentTimestamp({
        timecode: selectedTimecodeEnd,
        fps: selectedVideoFps,
        videoDurationSeconds: selectedVideoDurationSeconds,
        mode: timestampDisplayMode,
      })
    : null

  /**
   * Submit the comment, auto-committing any in-progress drawing first. Used
   * by both the Send button click and the Enter keyboard shortcut so they
   * stay in sync.
   */
  const submitWithAutoFinish = () => {
    if (annotationCtx?.isDrawingMode) {
      if (annotationCtx.drawing.hasShapes) {
        annotationCtx.finishDrawingMode()
      } else {
        annotationCtx.cancelDrawingMode()
      }
      // Defer one tick so the synchronous annotationComplete listener
      // can populate the comment-management hook's ref before submit reads it.
      setTimeout(() => onSubmit(), 0)
      return
    }
    onSubmit()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Allow Ctrl+Space and other Ctrl shortcuts to pass through to VideoPlayer
    if (e.ctrlKey) {
      // Don't handle Ctrl shortcuts here - let them bubble to VideoPlayer
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Prevent multiple submissions while loading
      if (canSubmit || annotationCtx?.isDrawingMode) {
        submitWithAutoFinish()
      }
    }
  }

  return (
    <div className="border-t border-border p-3 sm:p-4 bg-card flex-shrink-0 min-w-0">
      {/* Restriction Warning */}
      {currentVideoRestricted && restrictionMessage && (
        <div className="mb-3 p-3 bg-warning-visible border-2 border-warning-visible rounded-lg">
          <p className="text-sm text-warning font-medium flex items-center gap-2">
            <span className="font-semibold">{t('commentsRestricted')}</span>
          </p>
          <p className="text-xs text-warning font-medium mt-1">
            {restrictionMessage}
          </p>
        </div>
      )}

      {/* Replying To Indicator */}
      {replyingToComment && (
        <div className="mb-3 p-3 bg-muted/30 border border-border rounded-lg flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <InitialsAvatar name={replyingToComment.authorName || t('anonymous')} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-foreground font-semibold mb-1 truncate">
                {t('replyingTo')} {replyingToComment.authorName || t('anonymous')}
              </p>
              <p className="text-xs text-muted-foreground line-clamp-2 leading-snug">
                {replyingToComment.content}
              </p>
            </div>
          </div>
          <button
            onClick={onCancelReply}
            className="text-xs text-muted-foreground hover:text-foreground font-medium flex-shrink-0 px-2 py-1 rounded hover:bg-muted transition-colors"
          >
            {tCommon('cancel')}
          </button>
        </div>
      )}

      {/* Author Info - Only show for password-protected shares (not for admin users) */}
      {!currentVideoRestricted && showAuthorInput && !isOtpAuthenticated && (
        <div className="mb-3 space-y-2">
          {namedRecipients.length > 0 ? (
            <>
              <Select
                value={nameSource === 'recipient' && selectedRecipientId ? selectedRecipientId : nameSource === 'custom' ? 'custom' : 'none'}
                onValueChange={(value) => {
                  if (value === 'custom') {
                    onNameSourceChange('custom')
                  } else if (value === 'none') {
                    onNameSourceChange('none')
                  } else {
                    onNameSourceChange('recipient', value)
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('selectName')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('selectName')}</SelectItem>
                  {namedRecipients.map((recipient) => (
                    <SelectItem key={recipient.id} value={recipient.id}>
                      {recipient.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">{t('customName')}</SelectItem>
                </SelectContent>
              </Select>

              {nameSource === 'custom' && (
                <Input
                  placeholder={t('enterYourName')}
                  value={authorName}
                  onChange={(e) => onAuthorNameChange(e.target.value)}
                  className="text-sm"
                  autoFocus
                />
              )}
            </>
          ) : (
            <Input
              placeholder={t('yourNameOptional')}
              value={authorName}
              onChange={(e) => onAuthorNameChange(e.target.value)}
              className="text-sm"
            />
          )}
        </div>
      )}

      {/* Show read-only name indicator when OTP authenticated */}
      {!currentVideoRestricted && showAuthorInput && isOtpAuthenticated && authorName && (
        <div className="mb-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border border-border rounded-md">
            <InitialsAvatar name={authorName} size="sm" />
            <span className="text-sm text-foreground font-medium">
              {t('commentingAs')} <span className="font-semibold">{authorName}</span>
            </span>
          </div>
        </div>
      )}

      {/* Timestamp / range chip moved INSIDE the textarea wrapper —
          see below. The old standalone row above the textarea has been
          retired in favour of a Frame.io-style inline chip; that's why
          this slot is now empty. */}

      {/* Message Input */}
      {!currentVideoRestricted && (
        <>
          {/* Pending annotation indicator */}
          {pendingAnnotation && (
            <div className="mb-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded-md text-xs text-blue-600 dark:text-blue-400">
                <Pencil className="w-3 h-3" />
                {t('drawingAttached')}
                {onClearAnnotation && (
                  <button
                    type="button"
                    onClick={onClearAnnotation}
                    className="ml-0.5 hover:opacity-70 transition-opacity"
                    title={t('removeDrawing')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </span>
            </div>
          )}

          {/* Pending attachment chips */}
          {pendingAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pendingAttachments.map((att) => (
                <span
                  key={att.assetId}
                  className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted/40 border border-border/50 rounded-md text-xs text-foreground"
                >
                  <Paperclip className="w-3 h-3 text-muted-foreground" />
                  <span className="truncate max-w-[120px]">{att.fileName}</span>
                  {onRemoveAttachment && (
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(att.assetId)}
                      className="text-muted-foreground hover:text-foreground ml-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {/* Frame.io-style inline range chip. Sits just above the
                textarea; clicking the X clears both in and out so the
                comment becomes project-level. The chip itself is not
                clickable beyond that — it's purely a status indicator. */}
            {timestampLabel && !currentVideoRestricted && (
              <div className="self-start inline-flex items-center gap-1 rounded-md bg-warning-visible px-1.5 py-0.5 text-[11px] font-mono font-semibold text-warning">
                <Clock className="w-3 h-3 shrink-0" />
                <span className="tabular-nums">
                  {timestampLabel}
                  {timecodeEndLabel ? ` - ${timecodeEndLabel}` : ''}
                </span>
                <button
                  type="button"
                  onClick={onClearTimestamp}
                  className="ml-0.5 -mr-0.5 p-0.5 rounded hover:bg-warning/20 opacity-70 hover:opacity-100 transition-opacity"
                  title={t('clearTimestamp')}
                  aria-label={t('clearTimestamp')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            <Textarea
              placeholder={t('typeMessage')}
              value={newComment}
              onChange={(e) => onCommentChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={onInputFocus}
              className="resize-none"
              rows={2}
            />
            <div className="flex items-center justify-between gap-2 min-w-0">
              {annotationCtx?.isDrawingMode ? (
                // Drawing mode: replace the icon row with the inline toolbar.
                <AnnotationToolbarInline />
              ) : (
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                {/* Sibling icons fade out while the voice recorder is
                    active so the recorder UI gets the whole row. We
                    keep them mounted (just hidden) so their state isn't
                    lost — restoring them feels instant when the user
                    cancels the recording. */}
                {onStartDrawing && !isVoiceActive && (
                  <Button
                    type="button"
                    onClick={onStartDrawing}
                    variant={pendingAnnotation ? 'default' : 'outline'}
                    size="icon"
                    className="h-8 w-8 flex-shrink-0"
                    title={t('drawOnVideo')}
                    disabled={loading}
                  >
                    <PenTool className="w-4 h-4" />
                  </Button>
                )}
                {allowClientAssetUpload && selectedVideoIdProp && onAttachmentAdded && !isVoiceActive && (
                  <CommentAttachmentButton
                    videoId={selectedVideoIdProp}
                    shareToken={shareToken}
                    onAttachmentAdded={onAttachmentAdded}
                    onUploadError={onAttachmentErrorChange}
                    disabled={loading}
                    maxFiles={maxCommentAttachments}
                  />
                )}
                {allowClientAssetUpload && selectedVideoIdProp && onAttachmentAdded && (
                  <VoiceRecorderButton
                    videoId={selectedVideoIdProp}
                    shareToken={shareToken || null}
                    onAttachmentAdded={onAttachmentAdded}
                    disabled={loading}
                    onActiveChange={setIsVoiceActive}
                  />
                )}
              </div>
              )}
              <Button
                onClick={submitWithAutoFinish}
                variant="default"
                disabled={!canSubmit && !annotationCtx?.isDrawingMode}
                size="icon"
                className="h-8 w-8 shrink-0"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
          {(attachmentError || attachmentNotice) && (
            <p className={`mt-2 text-xs ${attachmentError ? 'text-destructive' : 'text-muted-foreground'}`}>
              {attachmentError || attachmentNotice}
            </p>
          )}

          {isNameRequired ? (
            <p className="text-xs text-warning mt-2">
              {t('selectNameFirst')}
            </p>
          ) : (
            <div className="mt-2 flex flex-row items-center justify-between gap-2 min-w-0">
              {/* Hide the verbose keyboard hint on narrow sidebars (the
                  Shortcuts button covers the same ground). It comes back
                  at 2xl where there's room for both. */}
              <p className="text-xs text-muted-foreground hidden 2xl:block truncate">
                {t('enterToSend')}
              </p>
              {showShortcutsButton && onShowShortcuts && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onShowShortcuts}
                  className="ml-auto hidden lg:inline-flex shrink-0"
                >
                  <Keyboard className="w-4 h-4 lg:mr-2" />
                  <span className="hidden lg:inline">{t('shortcuts')}</span>
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
