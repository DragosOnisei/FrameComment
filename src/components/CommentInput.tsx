'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Send, X, Paperclip, Pencil, PenTool } from 'lucide-react'
import { formatCommentTimestamp, secondsToTimecode } from '@/lib/timecode'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import CommentAttachmentButton from './CommentAttachmentButton'
import VoiceRecorderButton from './VoiceRecorderButton'
import AnnotationToolbarInline from './AnnotationToolbarInline'
import EmojiPicker from './EmojiPicker'
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

  // 1.1.1+: ref + native input listener to catch OS-level insertions
  // that React's synthetic `onChange` misses. macOS Sequoia's Apple
  // Intelligence emoji picker writes the emoji directly to the DOM
  // (skipping React's event tracking), so the very next controlled-
  // input re-render restores the previous `value` and the emoji is
  // gone. By listening on the raw element we get the new value
  // *before* React's render cycle can wipe it.
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Keep the latest `newComment` in a ref so the native listener
  // closure stays valid across renders without re-binding on every
  // keystroke.
  const newCommentRef = useRef(newComment)
  useEffect(() => {
    newCommentRef.current = newComment
  }, [newComment])
  // 1.1.1+: insert text (an emoji, but generic) at the current
  // caret position. Used by the in-app emoji picker to side-step
  // the Chrome+Sequoia bug where the OS emoji picker doesn't
  // dispatch any events on `<textarea>`.
  const insertAtCursor = (text: string) => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const before = el.value.slice(0, start)
    const after = el.value.slice(end)
    const next = before + text + after
    onCommentChange(next)
    // Restore focus + caret after the next render. Without
    // `requestAnimationFrame` React would set `value` AFTER our
    // setSelectionRange call, which would reset the caret to the
    // end.
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      try {
        el.setSelectionRange(pos, pos)
      } catch {
        /* Some browsers throw on programmatic setSelectionRange
           when the element isn't fully reflowed yet. Best-effort
           is fine — the caret just lands at the end. */
      }
    })
  }

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const sync = () => {
      const v = el.value
      // Only push if the DOM diverges from React state — otherwise
      // every keystroke would fire onCommentChange twice (once via
      // React onChange, once here) and double-trigger
      // handleCommentChange side-effects (auto-pause / capture
      // timestamp).
      if (v !== newCommentRef.current) {
        onCommentChange(v)
      }
    }
    // `input` covers regular typing + most OS insertions.
    // `compositionend` covers IME (Chinese / Japanese / etc.).
    // `beforeinput` fires earliest and is the only event that the
    // macOS Sequoia Apple Intelligence emoji picker reliably emits
    // — we schedule the sync on the next tick so the DOM has
    // actually been updated by the time we read `el.value`.
    const syncSoon = () => {
      // microtask + raf double-bounce so we land after WHATEVER the
      // OS is doing — synchronous insert, async paste, IME commit,
      // whatever. Cheap, fires at most a couple of times per insert.
      Promise.resolve().then(sync)
      requestAnimationFrame(sync)
    }
    el.addEventListener('input', sync)
    el.addEventListener('compositionend', sync)
    el.addEventListener('beforeinput', syncSoon)
    el.addEventListener('paste', syncSoon)
    return () => {
      el.removeEventListener('input', sync)
      el.removeEventListener('compositionend', sync)
      el.removeEventListener('beforeinput', syncSoon)
      el.removeEventListener('paste', syncSoon)
    }
  }, [onCommentChange])

  if (commentsDisabled) {
    // 1.0.9+: the Shortcuts button was removed app-wide, so there's
    // nothing left to render here once comments are disabled.
    return null
  }

  // Check if name selection is required but not provided
  const isNameRequired = showAuthorInput && namedRecipients.length > 0 && nameSource === 'none'
  const hasAttachments = pendingAttachments.length > 0
  const canSubmit = !loading && (newComment.trim() || hasAttachments || pendingAnnotation) && !isNameRequired
  // 1.2.0+: the chip stays visible at all times — when the input
  // hasn't been focused yet (and therefore there's no captured IN
  // point), we render the LIVE playhead so the composer reads
  // "[12:34] Leave your comment..." in sync with the player. Once the
  // user focuses the input we freeze on the captured IN point.
  const [livePlayheadSeconds, setLivePlayheadSeconds] = useState(0)
  useEffect(() => {
    const onTime = (e: Event) => {
      const detail = (e as CustomEvent).detail as { time?: number; videoId?: string } | undefined
      if (!detail || typeof detail.time !== 'number') return
      // Filter by selected video so a comparison player on another
      // video doesn't drive our chip.
      if (selectedVideoIdProp && detail.videoId && detail.videoId !== selectedVideoIdProp) return
      setLivePlayheadSeconds(detail.time)
    }
    window.addEventListener('videoTimeUpdated', onTime as EventListener)
    return () => window.removeEventListener('videoTimeUpdated', onTime as EventListener)
  }, [selectedVideoIdProp])

  const hasCapturedTimestamp =
    selectedTimestamp !== null && selectedTimestamp !== undefined
  const chipSeconds = hasCapturedTimestamp ? selectedTimestamp! : livePlayheadSeconds
  const timestampLabel = formatCommentTimestamp({
    timecode: secondsToTimecode(Math.max(0, chipSeconds), selectedVideoFps),
    fps: selectedVideoFps,
    videoDurationSeconds: selectedVideoDurationSeconds,
    mode: timestampDisplayMode,
  })

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

          {/*
            1.2.0+: Frame.io-style single-row composer.
            The wrapper is the only visible card; the textarea inside has
            no border / no background of its own so the timestamp chip
            and the placeholder/text live on the same continuous line.
            The action row sits below within the same wrapper, separated
            only by spacing — no internal divider, no double-box look.
          */}
          <div className="rounded-lg border border-border bg-transparent px-3 py-2 focus-within:border-primary/60 transition-colors">
            <div className="flex items-start gap-2 min-w-0">
              {!currentVideoRestricted && (
                // 1.2.0+: Inline timestamp chip — Frame.io-style, ALWAYS
                // visible (even before the input is focused) so the
                // composer reads "[00:00] Leave your comment…" at idle.
                // The X button only appears once the user has actually
                // captured an IN point, since clearing a non-existent
                // selection is a no-op.
                <div className="self-start inline-flex items-center gap-1 rounded-md bg-warning-visible px-1.5 py-0.5 text-[11px] font-mono font-semibold text-warning shrink-0 mt-[2px]">
                  <span className="tabular-nums">
                    {timestampLabel}
                    {timecodeEndLabel ? ` - ${timecodeEndLabel}` : ''}
                  </span>
                  {hasCapturedTimestamp && (
                    <button
                      type="button"
                      onClick={onClearTimestamp}
                      className="ml-0.5 -mr-0.5 p-0.5 rounded hover:bg-warning/20 opacity-70 hover:opacity-100 transition-opacity"
                      title={t('clearTimestamp')}
                      aria-label={t('clearTimestamp')}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
              {/*
                1.2.0+: overlay an animated shimmer placeholder on top
                of the textarea. Native `::placeholder` can't be
                gradient-animated reliably, so we render our own text
                in a sibling element and hide the textarea's built-in
                placeholder. It disappears as soon as the user starts
                typing.
              */}
              <div className="relative flex-1 min-w-0">
                <Textarea
                  ref={textareaRef}
                  placeholder=""
                  value={newComment}
                  onChange={(e) => onCommentChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onFocus={onInputFocus}
                  className="resize-none min-h-0 border-0 bg-transparent rounded-none px-0 py-0 ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none w-full leading-snug"
                  rows={1}
                />
                {!newComment && (
                  <span
                    aria-hidden="true"
                    className="placeholder-shimmer pointer-events-none absolute inset-0 select-none text-sm leading-snug"
                  >
                    {t('typeMessage')}
                  </span>
                )}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 min-w-0">
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
                  // 1.2.0+: match the borderless mic/emoji style so the
                  // whole input action row reads as one unified strip
                  // (no card-on-card look). Active state (pending
                  // annotation) tinted with the primary color instead
                  // of using the filled `default` variant.
                  <button
                    type="button"
                    onClick={onStartDrawing}
                    disabled={loading}
                    title={t('drawOnVideo')}
                    aria-label={t('drawOnVideo')}
                    className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      pendingAnnotation
                        ? 'bg-primary/15 text-primary hover:bg-primary/20'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                  >
                    <PenTool className="w-4 h-4" />
                  </button>
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
                {/* In-app emoji picker (1.1.1+). Side-steps the
                    Chrome+Sequoia bug where the system Apple
                    Intelligence picker doesn't fire any events on
                    <textarea>. Always shown — works for everyone
                    regardless of OS/browser. */}
                {!isVoiceActive && (
                  <EmojiPicker
                    onSelect={(emoji) => insertAtCursor(emoji)}
                    disabled={loading}
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
            // 1.0.9+: Shortcuts button removed — only the keyboard
            // hint remains, and only on wide (2xl) sidebars.
            <div className="mt-2 hidden 2xl:block min-w-0">
              <p className="text-xs text-muted-foreground truncate">
                {t('enterToSend')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
