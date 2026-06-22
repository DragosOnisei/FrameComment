'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Comment, Video } from '@prisma/client'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { CheckCircle2, MessageSquare, ChevronDown, ChevronUp, PanelRightClose, Pencil, Check, X as XIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import MessageBubble from './MessageBubble'
import CommentInput from './CommentInput'
import CommentsKebabMenu from './CommentsKebabMenu'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { formatDate } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import { getClientId } from '@/lib/client-id'
import { formatCommentTimestamp, secondsToTimecode, timecodeToSeconds, timecodeToSeekSeconds } from '@/lib/timecode'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  getClippedComments,
  hasClippedComments,
  setClippedComments,
} from '@/lib/comments-clipboard'

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
  isApproved: boolean
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

/**
 * 1.3.2+: lightweight inline reply input rendered inside MessageBubble.
 * Owns its own draft text + submit state so the user can keep typing a
 * top-level comment in the global CommentInput without colliding.
 */
function InlineReplyForm({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string
  onSubmit: (text: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autofocus on mount so the keyboard pops up immediately on phones
  // (and on desktop the cursor lands in the input straight away).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // Slight delay so iOS Safari doesn't fight us on focus.
    const t = setTimeout(() => el.focus(), 50)
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
    <div className="rounded-lg ring-1 ring-border bg-card/60 backdrop-blur-sm p-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
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

export default function CommentSection({
  projectId,
  projectSlug: _projectSlug,
  comments: initialComments,
  focusCommentId = null,
  clientName,
  clientEmail,
  isApproved,
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

  useEffect(() => {
    const onEditStart = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
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
  const COMMENTS_FILTER_LS_KEY = `framecomment:comments-filter:${projectId}`
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
  useEffect(() => {
    try {
      const cached = window.localStorage.getItem(COMMENTS_FILTER_LS_KEY)
      if (cached === 'incomplete' || cached === 'completed' || cached === 'all') {
        setCommentsFilterState(cached)
      }
    } catch {
      /* localStorage might be disabled — ignore, default stays 'all' */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
  const setCommentsFilter = useCallback((next: CommentsFilter) => {
    setCommentsFilterState(next)
    setFilterMenuOpen(false)
    try {
      window.localStorage.setItem(COMMENTS_FILTER_LS_KEY, next)
    } catch {
      /* swallow */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
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
      const cached = window.localStorage.getItem(GUEST_NAME_LS_KEY)
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
  }, [isAdminView, shareToken, fetchComments])

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
        if (card) card.classList.add('is-selected')
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
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  // Listen for immediate comment updates (delete, approve, post, etc.)
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
    window.addEventListener('videoApprovalChanged', handleCommentUpdate)

    return () => {
      window.removeEventListener('commentDeleted', handleCommentUpdate)
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
      window.removeEventListener('videoApprovalChanged', handleCommentUpdate)
    }
  }, [projectId, fetchComments])

  // Get latest video version
  const latestVideoVersion = videos.length > 0
    ? Math.max(...videos.map(v => v.version))
    : null

  // Check if currently selected video is approved
  const currentVideo = videos.find(v => v.id === selectedVideoId)
  const currentVideoDuration = currentVideo?.duration ?? null
  const isCurrentVideoApproved = currentVideo ? (currentVideo as any).approved === true : false
  // Check if ANY video in the group is approved (for admin view with multiple versions)
  const hasAnyApprovedVideo = videos.some(v => (v as any).approved === true)
  const approvedVideo = videos.find(v => (v as any).approved === true)
  const commentsDisabled = isApproved || isCurrentVideoApproved || hasAnyApprovedVideo

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

  // Sort top-level comments chronologically
  const sortedComments = [...visibleComments].sort((a, b) => {
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
  useEffect(() => {
    setHasClipboardForProject(hasClippedComments(projectId))
    // React to other tabs (or our own clear() call) flipping the
    // localStorage entry.
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('framecomment:clipboard:comments')) return
      setHasClipboardForProject(hasClippedComments(projectId))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [projectId])

  const handleCopyComments = useCallback(() => {
    // Snapshot what's currently visible in the sidebar (already
    // filtered to the active video by `displayComments`). Includes
    // replies as standalone entries on paste — a reasonable
    // simplification for a single-pass version-bump review.
    const flat = displayComments.map((c: any) => ({
      content: c.content,
      timecode: c.timecode,
      timecodeEnd: c.timecodeEnd ?? null,
      timestampMs: typeof c.timestampMs === 'number' ? c.timestampMs : null,
      authorName: c.authorName ?? null,
    }))
    setClippedComments(projectId, flat)
    setHasClipboardForProject(flat.length > 0)
    return { count: flat.length }
  }, [displayComments, projectId])

  const handlePasteComments = useCallback(async () => {
    const items = getClippedComments(projectId)
    if (!items || items.length === 0) {
      throw new Error('Nothing to paste')
    }
    if (!selectedVideoId) {
      throw new Error('No video selected')
    }
    // Sequential POSTs so the backend rate-limiter doesn't reject
    // half of them and so the order is preserved in the timeline.
    let created = 0
    for (const item of items) {
      const body: Record<string, unknown> = {
        projectId,
        videoId: selectedVideoId,
        timecode: item.timecode,
        content: item.content,
        isInternal: !!isAdminView,
      }
      if (item.timecodeEnd) body.timecodeEnd = item.timecodeEnd
      if (typeof item.timestampMs === 'number') body.timestampMs = item.timestampMs
      if (item.authorName) body.authorName = item.authorName
      const res = isAdminView
        ? await apiFetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/comments', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
            },
            body: JSON.stringify(body),
          })
      if (res.ok) created += 1
    }
    // Refresh the sidebar so the pasted comments show up.
    await fetchComments()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('commentDeleted'))
    }
    return { count: created }
  }, [projectId, selectedVideoId, isAdminView, shareToken, fetchComments])

  // 1.3.2+: bridge between this section and the top-level PlayerTopMenu.
  // The menu lives outside CommentSection (in the title bar) but Copy /
  // Paste comments needs the local clipboard handlers + current video
  // context. Custom window events keep the wiring tiny — the menu fires
  // `commentClipboard:copy|paste`, we run the handler and reply with a
  // `commentClipboard:result` event so the menu can show a toast.
  useEffect(() => {
    const reply = (
      detail:
        | { kind: 'copied' | 'pasted'; count: number }
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
        reply({ kind: 'pasted', count: r.count })
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
      className="border-0 flex flex-col h-full lg:max-h-full rounded-none lg:rounded-2xl overflow-hidden bg-white/[0.06] ring-1 ring-white/15 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.55)] text-white"
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
                  className="fixed z-[200] min-w-[220px] rounded-lg ring-1 ring-white/15 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-1 text-sm text-white animate-in fade-in-0 slide-in-from-top-1 duration-150"
                  style={{
                    left: filterMenuCoords.left,
                    top: filterMenuCoords.top,
                    backgroundColor: 'rgba(22, 37, 51, 0.35)',
                    backgroundImage:
                      'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.20) 0%, hsl(var(--spotlight-tint) / 0.05) 45%, transparent 75%)',
                    backdropFilter: 'blur(40px) saturate(180%)',
                    WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                    transform: 'translate3d(0, 0, 0)',
                    willChange: 'backdrop-filter, transform',
                    isolation: 'isolate',
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
          <div className="flex items-center gap-0.5 shrink-0">
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
          <div className="mt-2 flex items-center gap-2 text-sm">
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
                  className="flex-1 min-w-0 h-8 rounded-md border border-input bg-background px-2.5 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                className="group flex items-center justify-between gap-2 flex-1 min-w-0 h-8 rounded-md border border-input bg-background px-2.5 py-1 text-left text-sm text-foreground hover:border-primary/50 hover:bg-muted/40 transition-colors"
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
        {/* Approval Status Banner */}
        {commentsDisabled && (
          <div className="bg-success-visible border-b-2 border-success-visible p-4 flex-shrink-0">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-success flex-shrink-0" />
              <div>
                <h3 className="text-foreground font-medium">
                  {isApproved ? t('projectApproved') : t('videoApproved')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {isApproved
                    ? t('approvedDownloadReady')
                    : approvedVideo
                    ? t('versionApprovedDownload', { versionLabel: approvedVideo.versionLabel })
                    : t('aVersionApprovedDownload')}
                </p>
              </div>
            </div>
          </div>
        )}

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
              backgroundColor: 'rgba(22, 37, 51, 0.62)',
              backgroundImage:
                'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              transform: 'translate3d(0, 0, 0)',
              willChange: 'backdrop-filter, transform',
              isolation: 'isolate',
            }}
          >
            <CommentInput
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
          <div className="order-2 lg:hidden w-full px-3 py-2 flex items-center justify-between bg-muted/30">
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
            <CommentsKebabMenu
              commentCount={displayComments.length}
              hasClipboard={hasClipboardForProject}
              onCopy={handleCopyComments}
              onPaste={handlePasteComments}
            />
          </div>
        )}
        {/*
          1.2.0+: same editable name row for guests on mobile. Sits
          right under the collapsible header so it's findable without
          scrolling.
        */}
        {mobileCollapsible && !isAdminView && !isMobileCollapsed && (
          <div className="order-2 lg:hidden px-3 py-2 border-b border-border/50 flex items-center gap-2 text-sm bg-muted/10">
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
                  className="flex-1 min-w-0 h-8 rounded-md border border-input bg-background px-2.5 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveRename()}
                  disabled={savingName || !nameDraft.trim()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40"
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
              <button
                type="button"
                onClick={handleStartRename}
                className="group flex items-center justify-between gap-2 flex-1 min-w-0 h-8 rounded-md border border-input bg-background px-2.5 py-1 text-left text-sm text-foreground hover:border-primary/50 hover:bg-muted/40 transition-colors"
              >
                <span className="font-medium truncate min-w-0">
                  {guestName || 'Client'}
                </span>
                <Pencil className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 text-muted-foreground shrink-0" />
              </button>
            )}
          </div>
        )}

        {/* Messages Area - Threaded Conversations.
            1.3.2+: on mobile we add bottom padding equal to the
            fixed input wrapper's measured height (+ a small gutter)
            so the last comment is never hidden behind the input.
            Desktop keeps the natural p-4 (input lives in the flex
            column there). */}
        <div
          ref={messagesContainerRef}
          className={cn(
            // 1.9.1+: space-y-3 (12px) between comment cards — about
            // half of the old space-y-6 (24px). 4 px was too tight,
            // 24 px too airy; 12 px reads as deliberate separation
            // without wasting vertical space in the list.
            "flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-3 min-h-0 bg-muted/20",
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
            <div className="text-center py-12">
              <MessageSquare className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">{t('noMessages')}</p>
            </div>
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
                  <div key={comment.id}>
                    <MessageBubble
                      comment={comment}
                      isReply={false}
                      onReply={() => handleReply(comment.id, comment.videoId)}
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
                            placeholder="Reply to comment..."
                            onSubmit={(text) =>
                              submitInlineReply(comment.id, comment.videoId, text)
                            }
                            onCancel={handleCancelReply}
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
