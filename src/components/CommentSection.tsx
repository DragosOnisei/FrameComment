'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Comment, Video } from '@prisma/client'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { CheckCircle2, MessageSquare, MessagesSquare, ClipboardCopy, ClipboardPaste, ChevronDown, ChevronUp, PanelRightClose, Pencil, Check, Trash2, X as XIcon, Send } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import MessageBubble from './MessageBubble'
import CommentInput from './CommentInput'
import CommentsKebabMenu from './CommentsKebabMenu'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { formatDate } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import { getClientId } from '@/lib/client-id'
import { logError } from '@/lib/logging'
import { formatCommentTimestamp, secondsToTimecode, timecodeToSeconds, timecodeToSeekSeconds } from '@/lib/timecode'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  getClippedComments,
  hasClippedComments,
  setClippedComments,
  CLIPBOARD_CHANGED_EVENT,
  type ClippedComment,
} from '@/lib/comments-clipboard'
import { pasteClippedThreads } from '@/lib/comments-paste'
import { emoticonOnChange } from '@/lib/emoticons'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

interface CommentSectionProps {
  projectId: string
  projectSlug?: string
  comments: CommentWithReplies[]
  focusCommentId?: string | null
  clientName: string
  clientEmail?: string
  restrictToLatestVersion?: boolean
  videos?: Video[]
  isAdminView?: boolean
  smtpConfigured?: boolean
  isPasswordProtected?: boolean
  adminUser?: any
  recipients?: Array<{ id: string; name: string | null; email: string | null }>
  shareToken?: string | null
  showShortcutsButton?: boolean
  timestampDisplayMode?: 'TIMECODE' | 'AUTO'
  mobileCollapsible?: boolean
  initialMobileCollapsed?: boolean
  authenticatedEmail?: string | null
  allowClientAssetUpload?: boolean
  maxCommentAttachments?: number
  onToggleVisibility?: () => void
  showToggleButton?: boolean
  onMobileExpandedChange?: (expanded: boolean) => void
  /** Per-client session id used to authorise self-edit on the share page. */
  clientSessionId?: string | null
}

// 3.8.x: GLOBAL guest-name key (not scoped to a project). The chosen
// review name is mirrored here so it follows the reviewer across EVERY
// project — set it once, never retype it on the next share link.
const GLOBAL_GUEST_NAME_LS_KEY = 'framecomment:guest-name'

/**
 * 1.3.2+: lightweight inline reply input rendered inside MessageBubble.
 * Owns its own draft text + submit state so the user can keep typing a
 * top-level comment in the global CommentInput without colliding.
 */
function InlineReplyForm({
  placeholder,
  onSubmit,
  onCancel,
  initialText = '',
}: {
  placeholder: string
  onSubmit: (text: string) => Promise<void> | void
  onCancel: () => void
  /** 6.15.2: pre-typed "@Name " when answering a specific reply. */
  initialText?: string
}) {
  const [text, setText] = useState(initialText)
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autofocus on mount so the keyboard pops up immediately on phones
  // (and on desktop the cursor lands in the input straight away).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // Slight delay so iOS Safari doesn't fight us on focus.
    const t = setTimeout(() => {
      el.focus()
      // With a "@Name " prefill the caret must land AFTER it — focus() alone
      // selects nothing and leaves it at position 0, so the first keystroke
      // would type in front of the mention.
      const end = el.value.length
      el.setSelectionRange(end, end)
    }, 50)
    return () => clearTimeout(t)
  }, [])

  // Auto-grow the textarea up to ~30 % of the viewport.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxHeight = Math.max(80, Math.floor(window.innerHeight * 0.3))
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [text])

  const handleSend = async () => {
    const trimmed = text.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(trimmed)
      setText('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // 7.3.4: `accent-panel` instead of a flat `bg-card` with a grey ring. The
    // reply box was the one surface in the comments panel that ignored the
    // workspace accent — dark grey in a blue workspace and dark grey in a brown
    // one. The ring comes from the utility's box-shadow, so `ring-border` goes.
    <div className="accent-panel rounded-lg backdrop-blur-sm p-2">
      <textarea
        ref={textareaRef}
        value={text}
        // 7.3.4: same faces here as in the main composer. Writing a reply is
        // writing a comment; having `:)` convert in one box and not the other
        // would read as a bug in whichever one the user tried second.
        onChange={(e) => emoticonOnChange(e.currentTarget, setText)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void handleSend()
          } else if (e.key === 'Escape') {
            onCancel()
          }
        }}
        placeholder={placeholder}
        rows={1}
        maxLength={6000}
        className="w-full resize-none border-0 bg-transparent text-base sm:text-sm leading-snug placeholder:text-muted-foreground focus:outline-none px-1"
      />
      <div className="flex items-center justify-end gap-2 mt-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={submitting || !text.trim()}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/**
 * 6.22.0 — only carry an annotation the server will actually accept.
 *
 * `annotationDataSchema` requires `version: 1` and at least one shape, and a
 * rejected field fails the WHOLE request. So a comment whose drawing was stored
 * by an older build, or whose shapes array ended up empty, would come back as a
 * 400 and be dropped from the paste entirely. Losing a drawing is a shame;
 * losing the note it belonged to is a bug, so the drawing is what gives way.
 *
 * Module scope, not component scope: it depends on nothing but its argument, and
 * defining it inside the component would make `toClipped` a new value on every
 * render and drag every hook that uses it into re-running.
 */
function carryableAnnotations(raw: any) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.version !== 1) return null
  if (!Array.isArray(raw.shapes) || raw.shapes.length === 0) return null
  return raw
}

export default function CommentSection({
  projectId,
  projectSlug: _projectSlug,
  comments: initialComments,
  focusCommentId = null,
  clientName,
  clientEmail,
  restrictToLatestVersion = false,
  videos = [],
  isAdminView = false,
  smtpConfigured: _smtpConfigured = false,
  isPasswordProtected = false,
  adminUser = null,
  recipients = [],
  shareToken = null,
  showShortcutsButton = false,
  timestampDisplayMode = 'TIMECODE',
  mobileCollapsible = false,
  initialMobileCollapsed = false,
  authenticatedEmail = null,
  allowClientAssetUpload = false,
  maxCommentAttachments,
  onToggleVisibility,
  showToggleButton = false,
  onMobileExpandedChange,
  clientSessionId = null,
}: CommentSectionProps) {
  const t = useTranslations('comments')
  const tCommon = useTranslations('common')
  const [isMobileCollapsed, setIsMobileCollapsed] = useState(initialMobileCollapsed)
  const {
    comments,
    newComment,
    selectedTimestamp,
    selectedVideoId,
    selectedVideoFps,
    loading,
    replyingToCommentId,
    authorName,
    nameSource,
    selectedRecipientId,
    namedRecipients,
    isOtpAuthenticated,
    pendingAttachments,
    attachmentError,
    attachmentNotice,
    pendingAnnotation,
    selectedTimecodeEnd,
    handleCommentChange,
    handleCommentInputFocus,
    handleSubmitComment,
    handleReply,
    submitInlineReply,
    handleCancelReply,
    handleClearTimestamp,
    handleDeleteComment,
    setAuthorName,
    handleNameSourceChange,
    handleAttachmentAdded,
    handleRemoveAttachment,
    takePendingForEdit,
    handleAttachmentErrorChange,
    handleStartDrawing,
    handleClearAnnotation,
    handleSetTimecodeEnd,
    handleClearTimecodeEnd,
  } = useCommentManagement({
    projectId,
    initialComments,
    videos,
    clientEmail,
    isPasswordProtected,
    adminUser,
    recipients,
    clientName,
    restrictToLatestVersion,
    shareToken,
    useAdminAuth: isAdminView,
    authenticatedEmail,
  })

  // Auto-scroll to latest comment (like messaging apps)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [localComments, setLocalComments] = useState<CommentWithReplies[]>(initialComments)

  // 1.3.2+: on mobile the comment input is `position: fixed bottom-0` so
  // it's always flush with the device viewport edge (independent of the
  // surrounding Card/padding chain). We measure its rendered height with
  // a ResizeObserver and mirror it as bottom padding on the messages
  // list, so the last comment never hides behind the input — and the
  // padding grows naturally when the input wraps to multiple lines or
  // an attachment/voice row appears. On lg+ we revert to the natural
  // flex layout (desktop input is in the column) so the padding is not
  // applied — tracked via a matchMedia listener.
  const mobileInputWrapperRef = useRef<HTMLDivElement>(null)
  const [mobileInputHeight, setMobileInputHeight] = useState(160)
  const [isBelowLg, setIsBelowLg] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia('(max-width: 1023.98px)')
    const apply = (m: MediaQueryList | MediaQueryListEvent) =>
      setIsBelowLg('matches' in m ? m.matches : (m as MediaQueryList).matches)
    apply(mql)
    mql.addEventListener('change', apply as (e: MediaQueryListEvent) => void)
    return () =>
      mql.removeEventListener('change', apply as (e: MediaQueryListEvent) => void)
  }, [])
  useEffect(() => {
    if (!mobileCollapsible) return
    const el = mobileInputWrapperRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height
      if (h > 0) setMobileInputHeight(Math.round(h))
    })
    ro.observe(el)
    // Also capture the initial size synchronously so the first paint
    // already has the right padding (avoids a flash where the last
    // comment sits under the input for ~1 frame).
    const initial = el.getBoundingClientRect().height
    if (initial > 0) setMobileInputHeight(Math.round(initial))
    return () => ro.disconnect()
  }, [mobileCollapsible])

  // ─────────────── Edit-mode range tracking ───────────────
  // When the user clicks Edit on a saved comment, MessageBubble fires
  // `commentEditStart`. We mirror the comment's existing in/out range
  // onto the timeline (via the same `commentRangeStateChanged` event the
  // composer uses) so the user can drag the OUT handle to adjust the
  // duration as part of the edit. Drags arrive as `setCommentOutPoint`
  // events; while edit-mode is active we pipe them into a ref instead
  // of the composer's selectedTimecodeEnd, and on save we PATCH the
  // ref's current timecodeEnd alongside the new content.
  const editingCommentRef = useRef<{
    id: string
    inSeconds: number
    outSeconds: number | null
    fps: number
    videoId: string
  } | null>(null)
  const editingCommentEndTimecodeRef = useRef<string | null>(null)
  /**
   * 6.16.0: which comment is open for editing, tracked independently of the
   * range bookkeeping above.
   *
   * `editingCommentRef` is only populated once the timecode parses — it exists
   * to paint a range on the timeline, so bailing out on a comment without a
   * usable one is correct for its purpose. But routing a drawing to the right
   * comment must not inherit that condition: a comment with an odd or missing
   * timecode would silently lose the annotation, with no error anywhere.
   */
  const editingCommentIdRef = useRef<string | null>(null)
  // The same fact as state, because the composer has to re-render when an edit
  // opens so it can say where a drawing will land.
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)

  useEffect(() => {
    const onEditStart = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      // Recorded first, unconditionally — see `editingCommentIdRef`.
      editingCommentIdRef.current = detail.commentId ?? null
      setEditingCommentId(detail.commentId ?? null)
      const tc: string | undefined = detail.timecode
      const tcEnd: string | null = detail.timecodeEnd ?? null
      const vid: string | undefined = detail.videoId
      if (!tc || !vid) return
      const video = videos.find((v: any) => v.id === vid)
      const fps = video?.fps || 24
      let inSec = 0
      let outSec: number | null = null
      try {
        inSec = timecodeToSeconds(tc, fps)
        outSec = tcEnd ? timecodeToSeconds(tcEnd, fps) : null
      } catch {
        return
      }
      editingCommentRef.current = {
        id: detail.commentId,
        inSeconds: inSec,
        outSeconds: outSec,
        fps,
        videoId: vid,
      }
      editingCommentEndTimecodeRef.current = tcEnd
      // Paint the comment's range on the timeline. Same event the
      // composer uses, so CustomVideoControls picks it up automatically.
      window.dispatchEvent(
        new CustomEvent('commentRangeStateChanged', {
          detail: { inTime: inSec, outTime: outSec, videoId: vid },
        })
      )
    }
    const onEditEnd = () => {
      editingCommentRef.current = null
      editingCommentEndTimecodeRef.current = null
      editingCommentIdRef.current = null
      setEditingCommentId(null)
      // Clear the timeline range. The hook's own commentRangeStateChanged
      // emitter will repaint the composer range (if any) on its next tick.
      window.dispatchEvent(
        new CustomEvent('commentRangeStateChanged', {
          detail: { inTime: null, outTime: null },
        })
      )
    }
    const onSetOut = (e: Event) => {
      // While we're editing a comment, intercept timeline drags and
      // route them to the edit ref instead of letting the composer
      // hook handle them. We also re-emit commentRangeStateChanged so
      // the timeline keeps the OUT handle in sync.
      if (!editingCommentRef.current) return
      const detail = (e as CustomEvent).detail || {}
      const time = detail.time
      if (typeof time !== 'number' || !Number.isFinite(time)) return
      const cur = editingCommentRef.current
      const safeOut = Math.max(time, cur.inSeconds + 0.05)
      cur.outSeconds = safeOut
      editingCommentEndTimecodeRef.current = secondsToTimecode(safeOut, cur.fps)
      window.dispatchEvent(
        new CustomEvent('commentRangeStateChanged', {
          detail: {
            inTime: cur.inSeconds,
            outTime: safeOut,
            videoId: cur.videoId,
          },
        })
      )
      // Stop the event from also reaching the composer hook (which
      // would otherwise mutate its own selectedTimecodeEnd state).
      e.stopImmediatePropagation()
    }
    // Use capture phase so we run BEFORE the hook's own setCommentOutPoint
    // listener (registered on `window`, default bubble phase).
    window.addEventListener('commentEditStart', onEditStart as EventListener)
    window.addEventListener('commentEditCancel', onEditEnd as EventListener)
    window.addEventListener('setCommentOutPoint', onSetOut as EventListener, true)
    return () => {
      window.removeEventListener('commentEditStart', onEditStart as EventListener)
      window.removeEventListener('commentEditCancel', onEditEnd as EventListener)
      window.removeEventListener('setCommentOutPoint', onSetOut as EventListener, true)
    }
  }, [videos])

  // Fetch comments function (only used for event-triggered updates)
  const fetchComments = useCallback(async () => {
    try {
      const response = isAdminView
        ? await apiFetch(`/api/comments?projectId=${projectId}`)
        : shareToken
          ? await fetch(`/api/comments?projectId=${projectId}`, {
              headers: { Authorization: `Bearer ${shareToken}` },
            })
          : null

      if (!response) return

      if (response.ok) {
        const freshComments = await response.json()
        setLocalComments(freshComments)
      }
    } catch (error) {
      // Silent fail - keep showing existing comments
    }
  }, [isAdminView, projectId, shareToken])

  /**
   * Edit a comment. Sends PATCH /api/comments/[id] using either the admin
   * cookie auth (admin view) or the share token (client view). On success,
   * dispatches a `commentDeleted` event — its name is generic enough to
   * cover any state-changing comment update; both `CommentSection` and
   * `SharePageClient` listen to it and refetch comments, which propagates
   * the new content into the comment-management hook.
   */
  // 1.2.0+: shared headers builder so the new resolve / reactions calls
  // pick up the admin token OR the share bearer + client-id automatically.
  const buildAuthedHeaders = useCallback(
    (extra?: Record<string, string>): HeadersInit => ({
      'Content-Type': 'application/json',
      ...(shareToken && !isAdminView ? { Authorization: `Bearer ${shareToken}` } : {}),
      ...(!isAdminView ? { 'X-Framecomment-Client-Id': getClientId() } : {}),
      ...extra,
    }),
    [isAdminView, shareToken],
  )

  /**
   * 1.2.0+: toggle resolved state on a comment. The endpoint returns the
   * full sanitized comment, but we just refetch the list so any other
   * tabs see the change too.
   */
  const handleResolveToggle = useCallback(
    async (commentId: string, nextResolved: boolean) => {
      const url = `/api/comments/${commentId}/resolve`
      const body = JSON.stringify({ isResolved: nextResolved })
      const response = isAdminView
        ? await apiFetch(url, { method: 'PATCH', headers: buildAuthedHeaders(), body })
        : await fetch(url, { method: 'PATCH', headers: buildAuthedHeaders(), body })
      if (!response.ok) {
        // 2.2.6+: pull the server's error message into the thrown
        // Error so the catch in `MessageBubble.handleResolveToggle`
        // can show the user WHY the toggle failed — not just a
        // generic HTTP code. Common cases:
        //   - 401: session expired (admin) / share token invalid (client)
        //   - 403: guest viewer trying to resolve (allowGuest=false)
        //   - 404: comment was deleted under us
        //   - 429: rate-limited (30/min per browser)
        let serverMessage = ''
        try {
          const payload = await response.json()
          serverMessage = payload?.error || ''
        } catch {
          // No JSON body — keep the generic HTTP code below.
        }
        throw new Error(
          serverMessage
            ? `${serverMessage} (HTTP ${response.status})`
            : `Failed to toggle resolved (HTTP ${response.status})`,
        )
      }
      await fetchComments()
      // 2.2.6+: notify the parent page (SharePageClient / admin
      // share page) that comment state changed so it refetches via
      // its own hook. Without this, the resolve flips in the DB
      // and in our internal `localComments`, but the render keeps
      // using the parent's `comments` prop (line 844 picks
      // `comments` when its length > 0) — leaving the badge stale
      // until the user hits F5. Edit + delete already dispatch the
      // same event; resolve was the odd one out.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('commentDeleted'))
      }
    },
    [isAdminView, buildAuthedHeaders, fetchComments],
  )

  /**
   * 1.2.0+: toggle an emoji reaction on a comment. The server treats
   * duplicate calls from the same viewer as a toggle (idempotent on
   * (commentId, sessionId, emoji)) so the UI doesn't need to track the
   * prior state.
   */
  const handleReact = useCallback(
    async (commentId: string, emoji: string) => {
      const url = `/api/comments/${commentId}/reactions`
      const body = JSON.stringify({ emoji, toggle: true })
      const response = isAdminView
        ? await apiFetch(url, { method: 'POST', headers: buildAuthedHeaders(), body })
        : await fetch(url, { method: 'POST', headers: buildAuthedHeaders(), body })
      if (!response.ok) {
        throw new Error(`Failed to react (HTTP ${response.status})`)
      }
      await fetchComments()
    },
    [isAdminView, buildAuthedHeaders, fetchComments],
  )

  // 3.5.0+: "Send to editor" — signals the video's uploader (the
  // editor) that there's new feedback to review, creating a live bell
  // notification for them. Lives in the comments header in both the
  // admin review view and the client share view; the server resolves
  // the recipient and gates self-notifications, so this handler just
  // fires and reflects the outcome inline on the button.
  // 4.3.x: the manual "Send to editor" button is retired — reviewers kept
  // forgetting to press it, so the editor is now notified automatically on the
  // FIRST comment of a round (server-side, in /api/comments). We keep the
  // button's handler + renderer intact behind this flag so it's a one-line flip
  // to bring it back if ever needed.
  const SEND_TO_EDITOR_BUTTON_ENABLED = false
  type SendState = 'idle' | 'sending' | 'sent' | 'noeditor' | 'self' | 'error'
  const [sendState, setSendState] = useState<SendState>('idle')
  const sendResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSendToEditor = useCallback(async () => {
    if (!selectedVideoId || sendState === 'sending') return
    if (sendResetRef.current) clearTimeout(sendResetRef.current)
    setSendState('sending')
    const actorName = isAdminView
      ? adminUser?.name || null
      : authorName || clientName || null
    const url = `/api/videos/${selectedVideoId}/notify-editor`
    const body = JSON.stringify({ actorName })
    try {
      const response = isAdminView
        ? await apiFetch(url, { method: 'POST', headers: buildAuthedHeaders(), body })
        : await fetch(url, { method: 'POST', headers: buildAuthedHeaders(), body })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json().catch(() => ({}))
      if (data?.reason === 'no_editor') setSendState('noeditor')
      else if (data?.reason === 'self') setSendState('self')
      else setSendState('sent')
    } catch {
      setSendState('error')
    } finally {
      sendResetRef.current = setTimeout(() => setSendState('idle'), 2600)
    }
  }, [
    selectedVideoId,
    sendState,
    isAdminView,
    adminUser,
    authorName,
    clientName,
    buildAuthedHeaders,
  ])

  // Render helper so both the desktop and mobile comment headers show
  // an identical "Send to editor" control with inline state feedback.
  const renderSendToEditor = (extraClass = '') => {
    const map: Record<SendState, { label: string; cls: string; icon: 'send' | 'check' | 'x' }> = {
      idle: {
        label: 'Send to editor',
        cls: 'bg-primary/15 text-primary ring-primary/30 hover:bg-primary/25',
        icon: 'send',
      },
      sending: {
        label: 'Sending…',
        cls: 'bg-primary/10 text-primary/70 ring-primary/20 cursor-wait',
        icon: 'send',
      },
      sent: {
        label: 'Sent',
        cls: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30',
        icon: 'check',
      },
      self: {
        label: 'Your upload',
        cls: 'bg-white/5 text-white/60 ring-white/10',
        icon: 'x',
      },
      noeditor: {
        label: 'No editor assigned',
        cls: 'bg-white/5 text-white/60 ring-white/10',
        icon: 'x',
      },
      error: {
        label: 'Try again',
        cls: 'bg-red-500/15 text-red-400 ring-red-500/30',
        icon: 'x',
      },
    }
    const s = map[sendState]
    return (
      <button
        type="button"
        onClick={handleSendToEditor}
        disabled={sendState === 'sending' || !selectedVideoId}
        title="Notify the editor that there's new feedback"
        className={cn(
          'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium ring-1 transition-colors whitespace-nowrap disabled:opacity-70',
          s.cls,
          extraClass,
        )}
      >
        {s.icon === 'send' && <Send className="w-3.5 h-3.5" />}
        {s.icon === 'check' && <Check className="w-3.5 h-3.5" />}
        {s.icon === 'x' && <XIcon className="w-3.5 h-3.5" />}
        <span>{s.label}</span>
      </button>
    )
  }

  // 1.2.0+: ownership check used everywhere we surface Edit / Delete on
  // a guest's own comment. The server prefers the per-browser id
  // (`client:<uuid>`) over the share-token session id, so two devices
  // sharing one link have distinct identities. We accept either form so
  // legacy comments still match.
  const isMyComment = useCallback(
    (commentOrReply: any): boolean => {
      const sid = commentOrReply?.editorSessionId
      if (!sid || typeof sid !== 'string') return false
      if (typeof window === 'undefined') return false
      const myClientId = `client:${getClientId()}`
      if (sid === myClientId) return true
      if (clientSessionId && sid === clientSessionId) return true
      return false
    },
    [clientSessionId],
  )

  // 2.2.6+: comments filter dropdown — three discrete states the
  // user picks by tapping the section title.
  //   - 'all':        every comment (default)
  //   - 'incomplete': only NOT-resolved comments
  //   - 'completed':  only resolved comments (a "what got Done" view)
  // Persists to localStorage per project so flipping one project's
  // filter doesn't leak into another. Default is 'all' — most users
  // want to see the whole list when they enter a project.
  type CommentsFilter = 'all' | 'incomplete' | 'completed'
  const [commentsFilter, setCommentsFilterState] = useState<CommentsFilter>('all')
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  // 2.5.1+: trigger ref + viewport-fixed coords so we can portal
  // the dropdown to document.body. Backdrop-filter on the parent
  // CommentSection card forms a backdrop root that prevents an
  // in-place popover from sampling the real page behind — the
  // portal sidesteps every ancestor.
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const [filterMenuCoords, setFilterMenuCoords] = useState<{
    left: number
    top: number
  } | null>(null)
  useEffect(() => {
    if (!filterMenuOpen) return
    const compute = () => {
      const el = filterTriggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // Below the trigger, aligned to its left edge, clamped 8 px
      // from the right viewport edge for narrow layouts.
      setFilterMenuCoords({
        left: Math.max(8, Math.min(window.innerWidth - 240, rect.left)),
        top: rect.bottom + 6,
      })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [filterMenuOpen])
  // 3.9.x: the comment filter is per-VIDEO and NON-STICKY. Every time the
  // user opens a different video (or switches version), the list snaps
  // back to "All comments". Previously the choice persisted per-project
  // in localStorage — which is what made a freshly-left comment look like
  // it "vanished" (it landed on the timeline, but the list was still
  // filtered to Completed and hid the new, unresolved comment). Resetting
  // on every video change guarantees the comment you just wrote is
  // visible. The user can still narrow the CURRENT video to
  // Incomplete/Completed for as long as they stay on it.
  useEffect(() => {
    setCommentsFilterState('all')
  }, [selectedVideoId])
  const setCommentsFilter = useCallback((next: CommentsFilter) => {
    setCommentsFilterState(next)
    setFilterMenuOpen(false)
  }, [])
  // Click-outside-to-close for the filter dropdown. Both the
  // desktop header and the mobile header tag their dropdown
  // wrapper with `data-comments-filter`, so a single document
  // listener handles both surfaces without us juggling two refs.
  // Also closes on Escape so keyboard users get parity.
  useEffect(() => {
    if (!filterMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-comments-filter]')) return
      setFilterMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [filterMenuOpen])
  const commentsFilterLabel =
    commentsFilter === 'incomplete'
      ? 'Incomplete comments'
      : commentsFilter === 'completed'
        ? 'Completed comments'
        : 'All comments'

  // 1.2.0+: editable guest display name. Shown only to non-admin viewers
  // under the "Feedback & Discussion" header. Persists to localStorage so
  // the chosen name survives reloads even before any comment is posted.
  const GUEST_NAME_LS_KEY = `framecomment:guest-name:${projectId}`
  const [guestName, setGuestName] = useState<string>('')
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [savingName, setSavingName] = useState(false)

  // Derive viewer's current name from any of THEIR existing comments
  // (matched by editorSessionId) — this is what every other reader sees.
  // We don't store the chosen name on the server outside the comment
  // rows themselves; this just sources the initial display.
  useEffect(() => {
    if (isAdminView) return
    try {
      // Prefer a name already chosen for THIS project; otherwise fall
      // back to the GLOBAL name so a first-time visit to a new project
      // is pre-filled with the reviewer's usual name.
      const cached =
        window.localStorage.getItem(GUEST_NAME_LS_KEY) ||
        window.localStorage.getItem(GLOBAL_GUEST_NAME_LS_KEY)
      if (cached) {
        setGuestName(cached)
        return
      }
    } catch {
      /* localStorage might be disabled — fall through to comment-derived name */
    }
    // 1.2.0+: identifiers that may match THIS viewer's stored
    // editorSessionId on existing comments. The server prefers the
    // per-browser id (client:<uuid>) when present, otherwise falls
    // back to the share-token session id. We accept either so a
    // legacy comment posted from this browser still matches.
    const myClientId = `client:${getClientId()}`
    const isMine = (sid: unknown): boolean =>
      typeof sid === 'string' &&
      sid.length > 0 &&
      (sid === myClientId || (!!clientSessionId && sid === clientSessionId))

    // Search the raw `comments` prop (and nested replies) for any row
    // authored by this viewer, then use that name as the initial value.
    const findMine = (list: any[]): string | null => {
      for (const c of list) {
        if (isMine(c?.editorSessionId) && c?.authorName) return c.authorName
        if (Array.isArray(c?.replies)) {
          const r = findMine(c.replies)
          if (r) return r
        }
      }
      return null
    }
    const name = findMine(comments as any[])
    if (name) {
      setGuestName(name)
      return
    }
    // 1.2.0+: viewer hasn't posted yet — predict the `Client N` label
    // they'd be assigned on their next post so the field matches the
    // experience instead of showing a generic "Client". We mirror the
    // server's `buildGuestSessionIndex`:
    //   - sort by createdAt
    //   - skip admin / internal comments
    //   - skip the viewer's OWN session (it's not yet a "previous"
    //     reviewer — it's the one we're predicting for)
    //   - count distinct guest editorSessionIds in first-seen order
    // and return that count + 1.
    const seenSessions = new Set<string>()
    const walk = (list: any[]) => {
      const sorted = [...list].sort((a: any, b: any) => {
        const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0
        return ta - tb
      })
      for (const c of sorted) {
        if (c?.userId) continue // authenticated/admin (admin viewer only)
        if (c?.isInternal) continue
        const sid = c?.editorSessionId
        if (!sid) continue
        if (isMine(sid)) continue
        // Defensive: a comment authored as "Dragos" / a real name
        // shouldn't count as a numbered guest. Without this an admin
        // who posted from the share UI (no isInternal flag) would
        // bump the count and we'd predict the wrong number.
        const author = typeof c?.authorName === 'string' ? c.authorName : ''
        const looksLikeGuest = /^client(\s+\d+)?$/i.test(author.trim())
        if (!looksLikeGuest) continue
        if (!seenSessions.has(sid)) seenSessions.add(sid)
        if (Array.isArray(c?.replies)) walk(c.replies)
      }
    }
    walk(comments as any[])
    setGuestName(`Client ${seenSessions.size + 1}`)
  }, [GUEST_NAME_LS_KEY, isAdminView, clientSessionId, comments])

  // 1.2.0+: keep the comment-posting state (useCommentManagement's
  // `authorName`) in sync with the chosen guest name so a NEW comment
  // is created with that label too. Without this, only the existing
  // rows get bulk-renamed and the next post lands back as "Client N".
  useEffect(() => {
    if (isAdminView) return
    if (!guestName) return
    if (authorName === guestName) return
    setAuthorName(guestName)
  }, [isAdminView, guestName, authorName, setAuthorName])

  const handleStartRename = useCallback(() => {
    setNameDraft(guestName || '')
    setIsEditingName(true)
  }, [guestName])

  const handleCancelRename = useCallback(() => {
    setIsEditingName(false)
    setNameDraft('')
  }, [])

  const handleSaveRename = useCallback(async () => {
    const trimmed = nameDraft.trim()
    if (!trimmed) return
    try {
      setSavingName(true)
      // 1.2.0+: optimistic UI — patch every comment we recognise as
      // ours to the new name immediately, before the network roundtrip.
      // Mirrors the bulk update the server will do, so the rename
      // shows up instantly when the user hits Enter.
      setLocalComments((prev) => {
        const renameTree = (list: CommentWithReplies[]): CommentWithReplies[] =>
          list.map((c: any) => {
            const mine = isMyComment(c)
            const nextReplies = Array.isArray(c.replies)
              ? renameTree(c.replies)
              : c.replies
            return {
              ...c,
              authorName: mine ? trimmed : c.authorName,
              replies: nextReplies,
            }
          })
        return renameTree(prev)
      })
      setGuestName(trimmed)
      try {
        window.localStorage.setItem(GUEST_NAME_LS_KEY, trimmed)
        // Mirror to the global key so the name carries to other projects.
        window.localStorage.setItem(GLOBAL_GUEST_NAME_LS_KEY, trimmed)
      } catch {
        /* ignore quota errors — UI state still updates */
      }
      setIsEditingName(false)
      setNameDraft('')

      const response = await fetch('/api/comments/rename', {
        method: 'PATCH',
        headers: buildAuthedHeaders(),
        body: JSON.stringify({ projectId, newName: trimmed }),
      })
      if (!response.ok) {
        throw new Error(`Failed to rename (HTTP ${response.status})`)
      }
      await fetchComments()
    } finally {
      setSavingName(false)
    }
  }, [
    GUEST_NAME_LS_KEY,
    buildAuthedHeaders,
    fetchComments,
    isMyComment,
    nameDraft,
    projectId,
  ])

  const handleEditComment = useCallback(async (commentId: string, newContent: string) => {
    const url = `/api/comments/${commentId}`
    // Include the (possibly updated) timecodeEnd from edit-mode range
    // tracking — when the user dragged the OUT handle while editing,
    // editingCommentEndTimecodeRef holds the new value. We only attach
    // it to the PATCH body when this comment is the one being edited
    // (otherwise the ref is stale or null).
    const editingForThis =
      editingCommentRef.current && editingCommentRef.current.id === commentId
    const payload: Record<string, unknown> = { content: newContent }
    if (editingForThis) {
      payload.timecodeEnd = editingCommentEndTimecodeRef.current
    }
    // 6.16.0: fold in whatever the composer is holding.
    //
    // While a comment is open for editing, the attach and draw controls at the
    // bottom belong to it — there is only one set of them, which is the point:
    // duplicating them inside the edit box created two places to attach a file
    // and no way to tell which one a drawing was meant for.
    //
    // Scoped to the comment actually being edited. Extras must never be
    // hoovered up by an unrelated PATCH — a resolve or a rename going through
    // this path would otherwise silently swallow a drawing the user was still
    // working on.
    if (editingCommentIdRef.current === commentId) {
      const extras = takePendingForEdit(
        editingCommentRef.current?.videoId ?? selectedVideoId ?? null,
      )
      if (extras.assetIds.length > 0) {
        payload.assetIds = extras.assetIds
      }
      // Only when something was actually drawn. `undefined` is not the same as
      // null here: null tells the server to erase the existing annotation, and
      // wiping a drawing because someone fixed a typo would be unforgivable.
      if (extras.annotations) {
        payload.annotations = extras.annotations
      }
    }
    const body = JSON.stringify(payload)
    const response = isAdminView
      ? await apiFetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })
      : await fetch(url, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
            'X-Framecomment-Client-Id': getClientId(),
          },
          body,
        })
    if (!response.ok) {
      throw new Error(`Failed to edit comment (HTTP ${response.status})`)
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('commentDeleted'))
    }
    await fetchComments()
  }, [isAdminView, shareToken, fetchComments, takePendingForEdit])

  // Initialize localComments only (no polling - hook handles optimistic updates)
  useEffect(() => {
    setLocalComments(initialComments)
  }, [initialComments])

  const lastFocusedCommentRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusCommentId) return
    if (lastFocusedCommentRef.current === focusCommentId) return

    lastFocusedCommentRef.current = focusCommentId

    let attempts = 0
    const maxAttempts = 6

    // 1.3.1+: on phones the comment list sits below the video, so
    // scrolling to a comment shoves the video off-screen. Skip the
    // scroll on mobile — the player already seeks to the comment's
    // timestamp + an annotation overlay shows on the video itself,
    // which is the Frame.io behaviour the user actually wants. The
    // highlight effect still runs so it's obvious which comment
    // matched once they scroll down manually.
    const isMobile =
      typeof window !== 'undefined' && window.innerWidth < 640

    const tryScroll = () => {
      attempts += 1
      const element = document.getElementById(`comment-${focusCommentId}`)
      if (element) {
        if (!isMobile) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        // 1.9.1+: PERSISTENT glossy lift. Add .is-selected to the
        // clicked comment's card and clear it from every other one
        // — so the selection sticks until the user clicks another
        // comment, or anywhere outside the comment list. The
        // document mousedown listener installed in the effect
        // below handles those cases. .is-selected is a pure CSS
        // class with transition-colors, so the bg + border fade
        // smoothly in/out.
        document
          .querySelectorAll('.comment-card.is-selected')
          .forEach((el) => el.classList.remove('is-selected'))
        const card = element.querySelector<HTMLElement>('.comment-card')
        if (card) {
          card.classList.add('is-selected')
          // 6.14.0: a one-shot scale beat so the eye lands on the right card
          // at the end of the scroll. Removed when it finishes so re-focusing
          // the same comment later plays it again.
          card.classList.remove('is-focus-pulse')
          // Force a reflow between remove and add, otherwise the browser
          // coalesces the two and the animation never restarts.
          void card.offsetWidth
          card.classList.add('is-focus-pulse')
          const clear = () => card.classList.remove('is-focus-pulse')
          card.addEventListener('animationend', clear, { once: true })
        }
        return
      }

      if (attempts < maxAttempts) {
        setTimeout(tryScroll, 200)
      }
    }

    setTimeout(tryScroll, 100)
  }, [focusCommentId, localComments.length])

  // 1.9.1+: persistent selection management for comment cards.
  // - Click on any .comment-card → marks THAT card as selected,
  //   removes selection from the others. The user gets a sticky
  //   glossy lift on the comment they're reading.
  // - Click anywhere else (outside any card) → clears selection.
  // We attach at document level so the listener catches clicks
  // regardless of which subtree they happen in (admin view, share
  // view, etc.).
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      /**
       * 7.3.3: three places are NOT "outside the comment", even though none of
       * them is a comment card.
       *
       *   [data-comment-popover]  the note's own bead on the timeline. Clicking
       *                           it selects that note (see the focus effect) —
       *                           clearing first would flicker, and re-clicking
       *                           the SAME bead would end up deselected,
       *                           because `focusCommentId` never changes so
       *                           nothing re-selects it.
       *   [data-range-handle]     the yellow handle for that note's range.
       *                           Resizing a note is working ON it.
       *   [role="dialog"|"menu"]  the confirm dialog and the batch menu. The
       *                           batch actions already stopPropagation on
       *                           mousedown, but the dialog is portalled to
       *                           <body> and would otherwise wipe the ticks
       *                           behind a box asking "Delete 3 comments?".
       *
       * The rest of the timeline is deliberately NOT excluded: scrubbing the
       * track is moving on from the note, and deselecting is right there.
       */
      if (
        target.closest(
          '[data-comment-popover], [data-range-handle], [role="dialog"], [role="menu"]',
        )
      ) {
        return
      }
      const card = target.closest<HTMLElement>('.comment-card')
      if (card) {
        // Skip if the user is interacting with form-ish controls
        // INSIDE the card (replying, reacting, kebab menu) —
        // they have their own click semantics and shouldn't
        // re-trigger the selection animation. The card still
        // ends up selected because it's already focused, just
        // without re-running the transition.
        const interactive = target.closest('button, a, input, textarea, select')
        if (interactive && card.contains(interactive)) {
          // Still set selection on the card we clicked into,
          // but only if it isn't already selected (avoids
          // class churn → reflowed transitions).
          if (!card.classList.contains('is-selected')) {
            document
              .querySelectorAll('.comment-card.is-selected')
              .forEach((el) => el.classList.remove('is-selected'))
            card.classList.add('is-selected')
          }
          return
        }
        // Normal card click → make THIS one the selected one.
        if (!card.classList.contains('is-selected')) {
          document
            .querySelectorAll('.comment-card.is-selected')
            .forEach((el) => el.classList.remove('is-selected'))
          card.classList.add('is-selected')
        }
        return
      }
      // Click landed OUTSIDE every comment card → clear selection.
      document
        .querySelectorAll('.comment-card.is-selected')
        .forEach((el) => el.classList.remove('is-selected'))
      /**
       * 7.3.3: and drop the real selection with it — the ticked circles, which
       * until now only cleared after a batch action ran. Leaving eight notes
       * ticked while the user has plainly moved on meant the next right-click
       * anywhere offered to delete eight things they had stopped thinking
       * about. This listener already owned the question "did the click land
       * outside every comment", so the answer is given once here rather than
       * twice in two places that could drift apart.
       *
       * Written through the setter and the ref rather than `clearCommentSelection`:
       * both are stable, so this effect keeps its empty dependency array and
       * the listener is installed exactly once for the life of the panel.
       */
      setSelectedCommentIds((cur) => (cur.size === 0 ? cur : new Set()))
      selectionAnchorRef.current = null
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  // Listen for immediate comment updates (delete, post, etc.)
  useEffect(() => {
    const handleCommentPosted = (e: CustomEvent) => {
      // Use the comments data from the event if available, otherwise refetch
      if (e.detail?.comments) {
        setLocalComments(e.detail.comments)
      } else {
        fetchComments()
      }
    }

    const handleCommentUpdate = () => {
      fetchComments()
    }

    window.addEventListener('commentDeleted', handleCommentUpdate)
    window.addEventListener('commentPosted', handleCommentPosted as EventListener)

    return () => {
      window.removeEventListener('commentDeleted', handleCommentUpdate)
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
    }
  }, [projectId, fetchComments])

  // Get latest video version
  const latestVideoVersion = videos.length > 0
    ? Math.max(...videos.map(v => v.version))
    : null

  const currentVideo = videos.find(v => v.id === selectedVideoId)
  const currentVideoDuration = currentVideo?.duration ?? null
  // 6.11.0: comments are never switched off.
  // Approval used to disable them — approve a cut and the conversation about
  // it froze, which is backwards: that is exactly when people want to say
  // "one more thing". Approval is gone, and with it this lock.
  const commentsDisabled = false

  // Always use hook comments (includes optimistic updates)
  // Local comments only used as fallback if hook hasn't loaded
  const baseMergedComments = comments.length > 0 ? comments : localComments
  // 1.2.0+: while a rename is being applied, the `comments` prop hasn't
  // yet been replaced with the freshly fetched data. Layer the chosen
  // guest name on top during render so the change is visible the
  // instant the user hits Enter — the server-side update reconciles
  // in the background.
  const mergedComments = (() => {
    if (isAdminView || !guestName) return baseMergedComments
    const applyRename = (list: CommentWithReplies[]): CommentWithReplies[] =>
      list.map((c: any) => ({
        ...c,
        authorName: isMyComment(c) ? guestName : c.authorName,
        replies: Array.isArray(c.replies) ? applyRename(c.replies) : c.replies,
      }))
    return applyRename(baseMergedComments)
  })()

  // Filter comments based on currently selected video
  const displayComments = (() => {
    if (!selectedVideoId) {
      // No video selected - show all or latest version only
      return restrictToLatestVersion && latestVideoVersion
        ? mergedComments.filter(comment => comment.videoVersion === latestVideoVersion)
        : mergedComments
    }

    // Both admin and share page: show comments for specific videoId only
    return mergedComments.filter(comment => comment.videoId === selectedVideoId)
  })()

  // 2.2.6+: apply the comments filter ('all' | 'incomplete' |
  // 'completed'). The DB row exists regardless of the filter — we
  // just narrow what we show; flipping back to 'all' un-hides
  // everything without a refetch. A parent that gets filtered out
  // also hides its thread (no orphans).
  const visibleComments =
    commentsFilter === 'incomplete'
      ? displayComments.filter((c: any) => !c.isResolved)
      : commentsFilter === 'completed'
        ? displayComments.filter((c: any) => !!c.isResolved)
        : displayComments

  // 3.6.x: order top-level comments by their VIDEO TIMECODE (00:00
  // first → latest last), not by when they were posted. Reviewers read
  // top-to-bottom following the timeline. Comments with no timecode
  // (e.g. image assets or general notes) sink to the bottom, and
  // createdAt breaks ties (two notes on the same frame stay in the
  // order they were written).
  const commentSortKey = (c: Comment): number => {
    const tc = c.timecode
    if (typeof tc !== 'string' || tc.trim() === '') {
      return Number.POSITIVE_INFINITY
    }
    const fps = videos.find((v) => v.id === c.videoId)?.fps || 24
    const secs = timecodeToSeconds(tc, fps)
    return Number.isFinite(secs) ? secs : Number.POSITIVE_INFINITY
  }
  const sortedComments = [...visibleComments].sort((a, b) => {
    const ka = commentSortKey(a)
    const kb = commentSortKey(b)
    // `ka !== kb` is false when both are +Infinity, so we never compute
    // Infinity - Infinity (which would be NaN and corrupt the sort).
    if (ka !== kb) return ka - kb
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })

  // Sort replies under each parent chronologically
  sortedComments.forEach(comment => {
    if (comment.replies && comment.replies.length > 0) {
      comment.replies.sort((a: Comment, b: Comment) => {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      })
    }
  })

  // Auto-scroll to bottom when new comments appear
  // Scrolls only the messages container, not the entire page
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
    }
  }, [displayComments.length])

  // Check if commenting on current video is allowed
  const isCurrentVideoAllowed = () => {
    if (!restrictToLatestVersion) return true
    if (!selectedVideoId) return true
    const selectedVideo = videos.find(v => v.id === selectedVideoId)
    if (!selectedVideo) return true
    return selectedVideo.version === latestVideoVersion
  }

  const currentVideoRestricted = Boolean(restrictToLatestVersion && selectedVideoId && !isCurrentVideoAllowed())
  const restrictionMessage = currentVideoRestricted
    ? `You can only leave feedback on the latest version. Please switch to version ${latestVideoVersion} to comment.`
    : undefined

  const replyingToComment = mergedComments.find(c => c.id === replyingToCommentId) || null

  // 6.15.2: when Reply is clicked on a REPLY rather than the root comment, the
  // composer opens addressed to that person. Kept next to the composer instead
  // of inside it so it survives the input being re-mounted when the user
  // switches from one thread to another.
  const [replyMention, setReplyMention] = useState<string | null>(null)

  // Format message time
  const formatMessageTime = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - new Date(date).getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return t('justNow')
    if (diffMins < 60) return `${diffMins}${t('minutesAgo')}`
    if (diffHours < 24) return `${diffHours}${t('hoursAgo')}`
    if (diffDays < 7) return `${diffDays}${t('daysAgo')}`
    return formatDate(date)
  }

  const handleSeekToTimestamp = (timestamp: number, videoId: string, videoVersion: number | null) => {
    // Check if we're on a page with a video player by checking if the event listener exists
    const hasVideoPlayer = typeof window !== 'undefined' && document.querySelector('video')

    if (hasVideoPlayer) {
      // If video player is present (admin share page or public share page), dispatch event
      window.dispatchEvent(new CustomEvent('seekToTime', {
        detail: { timestamp, videoId, videoVersion }
      }))

      // 1.3.2+: on phones the comment list is fixed at the bottom of
      // the viewport, so the video player is often off-screen when
      // the user taps a comment. Scroll the player back into view
      // so the user can actually see the playhead jump to where the
      // comment was left — that's the whole point of tapping it.
      if (typeof window !== 'undefined' && window.innerWidth < 1024) {
        const videoEl = document.querySelector('video')
        if (videoEl) {
          videoEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }
    } else if (isAdminView) {
      // If in admin view without video player, navigate to admin share page with timestamp
      const video = videos.find(v => v.id === videoId)
      if (!video) return

      // Navigate to admin share page with video, version, and timestamp parameters
      const adminShareUrl = `/admin/projects/${projectId}/share?video=${encodeURIComponent(video.name)}&version=${videoVersion || video.version}&t=${Math.floor(timestamp)}`
      window.location.href = adminShareUrl
    }
  }

  const handleSeekToTimecode = (
    timecode: string,
    videoId: string,
    videoVersion: number | null,
    timestampMs?: number | null
  ) => {
    // 1.0.9+: image assets have no timeline — there's nothing to seek.
    // Bail before reaching `handleSeekToTimestamp`, whose
    // "no <video> element on the page" fallback would otherwise do a
    // full-page `window.location` navigation (an image renders as an
    // <img>, so the video query never matches → page refresh bug).
    const targetVideo = videos.find(v => v.id === videoId)
    if (targetVideo && (targetVideo as any).mediaType === 'IMAGE') return

    // Prefer the precise `timestampMs` captured at comment creation
    // (1.0.3+) so the playhead lands exactly where the user paused —
    // `timecode` is frame-quantized and round-tripping loses up to ~21ms
    // at 24fps. Fall back to the timecode-derived seconds for legacy
    // comments that don't carry a timestampMs.
    if (typeof timestampMs === 'number' && Number.isFinite(timestampMs) && timestampMs >= 0) {
      handleSeekToTimestamp(timestampMs / 1000, videoId, videoVersion)
      return
    }
    const fps = videos.find(v => v.id === videoId)?.fps || 24
    const seconds = timecodeToSeekSeconds(timecode, fps)
    handleSeekToTimestamp(seconds, videoId, videoVersion)
  }

  const handleOpenShortcuts = () => {
    window.dispatchEvent(new CustomEvent('openShortcutsDialog'))
  }

  // ───────────── Copy / paste comments between versions ─────────────
  // Frame.io-style workflow: a kebab menu in the top-right of the
  // sidebar lets the user clone all comments from the current video
  // onto a different version of the same project. The clipboard is
  // localStorage-backed and scoped per project.
  const [hasClipboardForProject, setHasClipboardForProject] = useState(false)
  // 1.3.2+: replace the native window.confirm() for comment deletes
  // with the same themed ConfirmDialog used elsewhere (project delete,
  // archive, etc.) for visual consistency.
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState<string | null>(null)

  /**
   * 7.3.0 — select several comments and act on them at once.
   *
   * A review pass leaves twenty notes and then wants the same verdict applied to
   * eight of them. One at a time is eight confirmations, eight menu openings and
   * a lost place in the list. Selection lives here rather than in MessageBubble
   * because the actions are the section's: it already owns delete, resolve and
   * the paste clipboard.
   *
   * Threads only, never replies — see `selectable` on MessageBubble for why.
   */
  const [selectedCommentIds, setSelectedCommentIds] = useState<Set<string>>(new Set())
  const toggleCommentSelected = useCallback((id: string) => {
    setSelectedCommentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearCommentSelection = useCallback(() => {
    setSelectedCommentIds(new Set())
    selectionAnchorRef.current = null
  }, [])

  /**
   * 7.3.0 — Finder/Explorer selection, the same three gestures the folder
   * browser uses, so one habit covers files and notes alike.
   *
   *   plain click  → this one only, and it becomes the anchor
   *   ⌘/Ctrl click → add or remove this one, and it becomes the anchor
   *   Shift click  → everything between the anchor and this one
   *
   * The anchor is a ref rather than state because nothing renders from it and a
   * re-render between two clicks would be a bad time to lose it.
   *
   * Range is taken over `sortedComments` — what is actually on screen, in the
   * order it is on screen. Shift-click means "everything between these two as I
   * see them", and getting that list wrong is not a cosmetic error: it selects
   * comments the user did not point at and misses ones they did.
   *
   * 7.3.3: it used to read `displayComments`, which is the list BEFORE the
   * completed/open filter and before the timecode sort. The claim in this
   * comment was that the two were the same thing, and they are — right up until
   * someone's comments were not written in timeline order. The list is rendered
   * by TIMECODE (see commentSortKey, 3.6.x) while the API returns rows by
   * createdAt ascending, so a note left on 00:22 a day before the notes on
   * 00:11 and 00:15 sits first in `displayComments` and last on screen.
   * Shift-clicking from the top comment to the bottom one then sliced the wrong
   * two indices out of the wrong array and selected exactly those two, skipping
   * everything the user had dragged across. It looked like a live-only fault
   * because it is a DATA fault: test comments written in timecode order make
   * both arrays identical, which is what local had.
   */
  const selectionAnchorRef = useRef<string | null>(null)
  const selectFromClick = useCallback(
    (commentId: string, mods: { shift: boolean; toggle: boolean }) => {
      const order = (sortedComments as any[]).map((c: any) => c.id as string)

      if (mods.shift && selectionAnchorRef.current) {
        const a = order.indexOf(selectionAnchorRef.current)
        const b = order.indexOf(commentId)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          setSelectedCommentIds(new Set(order.slice(lo, hi + 1)))
          return
        }
      }

      if (mods.toggle) {
        toggleCommentSelected(commentId)
        selectionAnchorRef.current = commentId
        return
      }

      setSelectedCommentIds(new Set([commentId]))
      selectionAnchorRef.current = commentId
    },
    [sortedComments, toggleCommentSelected],
  )

  /**
   * 7.3.3 — clicking a bead on the timeline selects its note in the list.
   *
   * `focusCommentId` is already the id of the marker that was clicked: the
   * player hands it up through `onCommentFocus` and the page passes it back
   * down, which is how the list has scrolled to the right card since 1.3.1. It
   * scrolled and lifted the card but never SELECTED it, so the timeline and the
   * list disagreed about what was picked — the tick was empty for a note that
   * was plainly the one being looked at, and the batch actions on right-click
   * did not apply to it.
   *
   * Replaces the selection rather than adding to it, because that is what a
   * plain click on a card does; the anchor moves too, so a Shift-click in the
   * list afterwards ranges from the note you picked on the timeline.
   *
   * Admin only — selection is admin only (see `selectable` on MessageBubble),
   * and ticking a box a reviewer has no actions for would be furniture.
   *
   * A separate effect from the one that scrolls, deliberately: that one is
   * guarded by `lastFocusedCommentRef` and full of retry/mobile logic that has
   * nothing to do with this, and this one has to live below the selection state
   * it writes to.
   */
  useEffect(() => {
    if (!isAdminView || !focusCommentId) return
    setSelectedCommentIds(new Set([focusCommentId]))
    selectionAnchorRef.current = focusCommentId
  }, [focusCommentId, isAdminView])

  /**
   * Right-click target. `ids` is resolved at open time, not at click time, and
   * follows the Finder rule: right-clicking INSIDE the selection acts on the
   * whole selection; right-clicking outside it acts on that one comment and
   * leaves the selection alone. Guessing either way round is worse than
   * deciding once and being predictable.
   */
  const [commentMenu, setCommentMenu] = useState<{
    x: number
    y: number
    ids: string[]
    /**
     * 7.3.3: how many threads are on the clipboard, read when the menu opens.
     * Snapshotted for the same reason `ids` is: the menu shows what was true
     * when it was summoned, and a label that changed underneath the pointer
     * would be lying about what clicking it does.
     */
    pasteCount?: number
  } | null>(null)

  /**
   * 7.3.0: the menu measures itself instead of being positioned against a
   * guess.
   *
   * It used to clamp with hardcoded numbers — 230px wide, 160px tall — which
   * were wrong the moment the labels started carrying counts: "Mark 3 comments
   * as completed" is far wider than 230, so the clamp let the menu run off the
   * right edge and cut the label in half.
   *
   * Nothing needs to know the size in advance: render it at the pointer, read the
   * real box, then move it only as far as it must to fit.
   *
   * Flipping the whole width to the left of the pointer — which is what a native
   * desktop menu does, and what this tried first — overshoots badly here. The
   * comments panel is narrow, so a 300px menu flipped left of a click inside it
   * lands over the video on the other side of the screen. Shifting by the
   * overflow instead keeps the menu under the pointer and merely tucks its edge
   * inside the window.
   *
   * `visibility` rather than a conditional render for the unmeasured frame: the
   * element has to be in the DOM to have a size, and hiding it means nobody sees
   * the one frame where it sits at the raw pointer position.
   */
  const commentMenuRef = useRef<HTMLDivElement | null>(null)
  const [commentMenuPos, setCommentMenuPos] = useState<{
    top: number
    left: number
  } | null>(null)
  useEffect(() => {
    if (!commentMenu) {
      setCommentMenuPos(null)
      return
    }
    const el = commentMenuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    setCommentMenuPos({
      left: Math.max(
        margin,
        Math.min(commentMenu.x, window.innerWidth - rect.width - margin),
      ),
      top: Math.max(
        margin,
        Math.min(commentMenu.y, window.innerHeight - rect.height - margin),
      ),
    })
  }, [commentMenu])
  useEffect(() => {
    if (!commentMenu) return
    const close = () => setCommentMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [commentMenu])

  const openCommentMenu = useCallback(
    (e: React.MouseEvent, commentId: string) => {
      e.preventDefault()
      e.stopPropagation()
      const inSelection = selectedCommentIds.has(commentId)
      setCommentMenu({
        x: e.clientX,
        y: e.clientY,
        ids: inSelection ? Array.from(selectedCommentIds) : [commentId],
      })
    },
    [selectedCommentIds],
  )

  /**
   * 7.3.3 — right-click on the empty space in the list.
   *
   * `ids: []` is what makes it a different menu: with nothing pointed at,
   * the only sensible offer is Paste, and when there is nothing on the
   * clipboard either, saying so out loud beats a menu that does not appear.
   * A right-click that produces no response is indistinguishable from a
   * right-click that was not registered.
   *
   * Deliberately on the LIST container and not on the whole section: the
   * composer below it is a textarea, and a textarea must keep the browser's
   * own context menu — replacing it would take away native cut/copy/paste and
   * spellcheck from the one place in this panel where they matter.
   *
   * A right-click on a thread never reaches this. `openCommentMenu` stops
   * propagation, which is what keeps the two menus from fighting over the
   * same gesture.
   */
  const openEmptyAreaMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      // No video selected means there is nowhere to paste INTO — `pasteThreads`
      // throws 'No video selected' — so the offer is withheld rather than made
      // and then silently swallowed by the catch. A menu item that does nothing
      // when clicked is worse than one that is not there.
      const clipped = selectedVideoId ? getClippedComments(projectId) : null
      setCommentMenu({
        x: e.clientX,
        y: e.clientY,
        ids: [],
        pasteCount: clipped?.length ?? 0,
      })
    },
    [projectId, selectedVideoId],
  )

  /**
   * 7.3.0 — the three batch actions, all sequential.
   *
   * Sequential for the reason comments-paste.ts is sequential: the comment
   * endpoints are rate-limited, and firing eight resolves or eight deletes at
   * once gets a share of them rejected. A batch that silently half-applied would
   * be worse than a slow one, because the list would look done.
   */
  const [bulkBusy, setBulkBusy] = useState(false)
  const [pendingBulkDeleteIds, setPendingBulkDeleteIds] = useState<string[] | null>(null)

  /**
   * 7.x — a comment's marker was dragged to a new moment on the timeline.
   *
   * CustomVideoControls does the gesture, VideoPlayer relays it, and the write
   * lands here because this is where comment mutations live. Both fields go
   * together: `timecode` is what a human reads and `timestampMs` is what
   * positions the marker, and updating one without the other would leave the
   * bead and the label disagreeing.
   *
   * A refetch rather than a local patch, so any other tab on the same video sees
   * the note move too.
   */
  useEffect(() => {
    const onMove = async (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      const commentId = d.commentId as string | undefined
      const timecode = d.timecode as string | undefined
      const timestampMs = d.timestampMs as number | undefined
      const hasEnd = 'timecodeEnd' in d
      // 7.3.3: dragging the END of a range sends no start at all. Rebuilding
      // the start from its on-screen percentage and writing it back would move
      // it by up to a frame on every resize — small, cumulative, and exactly
      // the kind of drift that shows up as the bead and the strip parting
      // company. An absent `timecode` means "leave the start alone".
      if (!commentId) return
      if (!timecode && !hasEnd) return
      try {
        /**
         * 7.3.3: a range comment moves as a whole, so the end travels with the
         * start. Presence, not truthiness, decides whether it is sent: the
         * route accepts `null` to shrink a range back to a point, and a point
         * comment sends no key at all so its (absent) end is left alone. A
         * `timecodeEnd: undefined` in the body would serialise away anyway, but
         * being explicit here is what stops a future edit from turning "do not
         * touch the end" into "clear the end".
         */
        const body = JSON.stringify({
          ...(timecode ? { timecode, timestampMs } : {}),
          ...(hasEnd ? { timecodeEnd: d.timecodeEnd ?? null } : {}),
        })
        const res = isAdminView
          ? await apiFetch(`/api/comments/${commentId}`, {
              method: 'PATCH',
              headers: buildAuthedHeaders(),
              body,
            })
          : await fetch(`/api/comments/${commentId}`, {
              method: 'PATCH',
              headers: buildAuthedHeaders(),
              body,
            })
        if (!res.ok) {
          // Refetch anyway: the bead is sitting where the pointer left it, and
          // leaving it there after a refusal would show a move that never
          // happened.
          logError('[CommentSection] moving a comment failed:', `HTTP ${res.status}`, commentId)
        }
      } catch (err) {
        logError('[CommentSection] moving a comment failed:', err, commentId)
      } finally {
        await fetchComments()
        // 7.x: and tell the PAGE, which is what actually feeds the player's
        // markers. Refetching here only refreshes this sidebar — the timeline
        // reads a `comments` prop that comes down from the page, so without this
        // the bead sprang back to its old frame on the next render even though
        // the database had moved it. `commentDeleted` is the existing
        // "comments changed, reload" signal; pasteThreads uses it the same way.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('commentDeleted'))
        }
      }
    }
    window.addEventListener('comment:moveTimecode', onMove as EventListener)
    return () =>
      window.removeEventListener('comment:moveTimecode', onMove as EventListener)
  }, [isAdminView, buildAuthedHeaders, fetchComments])

  const bulkCopyComments = useCallback(
    (ids: string[]) => {
      const wanted = new Set(ids)
      // Ordered by the list, not by click order — a pasted batch should read the
      // way it read on screen. 7.3.3: which means `sortedComments`, the list as
      // rendered; `displayComments` is in createdAt order and would paste a
      // batch shuffled out of timeline order. Same mistake as the range above,
      // milder consequence.
      const chosen = (sortedComments as any[]).filter((c: any) => wanted.has(c.id))
      if (chosen.length === 0) return
      setClippedComments(projectId, toClipped(chosen))
      setHasClipboardForProject(true)
      clearCommentSelection()
    },
    [sortedComments, projectId, clearCommentSelection],
  )

  const bulkResolveComments = useCallback(
    async (ids: string[], nextResolved: boolean) => {
      if (bulkBusy) return
      setBulkBusy(true)
      try {
        for (const id of ids) {
          try {
            await handleResolveToggle(id, nextResolved)
          } catch (err) {
            // One refusal must not abandon the rest of the batch; the list
            // refetch at the end shows exactly which ones took.
            logError('[CommentSection] bulk resolve failed for one comment:', err, id)
          }
        }
        clearCommentSelection()
      } finally {
        setBulkBusy(false)
      }
    },
    [bulkBusy, handleResolveToggle, clearCommentSelection],
  )

  const bulkDeleteComments = useCallback(
    async (ids: string[]) => {
      if (bulkBusy) return
      setBulkBusy(true)
      try {
        for (const id of ids) {
          try {
            await handleDeleteComment(id)
          } catch (err) {
            logError('[CommentSection] bulk delete failed for one comment:', err, id)
          }
        }
        clearCommentSelection()
      } finally {
        setBulkBusy(false)
      }
    },
    [bulkBusy, handleDeleteComment, clearCommentSelection],
  )
  useEffect(() => {
    setHasClipboardForProject(hasClippedComments(projectId))
    // React to other tabs (or our own clear() call) flipping the
    // localStorage entry.
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('framecomment:clipboard:comments')) return
      setHasClipboardForProject(hasClippedComments(projectId))
    }
    // 7.1.0: same reason as in PlayerTopMenu — a clipboard written by the OTHER
    // menu in this same tab produces no `storage` event, so without this the two
    // Paste buttons disagreed about whether there was anything to paste.
    const onChanged = () => setHasClipboardForProject(hasClippedComments(projectId))
    window.addEventListener('storage', onStorage)
    window.addEventListener(CLIPBOARD_CHANGED_EVENT, onChanged)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(CLIPBOARD_CHANGED_EVENT, onChanged)
    }
  }, [projectId])

  /**
   * Turn thread rows into clipboard records.
   *
   * 6.16.0: replies come along. They used to be dropped, so pasting into a new
   * version produced a wall of orphaned questions — including ones already
   * answered with "fixed, see 0:14". Carrying the note without its answer does
   * not just lose detail, it actively misleads the next reviewer.
   */
  const toClipped = (list: any[]) =>
    list.map((c: any) => ({
      content: c.content,
      timecode: c.timecode,
      timecodeEnd: c.timecodeEnd ?? null,
      timestampMs: typeof c.timestampMs === 'number' ? c.timestampMs : null,
      authorName: c.authorName ?? null,
      // 6.22.0: the drawing and the files come too.
      //
      // "The logo is wrong, see the screenshot" is useless on the new cut if the
      // screenshot stayed on the old one, and a voice message is nothing BUT its
      // attachment — pasting one used to produce an empty bubble. Annotations
      // travel as data; attachments travel as a reference to the source comment,
      // which the server resolves (the browser must not pick which files it may
      // copy).
      annotations: carryableAnnotations(c.annotations),
      sourceCommentId: c.id ?? null,
      attachmentCount: Array.isArray(c.assets) ? c.assets.length : 0,
      replies: Array.isArray(c.replies)
        ? c.replies.map((r: any) => ({
            content: r.content,
            authorName: r.authorName ?? null,
            annotations: carryableAnnotations(r.annotations),
            sourceCommentId: r.id ?? null,
            attachmentCount: Array.isArray(r.assets) ? r.assets.length : 0,
          }))
        : [],
    }))

  const handleCopyComments = useCallback(() => {
    // Snapshot what's currently visible in the sidebar (already filtered to
    // the active video by `displayComments`).
    const clipped = toClipped(displayComments as any[])
    setClippedComments(projectId, clipped)
    setHasClipboardForProject(clipped.length > 0)
    // The count is what the user is told was copied, so it counts what they
    // see in the list: threads, not individual messages.
    return { count: clipped.length }
  }, [displayComments, projectId])

  /** One POST, admin or share flavour. */
  const postComment = useCallback(
    async (body: Record<string, unknown>) => {
      return isAdminView
        ? apiFetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : fetch('/api/comments', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
            },
            body: JSON.stringify(body),
          })
    },
    [isAdminView, shareToken],
  )

  /**
   * Write a set of clipped threads onto the active video.
   *
   * Shared by the kebab's "Paste comments" and by 6.16.0's "Paste N comments
   * from vX" button — same mechanics, the only difference is whether we also
   * record where they came from.
   *
   * Sequential on purpose. The backend rate-limits comment creation, so firing
   * twenty in parallel gets half of them rejected; and a reply cannot be
   * posted until its parent exists and has an id.
   */
  /**
   * 7.3.3 — point at the notes a paste just added.
   *
   * The list is sorted by TIMECODE, so pasted notes land wherever their moments
   * put them — scattered through forty existing comments, never conveniently at
   * the bottom. Before this, a paste changed a number and nothing else: you had
   * to read the whole list to find out what arrived.
   *
   * Two things, in the order they matter. The first pasted note is scrolled to,
   * because an animation nobody is looking at is not an answer. Then every
   * pasted note is washed with the accent for a couple of seconds, so once the
   * scroll lands the eye can pick out all of them, not just the one at the
   * centre.
   *
   * The classList-plus-retry shape is deliberate rather than React state: it is
   * exactly how `.is-selected` and `.is-focus-pulse` already decorate these
   * cards, and a transient two-second flourish has no business causing every
   * bubble in a long list to re-render. The retry exists because `fetchComments`
   * resolving does not mean React has painted the new rows yet.
   *
   * Skips the scroll on phones for the same reason the focus effect does: the
   * list sits below the video there, so scrolling to a comment shoves the
   * player off screen. The wash still plays.
   */
  const flashPastedComments = useCallback((ids: string[]) => {
    if (ids.length === 0 || typeof document === 'undefined') return
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640
    let attempts = 0

    const tryFlash = () => {
      attempts += 1
      const cards = ids
        .map((id) => document.getElementById(`comment-${id}`))
        .map((el) => el?.querySelector<HTMLElement>('.comment-card') ?? null)
        .filter((el): el is HTMLElement => !!el)

      if (cards.length === 0) {
        // Six tries at 200ms covers a slow refetch; past that the paste
        // happened but something else is wrong and retrying forever would just
        // leave a timer running for the life of the page.
        if (attempts < 6) setTimeout(tryFlash, 200)
        return
      }

      if (!isMobile) {
        cards[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
      }

      for (const card of cards) {
        // Remove-reflow-add, the same dance `.is-focus-pulse` needs: without
        // the forced reflow the browser coalesces the two class changes and the
        // animation never restarts, so a second paste onto the same note would
        // be silent.
        card.classList.remove('is-paste-flash')
        void card.offsetWidth
        card.classList.add('is-paste-flash')
        const clear = () => card.classList.remove('is-paste-flash')
        card.addEventListener('animationend', clear, { once: true })
        // Reduced-motion gets no animationend, because it gets no animation —
        // so the class has to come off on a timer instead, or the wash would
        // stay on those cards for good. Kept just past the animation's own
        // 1400ms so it never cuts a playing flash short.
        setTimeout(clear, 1800)
      }
    }

    setTimeout(tryFlash, 100)
  }, [])

  const pasteThreads = useCallback(
    async (
      items: ClippedComment[],
      source?: { videoId: string; versionLabel: string },
      onProgress?: (state: { kind: 'waiting'; seconds: number }) => void,
    ) => {
      if (!selectedVideoId) throw new Error('No video selected')
      // 7.1.0: the mechanics moved to src/lib/comments-paste.ts, so the folder
      // browser's "paste onto every selected video" runs exactly this code
      // instead of a second copy of it. What stays here is what only this
      // component can do: refresh the list it is showing, and tell the rest of
      // the page the comment set changed.
      const result = await pasteClippedThreads({
        projectId,
        videoId: selectedVideoId,
        items,
        isInternal: !!isAdminView,
        post: postComment,
        source,
        onProgress,
      })
      await fetchComments()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('commentDeleted'))
      }
      /**
       * 7.3.3: the notes that just arrived come in already selected.
       *
       * A paste is almost never the last step — the batch usually wants
       * resolving, or moving, or deleting again once it has been read. Having
       * them selected means the very next right-click acts on exactly them,
       * with no hunting through a re-sorted list to tick eight boxes that were
       * a single set two seconds ago.
       *
       * Replaces whatever was selected, and the anchor lands on the first, so a
       * Shift-click afterwards extends from the top of the pasted batch. Admin
       * only, like every other selection here.
       */
      if (isAdminView && result.createdIds.length > 0) {
        setSelectedCommentIds(new Set(result.createdIds))
        selectionAnchorRef.current = result.createdIds[0]
      }
      // Every local paste route goes through here — the kebab, the right-click
      // menu on the empty area, and "paste the previous version's notes" — so
      // this is the one place the highlight has to be hooked in.
      flashPastedComments(result.createdIds)
      return result
    },
    [projectId, selectedVideoId, isAdminView, postComment, fetchComments, flashPastedComments],
  )

  /**
   * 6.16.0 — the version you just uploaded is empty, and the feedback you want
   * is one version back.
   *
   * Frame.io shows "N comments on other versions" here with a View button that
   * takes you away. Taking you away is the wrong move for the person who just
   * exported v2: they do not want to read v1's notes somewhere else, they want
   * them in front of the new cut so they can work through them.
   *
   * Which version: the most recent OTHER one that actually has comments, not
   * strictly v(n-1). Uploading a quick fix that nobody commented on should not
   * hide the notes from the cut before it.
   */
  const previousCommentSource = useMemo(() => {
    if (!isAdminView) return null
    if (!selectedVideoId) return null
    if (displayComments.length > 0) return null

    const byVideo = new Map<string, any[]>()
    for (const c of mergedComments as any[]) {
      // Roots only. Replies travel with their parent, and counting them here
      // would promise "7 comments" and then paste 3 threads.
      if (c.parentId) continue
      if (!c.videoId || c.videoId === selectedVideoId) continue
      const bucket = byVideo.get(c.videoId) ?? []
      bucket.push(c)
      byVideo.set(c.videoId, bucket)
    }
    if (byVideo.size === 0) return null

    let best: { video: any; comments: any[] } | null = null
    for (const [videoId, list] of byVideo) {
      const video = videos.find((v) => v.id === videoId)
      if (!video) continue
      if (!best || (video.version ?? 0) > (best.video.version ?? 0)) {
        best = { video, comments: list }
      }
    }
    if (!best) return null

    return {
      videoId: best.video.id as string,
      versionLabel:
        ((best.video as any).versionLabel as string | null) ||
        `v${best.video.version ?? 1}`,
      comments: best.comments,
      count: best.comments.length,
    }
  }, [isAdminView, selectedVideoId, displayComments.length, mergedComments, videos])

  const [pastingPrevious, setPastingPrevious] = useState(false)
  /** Seconds left of a rate-limit wait, so the button can say what it is doing. */
  const [pasteWaitSeconds, setPasteWaitSeconds] = useState<number | null>(null)
  /** What went wrong, in the user's words, under the button. */
  const [pasteNote, setPasteNote] = useState<string | null>(null)
  /**
   * 7.3.5 — say what happened.
   *
   * This used to await the paste and throw the result away. `POST /api/comments`
   * allows 10 per 60 seconds and locks out for a further 60 on the eleventh, a
   * cap meant to stop a reviewer spamming; a paste trips it just by being one
   * action that makes one request per thread and one per reply. Every refused
   * post was skipped with a bare `continue`, so the button showed "Pasting…",
   * finished, and left the empty state exactly as it was — with no way to tell a
   * paste that did nothing from a paste that had nothing to do.
   *
   * Now the batch waits the lockout out once and finishes, and anything still
   * refused is named. Slow and honest beats instant and wrong.
   */
  const handlePastePreviousVersion = useCallback(async () => {
    if (!previousCommentSource || pastingPrevious) return
    setPastingPrevious(true)
    setPasteNote(null)
    setPasteWaitSeconds(null)
    try {
      const r = await pasteThreads(
        toClipped(previousCommentSource.comments),
        {
          videoId: previousCommentSource.videoId,
          versionLabel: previousCommentSource.versionLabel,
        },
        (state) => setPasteWaitSeconds(state.seconds),
      )
      const total = r.created + r.failed
      if (r.failed > 0) {
        setPasteNote(
          r.created === 0
            ? t('pasteFailedAll')
            : r.rateLimited
              ? t('pastePartial', { done: r.created, total })
              : t('pasteSomeRefused', { done: r.created, total }),
        )
      }
    } catch (err) {
      logError('[CommentSection] pasting the previous version failed:', err)
      setPasteNote(t('pasteFailedAll'))
    } finally {
      setPastingPrevious(false)
      setPasteWaitSeconds(null)
    }
  }, [previousCommentSource, pastingPrevious, pasteThreads, t])

  const handlePasteComments = useCallback(async () => {
    const items = getClippedComments(projectId)
    if (!items || items.length === 0) {
      throw new Error('Nothing to paste')
    }
    const { created, filesMissing, failed, rateLimited } = await pasteThreads(items)
    // 7.3.5: a partial paste is not a success. The toast this feeds only knows
    // how to say "pasted N", which for 6-of-12 is a reassuring lie; throwing
    // puts the honest sentence in front of the user through the same channel.
    if (failed > 0) {
      throw new Error(
        created === 0
          ? t('pasteFailedAll')
          : rateLimited
            ? t('pastePartial', { done: created, total: created + failed })
            : t('pasteSomeRefused', { done: created, total: created + failed }),
      )
    }
    return { count: created, filesMissing }
  }, [projectId, pasteThreads, t])

  // 1.3.2+: bridge between this section and the top-level PlayerTopMenu.
  // The menu lives outside CommentSection (in the title bar) but Copy /
  // Paste comments needs the local clipboard handlers + current video
  // context. Custom window events keep the wiring tiny — the menu fires
  // `commentClipboard:copy|paste`, we run the handler and reply with a
  // `commentClipboard:result` event so the menu can show a toast.
  useEffect(() => {
    const reply = (
      detail:
        // 6.22.0: `filesMissing` rides along so the toast can admit that some
        // attachments did not make it, rather than reporting a clean paste.
        | { kind: 'copied' | 'pasted'; count: number; filesMissing?: number }
        | { kind: 'error'; message: string },
    ) => {
      window.dispatchEvent(
        new CustomEvent('commentClipboard:result', { detail }),
      )
    }
    const onCopy = async () => {
      try {
        const r = handleCopyComments()
        reply({ kind: 'copied', count: r.count })
      } catch (err) {
        reply({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Copy failed',
        })
      }
    }
    const onPaste = async () => {
      try {
        const r = await handlePasteComments()
        reply({ kind: 'pasted', count: r.count, filesMissing: r.filesMissing })
      } catch (err) {
        reply({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Paste failed',
        })
      }
    }
    window.addEventListener('commentClipboard:copy', onCopy as EventListener)
    window.addEventListener('commentClipboard:paste', onPaste as EventListener)
    return () => {
      window.removeEventListener('commentClipboard:copy', onCopy as EventListener)
      window.removeEventListener('commentClipboard:paste', onPaste as EventListener)
    }
  }, [handleCopyComments, handlePasteComments])

  return (
    <>
    {/* 2.5.1+: glass sidebar — same `bg-white/[0.04]` + hairline
        ring vocabulary used by AdminSidebar + Profile cards, plus
        an inline radial gradient (top-left) that mirrors the
        light-spot wash on the admin shell. Driven by
        `--spotlight-tint` so the glow follows the user's chosen
        accent colour, not a hard-coded blue. */}
    <Card
      // 3.5.x: re-enable text selection inside the comments panel — the
      // player chrome sets `select-none` to stop accidental drags, but
      // feedback text here must stay selectable/copyable.
      className="select-text border-0 flex flex-col h-full lg:max-h-full rounded-none lg:rounded-2xl overflow-hidden bg-white/[0.06] ring-1 ring-white/15 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.55)] text-white"
      style={{
        // Stronger accent-tinted glow in the top-left corner so the
        // sidebar reads as a glass panel ABOVE the page spotlight,
        // not as a flat grey rectangle. The radial gradient uses
        // `--spotlight-tint` so the colour tracks the user's chosen
        // accent.
        backgroundImage:
          'radial-gradient(140% 70% at 0% 0%, hsl(var(--spotlight-tint) / 0.18) 0%, hsl(var(--spotlight-tint) / 0.06) 35%, transparent 70%)',
        backdropFilter: 'blur(18px) saturate(140%)',
        WebkitBackdropFilter: 'blur(18px) saturate(140%)',
      }}
      data-comment-section
    >
      {/* Desktop: Show header at top, Mobile: Hide header (will show below input) */}
      <CardHeader className={cn("flex-shrink-0 px-3 py-3 sm:px-4 sm:py-4", mobileCollapsible && "hidden lg:block")}>
        <div className="flex items-center justify-between gap-2 min-w-0">
          <CardTitle className="text-foreground flex items-center gap-2 text-base sm:text-lg min-w-0">
            <MessageSquare className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
            {/* 2.2.6+: title acts as a filter dropdown. Click flips
                between All / Incomplete / Completed; the chevron is
                the only affordance — the icon + text size stay the
                same so the header reads identically when the menu
                isn't open. */}
            <div data-comments-filter className="relative min-w-0">
              <button
                ref={filterTriggerRef}
                type="button"
                onClick={() => setFilterMenuOpen((v) => !v)}
                // 2.5.1+: glass trigger matching the v2.5 pill
                // pattern (search bar, version dropdown, etc.).
                className="inline-flex items-center gap-1 min-w-0 rounded-md px-2 py-1 -mx-1 hover:bg-white/[0.08] transition-colors text-white"
                aria-haspopup="menu"
                aria-expanded={filterMenuOpen}
              >
                <span className="truncate">{commentsFilterLabel}</span>
                <ChevronDown
                  className={cn(
                    'w-4 h-4 shrink-0 opacity-70 transition-transform',
                    filterMenuOpen && 'rotate-180',
                  )}
                />
              </button>
              {filterMenuOpen && filterMenuCoords && typeof document !== 'undefined' && createPortal(
                // 2.5.1+: PORTAL to document.body so the frosted-
                // glass backdrop-filter actually samples the real
                // page behind (the comments sidebar Card has its
                // own backdrop-filter, which would otherwise form
                // a backdrop root and break the blur). Tagged with
                // `data-comments-filter` so the outside-click
                // handler treats it as "inside".
                <div
                  data-comments-filter
                  role="menu"
                  /* 7.3.0: `brand-menu-surface`, same correction as the
                     right-click menu below. This one was wearing the glass PANEL
                     recipe at 0.35 opacity — a menu you could read the page
                     through, in a fixed navy that ignored the workspace accent.
                     Found while fixing the other; it is the dropdown directly
                     above it, so the two would have disagreed with each other on
                     screen. */
                  className="brand-menu-surface fixed z-[200] min-w-[220px] rounded-lg ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-1 text-sm text-white animate-in fade-in-0 slide-in-from-top-1 duration-150"
                  style={{
                    left: filterMenuCoords.left,
                    top: filterMenuCoords.top,
                  }}
                >
                  {(
                    [
                      { v: 'all', label: 'All comments' },
                      { v: 'incomplete', label: 'Incomplete comments' },
                      { v: 'completed', label: 'Completed comments' },
                    ] as { v: CommentsFilter; label: string }[]
                  ).map(({ v, label }) => {
                    const isActive = v === commentsFilter
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setCommentsFilter(v)}
                        role="menuitem"
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors whitespace-nowrap"
                        style={
                          isActive
                            ? {
                                backgroundColor:
                                  'hsl(var(--spotlight-tint) / 0.22)',
                                boxShadow:
                                  'inset 0 0 0 1px hsl(var(--spotlight-tint) / 0.45)',
                              }
                            : undefined
                        }
                        onMouseEnter={(e) => {
                          if (!isActive)
                            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                              'rgba(255,255,255,0.08)'
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive)
                            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                              ''
                        }}
                      >
                        <Check
                          className="w-3.5 h-3.5 shrink-0"
                          strokeWidth={2.5}
                          style={{
                            opacity: isActive ? 1 : 0,
                            color: isActive
                              ? 'hsl(var(--spotlight-tint))'
                              : undefined,
                          }}
                        />
                        <span
                          className={cn(
                            'whitespace-nowrap',
                            isActive ? 'text-white' : 'text-white/85',
                          )}
                        >
                          {label}
                        </span>
                      </button>
                    )
                  })}
                </div>,
                document.body
              )}
            </div>
          </CardTitle>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* 3.9.x: "Send to editor" moved to its own centered row
                below (see next block) — inline here it collided with a
                long filter title like "Completed comments". */}
            <CommentsKebabMenu
              commentCount={displayComments.length}
              hasClipboard={hasClipboardForProject}
              onCopy={handleCopyComments}
              onPaste={handlePasteComments}
            />
            {showToggleButton && onToggleVisibility && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleVisibility}
                className="hidden lg:flex h-8 px-2"
                title={t('hideFeedback')}
              >
                <PanelRightClose className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
        {/* 3.9.x: Send to editor on its own centered line so it never
            overlaps the title/filter (which can read "Completed
            comments" etc). */}
        <div className="mt-2 flex justify-center">
          {SEND_TO_EDITOR_BUTTON_ENABLED && renderSendToEditor()}
        </div>
        {/*
          1.2.0+: editable display-name row for guests. Lets a reviewer
          replace their auto-assigned "Client N" label with their real
          name; the rename endpoint bulk-updates all of their existing
          comments so the change is retroactive on this share link.
          Admins skip the row entirely — they already have a profile.

          The "Currently viewing: v1" line was retired here — the active
          version label is already shown next to the title in the player's
          top bar, so the duplicate read-only line just added noise.
        */}
        {!isAdminView && (
          <div className="mt-2 flex items-center gap-2 text-sm" data-tutorial="tour-name">
            <span className="text-muted-foreground shrink-0">Name:</span>
            {isEditingName ? (
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleSaveRename()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      handleCancelRename()
                    }
                  }}
                  autoFocus
                  maxLength={120}
                  placeholder="Your name"
                  className="flex-1 min-w-0 h-8 rounded-md border-0 bg-white/[0.06] ring-1 ring-white/10 px-2.5 py-1 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--spotlight-tint)/0.55)]"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveRename()}
                  disabled={savingName || !nameDraft.trim()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Save"
                  aria-label="Save"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleCancelRename}
                  disabled={savingName}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
                  title="Cancel"
                  aria-label="Cancel"
                >
                  <XIcon className="w-4 h-4" />
                </button>
              </div>
            ) : (
              // 1.2.0+: rendered as a proper input-style box (border +
              // padding + size matching the edit-mode input) so it's
              // obvious the value is editable. Click anywhere in the
              // box opens edit mode.
              <button
                type="button"
                onClick={handleStartRename}
                className="group flex items-center justify-between gap-2 flex-1 min-w-0 h-8 rounded-md border-0 bg-white/[0.06] ring-1 ring-white/10 px-2.5 py-1 text-left text-sm text-white hover:bg-white/[0.12] hover:ring-white/20 transition-colors"
                title="Edit your display name"
              >
                <span className="font-medium truncate min-w-0">
                  {guestName || 'Client'}
                </span>
                <Pencil className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 text-muted-foreground shrink-0" />
              </button>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="flex-1 flex flex-col p-0 overflow-hidden min-h-0">
        {/* 1.3.2+: Comment Input pinned at the BOTTOM of the device
            viewport via `fixed bottom-0`. The whole page on mobile is
            already a fixed-height flex column (`h-[100dvh]` with
            `overflow-hidden`), so the fixed input doesn't cause any
            layout shift — it just floats above the (internally-
            scrolling) comment list. We compensate with bottom padding
            on the messages area further down so the last comment
            isn't hidden behind it. The `inset-x-0` keeps the
            shadow/border spanning the full device width even when
            the comment card itself is offset from the edges by
            outer padding/gap. */}
        {mobileCollapsible && (
          <div
            ref={mobileInputWrapperRef}
            // 3.2.3+ Mobile: align fixed-bottom composer with the v2.5
            // frosted-glass recipe instead of the pre-2.5 flat
            // `bg-background/95`. Same `rgba(22, 37, 51, 0.62)` tint +
            // radial spotlight overlay + `backdrop-filter` blur as the
            // glass loading cards and the comments sidebar, so the
            // composer reads as part of the same translucent surface
            // when the soft keyboard floats it up over the player
            // background. `border-t border-white/10` matches the
            // hairline used inside the glass cards. `pb-[env(safe-area-
            // inset-bottom)]` stays — it covers the home-bar gap on
            // notched devices.
            className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 shadow-[0_-4px_12px_rgba(0,0,0,0.25)] pb-[env(safe-area-inset-bottom)]"
            style={{
              // 4.x: SOLID accent-tinted brown (no gradient) to match the
              // desktop composer. Neutral app-background base + a FLAT, uniform
              // accent wash (same colour start→end so there's no visible
              // gradient direction), so it still tracks the active accent
              // (warm/brown for orange) but reads as one solid colour.
              backgroundColor: 'hsl(var(--background) / 0.85)',
              backgroundImage:
                'linear-gradient(hsl(var(--spotlight-tint) / 0.12), hsl(var(--spotlight-tint) / 0.12))',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              transform: 'translate3d(0, 0, 0)',
              willChange: 'backdrop-filter, transform',
              isolation: 'isolate',
            }}
          >
            <CommentInput
              transparentBackground
              feedingEditId={editingCommentId}
              newComment={newComment}
              onCommentChange={handleCommentChange}
              onInputFocus={handleCommentInputFocus}
              onSubmit={handleSubmitComment}
              loading={loading}
              selectedTimestamp={selectedTimestamp}
              onClearTimestamp={handleClearTimestamp}
              selectedVideoFps={selectedVideoFps}
              selectedVideoDurationSeconds={currentVideoDuration}
              timestampDisplayMode={timestampDisplayMode}
              selectedTimecodeEnd={selectedTimecodeEnd}
              onSetTimecodeEnd={handleSetTimecodeEnd}
              onClearTimecodeEnd={handleClearTimecodeEnd}
              replyingToComment={replyingToComment}
              onCancelReply={handleCancelReply}
              showAuthorInput={!isAdminView && isPasswordProtected}
              authorName={authorName}
              onAuthorNameChange={setAuthorName}
              namedRecipients={namedRecipients}
              nameSource={nameSource}
              selectedRecipientId={selectedRecipientId}
              onNameSourceChange={handleNameSourceChange}
              isOtpAuthenticated={isOtpAuthenticated}
              currentVideoRestricted={currentVideoRestricted}
              restrictionMessage={restrictionMessage}
              commentsDisabled={commentsDisabled}
              allowClientAssetUpload={allowClientAssetUpload}
              maxCommentAttachments={maxCommentAttachments}
              selectedVideoId={selectedVideoId}
              pendingAttachments={pendingAttachments}
              onAttachmentAdded={handleAttachmentAdded}
              onRemoveAttachment={handleRemoveAttachment}
              attachmentError={attachmentError}
              attachmentNotice={attachmentNotice}
              onAttachmentErrorChange={handleAttachmentErrorChange}
              shareToken={shareToken}
              pendingAnnotation={pendingAnnotation}
              onStartDrawing={handleStartDrawing}
              onClearAnnotation={handleClearAnnotation}
              showShortcutsButton={showShortcutsButton}
              onShowShortcuts={handleOpenShortcuts}
            />
          </div>
        )}

        {/* Mobile-only header for the messages list.
            1.4.x: dropped the collapse/expand chevron toggle that
            used to hide all comments on tap — clients found it more
            confusing than useful (most users expect comments to just
            be there). Replaced with the same kebab menu (Copy /
            Paste comments) that desktop uses, so the mobile header
            now has feature parity with desktop. */}
        {mobileCollapsible && (
          <div className="order-2 lg:hidden w-full px-3 py-2 flex flex-col gap-2 bg-muted/30">
            <div className="flex items-center justify-between w-full">
            {/* 2.2.6+: mobile mirror of the desktop filter dropdown.
                Same state + storage key, so flipping on one device
                width persists to the other. */}
            <div data-comments-filter className="relative">
              <button
                type="button"
                onClick={() => setFilterMenuOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-sm font-medium rounded-md px-1 -mx-1 py-0.5 hover:bg-muted/60 transition-colors"
                aria-haspopup="menu"
                aria-expanded={filterMenuOpen}
              >
                <MessageSquare className="w-4 h-4" />
                <span>{commentsFilterLabel}</span>
                <span className="text-muted-foreground">({sortedComments.length})</span>
                <ChevronDown
                  className={cn(
                    'w-4 h-4 shrink-0 opacity-60 transition-transform',
                    filterMenuOpen && 'rotate-180',
                  )}
                />
              </button>
              {filterMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-0 top-full mt-1 z-30 min-w-[200px] rounded-md border border-border bg-popover shadow-lg py-1 text-sm"
                >
                  {(
                    [
                      { v: 'all', label: 'All comments' },
                      { v: 'incomplete', label: 'Incomplete comments' },
                      { v: 'completed', label: 'Completed comments' },
                    ] as { v: CommentsFilter; label: string }[]
                  ).map(({ v, label }) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setCommentsFilter(v)}
                      role="menuitem"
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
                        v === commentsFilter
                          ? 'bg-muted/60 text-foreground font-medium'
                          : 'text-foreground/90 hover:bg-muted/40',
                      )}
                    >
                      <Check
                        className={cn(
                          'w-3.5 h-3.5 shrink-0',
                          v === commentsFilter ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="whitespace-nowrap">{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <CommentsKebabMenu
                commentCount={displayComments.length}
                hasClipboard={hasClipboardForProject}
                onCopy={handleCopyComments}
                onPaste={handlePasteComments}
                /* 4.x: on mobile the guest "Name" editor lives INSIDE this
                   kebab menu instead of taking its own row under the header. */
                nameSection={
                  !isAdminView ? (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-white/55">Name</span>
                      {isEditingName ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                void handleSaveRename()
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                handleCancelRename()
                              }
                            }}
                            autoFocus
                            maxLength={120}
                            placeholder="Your name"
                            className="flex-1 min-w-0 h-8 rounded-md border-0 bg-white/[0.06] ring-1 ring-white/10 px-2.5 py-1 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--spotlight-tint)/0.55)]"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveRename()}
                            disabled={savingName || !nameDraft.trim()}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40"
                            title="Save"
                            aria-label="Save"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelRename}
                            disabled={savingName}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-40"
                            title="Cancel"
                            aria-label="Cancel"
                          >
                            <XIcon className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={handleStartRename}
                          className="group flex items-center justify-between gap-2 min-w-0 h-8 rounded-md border-0 bg-white/[0.06] ring-1 ring-white/10 px-2.5 py-1 text-left text-sm text-white hover:bg-white/[0.12] hover:ring-white/20 transition-colors"
                        >
                          <span className="font-medium truncate min-w-0">
                            {guestName || 'Client'}
                          </span>
                          <Pencil className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 text-white/60 shrink-0" />
                        </button>
                      )}
                    </div>
                  ) : null
                }
              />
            </div>
            </div>
            {/* 3.9.x: Send to editor on its own centered line (mobile
                mirror) so it never overlaps the filter title. */}
            <div className="flex justify-center">
              {SEND_TO_EDITOR_BUTTON_ENABLED && renderSendToEditor()}
            </div>
          </div>
        )}
        {/* 4.x: the mobile guest "Name" editor moved INTO the comments kebab
            menu (⋮) above — it no longer takes its own row under the header. */}

        {/* Messages Area - Threaded Conversations.
            1.3.2+: on mobile we add bottom padding equal to the
            fixed input wrapper's measured height (+ a small gutter)
            so the last comment is never hidden behind the input.
            Desktop keeps the natural p-4 (input lives in the flex
            column there). */}
        <div
          ref={messagesContainerRef}
          onContextMenu={isAdminView ? openEmptyAreaMenu : undefined}
          className={cn(
            // 1.9.1+: space-y-3 (12px) between comment cards — about
            // half of the old space-y-6 (24px). 4 px was too tight,
            // 24 px too airy; 12 px reads as deliberate separation
            // without wasting vertical space in the list.
            // 7.3.3: `custom-scrollbar`, which the overlays have used since
            // 2.5.0 and this list never got — so a long thread showed the raw
            // OS bar, a bright white slab against a brown workspace.
            "flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 min-h-0 bg-muted/20 custom-scrollbar",
            mobileCollapsible && "order-3 lg:order-1",
            mobileCollapsible && isMobileCollapsed && "hidden lg:block"
          )}
          style={
            mobileCollapsible && isBelowLg
              ? { paddingBottom: `calc(${mobileInputHeight + 16}px + env(safe-area-inset-bottom))` }
              : undefined
          }
        >
          {sortedComments.length === 0 ? (
            previousCommentSource ? (
              <div className="flex flex-col items-center text-center py-10 px-4">
                <MessagesSquare className="w-10 h-10 text-white/20 mb-3" />
                <p className="text-sm font-medium text-foreground">
                  {t('noCommentsHere')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('commentsOnVersion', {
                    count: previousCommentSource.count,
                    version: previousCommentSource.versionLabel,
                  })}
                </p>
                <button
                  type="button"
                  onClick={() => void handlePastePreviousVersion()}
                  disabled={pastingPrevious}
                  className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed transition-[filter]"
                >
                  <ClipboardPaste className="w-3.5 h-3.5" />
                  {/* 7.3.5: while the batch is sitting out the server's
                      per-minute cap, say so. A silent "Pasting…" that lasts a
                      minute is indistinguishable from a hang — which is exactly
                      how this was reported. */}
                  {pastingPrevious
                    ? pasteWaitSeconds !== null
                      ? t('pasteWaitingForLimit', { seconds: pasteWaitSeconds })
                      : t('pastingFromVersion')
                    : t('pasteFromVersion')}
                </button>
                {pasteNote && (
                  <p className="mt-3 max-w-[280px] text-[11px] leading-relaxed text-muted-foreground">
                    {pasteNote}
                  </p>
                )}
              </div>
            ) : (
              <div className="text-center py-12">
                <MessageSquare className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">{t('noMessages')}</p>
              </div>
            )
          ) : (
            <>
              {sortedComments.map((comment, index) => {
                const sequenceNumber = index + 1
                const replies = comment.replies || []
                const video = videos.find(v => v.id === comment.videoId)
                const fps = video?.fps || 24
                const duration = video?.duration
                // 1.0.9+: image assets have no timeline, so a comment
                // on an image never shows a timecode badge and never
                // tries to seek on click.
                const isImageComment = (video as any)?.mediaType === 'IMAGE'
                const showTimestamp =
                  !isImageComment &&
                  typeof comment.timecode === 'string' &&
                  comment.timecode.trim() !== ''
                const timestampLabel = showTimestamp
                  ? formatCommentTimestamp({
                      timecode: comment.timecode,
                      fps,
                      videoDurationSeconds: duration,
                      mode: timestampDisplayMode,
                    })
                  : null
                const timecodeEndLabel = (comment as any).timecodeEnd
                  ? formatCommentTimestamp({
                      timecode: (comment as any).timecodeEnd,
                      fps,
                      videoDurationSeconds: duration,
                      mode: timestampDisplayMode,
                    })
                  : null
                const hasAnnotation = !!(comment as any).annotations

                return (
                  <div
                    key={comment.id}
                    /* 7.3.0: right-click anywhere on the thread opens the batch
                       menu. On the wrapper rather than inside MessageBubble so
                       the whole bubble is the target, including its padding. */
                    onContextMenu={
                      isAdminView
                        ? (e) => openCommentMenu(e, comment.id)
                        : undefined
                    }
                  >
                    <MessageBubble
                      /* 7.3.0: admin view only, deliberately. Two of the three
                         batch actions are delete and resolve, and on the client
                         share the server decides per comment who may do either —
                         so a reviewer would get a menu whose items fail on
                         somebody else's note. Offering it to clients is a
                         separate decision with its own permission questions;
                         this is the workflow Dragos asked for, which is his own
                         review pass. */
                      selectable={!!isAdminView}
                      isSelected={selectedCommentIds.has(comment.id)}
                      onToggleSelect={() => toggleCommentSelected(comment.id)}
                      onSelectFromClick={(mods) => selectFromClick(comment.id, mods)}
                      /* 7.1.0: per-comment Copy also loads the paste
                         clipboard, so one note can be sent to other videos
                         without copying the whole list. Same `toClipped`
                         shape the sidebar kebab writes, so Paste — in the
                         player or on a folder selection — cannot tell the
                         two apart. */
                      onCopyForPaste={(c) => {
                        setClippedComments(projectId, toClipped([c]))
                        setHasClipboardForProject(true)
                      }}
                      comment={comment}
                      isReply={false}
                      onReply={(mentionName) => {
                        setReplyMention(mentionName ?? null)
                        handleReply(comment.id, comment.videoId)
                      }}
                      // 1.0.9+: no seek handler for image comments —
                      // clicking the bubble must do nothing (images
                      // have no timeline).
                      onSeekToTimecode={
                        isImageComment ? undefined : handleSeekToTimecode
                      }
                      onDelete={
                        // Show Delete on the bubble for admins (always) and
                        // for the original author. 1.2.0+: match against
                        // both `client:<browserId>` and the legacy share-
                        // token session id via `isMyComment`. Server-side
                        // DELETE /api/comments/[id] enforces the same.
                        isAdminView || isMyComment(comment)
                          ? () => setPendingDeleteCommentId(comment.id)
                          : undefined
                      }
                      onEdit={(newContent) => handleEditComment(comment.id, newContent)}
                      onEditReply={(replyId, newContent) => handleEditComment(replyId, newContent)}
                      canEdit={isAdminView || isMyComment(comment)}
                      canEditReply={(reply) => isAdminView || isMyComment(reply)}
                      formatMessageTime={formatMessageTime}
                      commentsDisabled={commentsDisabled}
                      sequenceNumber={sequenceNumber}
                      replies={replies}
                      onDeleteReply={(replyId) => {
                        const reply = (replies || []).find((r: any) => r.id === replyId)
                        const canDeleteReply =
                          isAdminView || (!!reply && isMyComment(reply))
                        if (!canDeleteReply) return
                        setPendingDeleteCommentId(replyId)
                      }}
                      timestampLabel={timestampLabel}
                      timecodeEndLabel={timecodeEndLabel}
                      hasAnnotation={hasAnnotation}
                      shareToken={shareToken}
                      onResolveToggle={handleResolveToggle}
                      onReact={handleReact}
                      // 1.3.2+: inline reply input rendered DIRECTLY
                      // under the action row of the comment being
                      // replied to. The user types here, hits Send,
                      // and the reply lands in context — no page jump,
                      // no focus shift to a global input at the bottom.
                      inlineReplyInput={
                        replyingToCommentId === comment.id ? (
                          <InlineReplyForm
                            key={`${comment.id}:${replyMention ?? ''}`}
                            placeholder="Reply to comment..."
                            initialText={replyMention ? `@${replyMention} ` : ''}
                            onSubmit={(text) => {
                              setReplyMention(null)
                              return submitInlineReply(comment.id, comment.videoId, text)
                            }}
                            onCancel={() => {
                              setReplyMention(null)
                              handleCancelReply()
                            }}
                          />
                        ) : null
                      }
                    />
                  </div>
                )
              })}
              {/* Invisible anchor for auto-scroll */}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input Area - Desktop and non-collapsible mobile */}
        <div className={cn(mobileCollapsible && "hidden lg:block lg:order-2")}>
          <CommentInput
          feedingEditId={editingCommentId}
          newComment={newComment}
          onCommentChange={handleCommentChange}
          onInputFocus={handleCommentInputFocus}
          onSubmit={handleSubmitComment}
          loading={loading}
          selectedTimestamp={selectedTimestamp}
          onClearTimestamp={handleClearTimestamp}
          selectedVideoFps={selectedVideoFps}
          selectedVideoDurationSeconds={currentVideoDuration}
          timestampDisplayMode={timestampDisplayMode}
          selectedTimecodeEnd={selectedTimecodeEnd}
          onSetTimecodeEnd={handleSetTimecodeEnd}
          onClearTimecodeEnd={handleClearTimecodeEnd}
          replyingToComment={replyingToComment}
          onCancelReply={handleCancelReply}
          showAuthorInput={!isAdminView && isPasswordProtected}
          authorName={authorName}
          onAuthorNameChange={setAuthorName}
          namedRecipients={namedRecipients}
          nameSource={nameSource}
          selectedRecipientId={selectedRecipientId}
          onNameSourceChange={handleNameSourceChange}
          isOtpAuthenticated={isOtpAuthenticated}
          currentVideoRestricted={currentVideoRestricted}
          restrictionMessage={restrictionMessage}
          commentsDisabled={commentsDisabled}
          allowClientAssetUpload={allowClientAssetUpload}
          maxCommentAttachments={maxCommentAttachments}
          selectedVideoId={selectedVideoId}
          pendingAttachments={pendingAttachments}
          onAttachmentAdded={handleAttachmentAdded}
          onRemoveAttachment={handleRemoveAttachment}
          attachmentError={attachmentError}
          attachmentNotice={attachmentNotice}
          onAttachmentErrorChange={handleAttachmentErrorChange}
          shareToken={shareToken}
          pendingAnnotation={pendingAnnotation}
          onStartDrawing={handleStartDrawing}
          onClearAnnotation={handleClearAnnotation}
          showShortcutsButton={showShortcutsButton}
          onShowShortcuts={handleOpenShortcuts}
        />
        </div>
      </CardContent>
    </Card>
    {/* 1.3.2+: themed confirm dialog for comment deletes — replaces the
        old native window.confirm() ("localhost:3000 says...") so the
        delete prompt matches the rest of the app's UI (same Radix
        Dialog + theme tokens used for project delete, archive, etc.). */}
    {/* 7.3.0: the batch menu. Fixed to the pointer, closed by any mousedown,
        scroll or Escape — the effect that owns those listeners lives beside the
        state. Nudged left/up near the edges so it never opens off-screen. */}
    {commentMenu && typeof document !== 'undefined' && (() => {
      const menuCount = commentMenu.ids.length
      // 7.3.0: "all of them are done" decides the wording, which is the
      // convention a mixed selection needs a rule for: offer the action that
      // moves the batch somewhere, and only offer the undo when there is nothing
      // left to complete.
      const targeted = (displayComments as any[]).filter((c: any) =>
        commentMenu.ids.includes(c.id),
      )
      const menuAllResolved =
        targeted.length > 0 && targeted.every((c: any) => !!c.isResolved)
      return createPortal(
        <div
          role="menu"
          /* 7.3.0: `brand-menu-surface`, which is what CLAUDE.md says a menu
             must use and what the first cut of this menu ignored. It is opaque and blends the
             ACTIVE accent into the dark base via color-mix, so it follows the
             organisation's colour; the hand-rolled recipe I used instead was the
             fixed navy from the glass PANELS, which is why the menu turned up
             blue in a brown workspace. `glass-panel` and its ingredients are for
             page surfaces, never for menus. */
          className="brand-menu-surface fixed z-[2147483600] min-w-[210px] rounded-lg p-1 text-white ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)]"
          ref={commentMenuRef}
          style={{
            top: commentMenuPos?.top ?? commentMenu.y,
            left: commentMenuPos?.left ?? commentMenu.x,
            visibility: commentMenuPos ? 'visible' : 'hidden',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 7.3.0: no header. "1 COMMENT" over a menu you opened on one comment
              said nothing you did not already know. The count belongs in the
              labels, where it changes what the item will DO, and only once there
              is more than one. */}
          {menuCount === 0 ? (
            /* 7.3.3: the empty-area menu. Right-clicking the list where there is
               no comment offers the one thing that makes sense with nothing
               selected — and when the clipboard is empty too, it says so rather
               than not opening. A gesture that produces nothing looks broken. */
            commentMenu.pasteCount ? (
              <button
                role="menuitem"
                type="button"
                disabled={bulkBusy}
                onClick={() => {
                  setCommentMenu(null)
                  // Errors are swallowed exactly as CommentsKebabMenu swallows
                  // them for the same action: `pasteThreads` refetches the list
                  // and fires `commentDeleted`, so the result is visible in the
                  // list itself and there is no toast in this panel to route a
                  // failure to.
                  void handlePasteComments().catch(() => {})
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] transition-colors text-left disabled:opacity-40"
              >
                <ClipboardPaste className="w-4 h-4 shrink-0" />
                <span className="flex-1 whitespace-nowrap">
                  {commentMenu.pasteCount === 1
                    ? 'Paste comment'
                    : `Paste ${commentMenu.pasteCount} comments`}
                </span>
              </button>
            ) : (
              <div
                role="menuitem"
                aria-disabled="true"
                className="px-2 py-1.5 text-sm text-white/40 whitespace-nowrap"
              >
                No actions available
              </div>
            )
          ) : (
            <>
            <button
              role="menuitem"
              type="button"
              disabled={bulkBusy}
              onClick={() => {
                const ids = commentMenu.ids
                setCommentMenu(null)
                bulkCopyComments(ids)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] transition-colors text-left disabled:opacity-40"
            >
              <ClipboardCopy className="w-4 h-4 shrink-0" />
              <span className="flex-1 whitespace-nowrap">
                {menuCount === 1 ? 'Copy' : `Copy ${menuCount} comments`}
              </span>
            </button>
            {commentMenu.ids.length === 1 && (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  const id = commentMenu.ids[0]
                  setCommentMenu(null)
                  // 7.3.0: the bubble owns its edit session, so it is asked rather
                  // than driven — see the listener in MessageBubble. Single
                  // comment only: "edit these eight" is not a thing.
                  window.dispatchEvent(
                    new CustomEvent('comment:startEdit', { detail: { commentId: id } }),
                  )
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] transition-colors text-left"
              >
                <Pencil className="w-4 h-4 shrink-0" />
                <span className="flex-1 whitespace-nowrap">Edit</span>
              </button>
            )}
            <button
              role="menuitem"
              type="button"
              disabled={bulkBusy}
              onClick={() => {
                const ids = commentMenu.ids
                setCommentMenu(null)
                void bulkResolveComments(ids, !menuAllResolved)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-white/[0.08] transition-colors text-left disabled:opacity-40"
            >
              {menuAllResolved ? (
                <XIcon className="w-4 h-4 shrink-0" />
              ) : (
                <Check className="w-4 h-4 shrink-0" />
              )}
              <span className="flex-1 whitespace-nowrap">
                {menuAllResolved
                  ? menuCount === 1
                    ? 'Mark as incomplete'
                    : `Mark ${menuCount} comments as incomplete`
                  : menuCount === 1
                    ? 'Mark as completed'
                    : `Mark ${menuCount} comments as completed`}
              </span>
            </button>
            <div className="my-1 h-px bg-white/10" role="separator" />
            <button
              role="menuitem"
              type="button"
              disabled={bulkBusy}
              onClick={() => {
                const ids = commentMenu.ids
                setCommentMenu(null)
                setPendingBulkDeleteIds(ids)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-destructive/15 text-destructive transition-colors text-left disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4 shrink-0" />
              <span className="flex-1 whitespace-nowrap">
                {menuCount === 1 ? 'Delete' : `Delete ${menuCount} comments`}
              </span>
            </button>
            </>
          )}
        </div>,
        document.body,
      )
    })()}

    {/* 7.3.0: deleting a batch asks once, and says how many. The single-comment
        dialog below is untouched — a batch of one still comes through here, so
        the count in the question is always the truth. */}
    <ConfirmDialog
      open={pendingBulkDeleteIds !== null}
      onOpenChange={(next) => { if (!next) setPendingBulkDeleteIds(null) }}
      variant="destructive"
      title={
        (pendingBulkDeleteIds?.length ?? 0) === 1
          ? 'Delete this comment?'
          : `Delete ${pendingBulkDeleteIds?.length ?? 0} comments?`
      }
      description="This cannot be undone."
      confirmLabel={t('deleteComment')}
      cancelLabel={t('cancel')}
      onConfirm={async () => {
        const ids = pendingBulkDeleteIds
        setPendingBulkDeleteIds(null)
        if (ids) await bulkDeleteComments(ids)
      }}
    />

    <ConfirmDialog
      open={pendingDeleteCommentId !== null}
      onOpenChange={(next) => { if (!next) setPendingDeleteCommentId(null) }}
      variant="destructive"
      title="Delete this comment?"
      description="This cannot be undone."
      confirmLabel={t('deleteComment')}
      cancelLabel={t('cancel')}
      onConfirm={async () => {
        const id = pendingDeleteCommentId
        if (!id) return
        await handleDeleteComment(id)
      }}
    />
    </>
  )
}
