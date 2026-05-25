'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Comment, Video, Prisma } from '@prisma/client'
import { useRouter } from 'next/navigation'
import { apiPost, apiDelete } from '@/lib/api-client'
import { secondsToTimecode, timecodeToSeconds } from '@/lib/timecode'
import { AnnotationData } from '@/types/annotations'
import { logError } from '@/lib/logging'
import { getClientId } from '@/lib/client-id'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

interface PendingAttachment {
  assetId: string
  videoId: string
  fileName: string
  fileSize: string
  fileType: string
  category: string
}

interface UseCommentManagementProps {
  projectId: string
  initialComments: CommentWithReplies[]
  videos: Video[]
  clientEmail?: string
  isPasswordProtected: boolean
  adminUser?: any
  recipients: Array<{ id: string; name: string | null; email: string | null }>
  clientName: string
  restrictToLatestVersion: boolean
  shareToken?: string | null
  useAdminAuth?: boolean
  authenticatedEmail?: string | null
}

export function useCommentManagement({
  projectId,
  initialComments,
  videos,
  clientEmail,
  isPasswordProtected,
  adminUser = null,
  recipients,
  clientName: _clientName,
  restrictToLatestVersion,
  shareToken = null,
  useAdminAuth = false,
  authenticatedEmail = null,
}: UseCommentManagementProps) {
  const router = useRouter()

  // State
  const [optimisticComments, setOptimisticComments] = useState<CommentWithReplies[]>([])
  const [newComment, setNewComment] = useState('')
  const [selectedTimestamp, setSelectedTimestamp] = useState<number | null>(null) // Internal: still use seconds for video player integration
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasAutoFilledTimestamp, setHasAutoFilledTimestamp] = useState(false)
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  const [pendingAnnotation, setPendingAnnotation] = useState<AnnotationData | null>(null)
  // Mirror of `pendingAnnotation` kept in a ref so synchronous flows (e.g.
  // "click Send while still in drawing mode → finish drawing → submit
  // immediately") can read the current annotation without waiting for a
  // React re-render.
  const pendingAnnotationRef = useRef<AnnotationData | null>(null)
  const [selectedTimecodeEnd, setSelectedTimecodeEnd] = useState<string | null>(null)
  const attachmentUploadCountRef = useRef(0)
  const previousVideoIdRef = useRef<string | null>(null)

  // Author name management
  const namedRecipients = recipients.filter(r => r.name && r.name.trim() !== '')

  // Auto-select recipient if authenticatedEmail is provided
  useEffect(() => {
    if (authenticatedEmail && recipients.length > 0) {
      const matchingRecipient = recipients.find(r => 
        r.email?.toLowerCase() === authenticatedEmail.toLowerCase()
      )
      
      if (matchingRecipient && matchingRecipient.name) {
        // Auto-select this recipient
        setNameSource('recipient')
        setSelectedRecipientId(matchingRecipient.id)
        setAuthorName(matchingRecipient.name)
        
        // Save to localStorage 
        const storageKey = `comment-name-${projectId}`
        try {
          localStorage.setItem(storageKey, JSON.stringify({
            nameSource: 'recipient',
            selectedRecipientId: matchingRecipient.id,
            authorName: matchingRecipient.name
          }))
        } catch (error) {
          logError('Failed to save authenticated name:', error)
        }
      }
    }
  }, [authenticatedEmail, recipients, projectId])

  // Load persisted name selection from localStorage (persists across sessions)
  const storageKey = `comment-name-${projectId}`
  const loadPersistedName = () => {
    if (typeof window === 'undefined') return null
    try {
      const stored = localStorage.getItem(storageKey)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  }

  const persistedName = loadPersistedName()
  const [authorName, setAuthorName] = useState(persistedName?.authorName || '')
  const [nameSource, setNameSource] = useState<'recipient' | 'custom' | 'none'>(persistedName?.nameSource || 'none')
  const [selectedRecipientId, setSelectedRecipientId] = useState(persistedName?.selectedRecipientId || '')

  // Merge real comments with optimistic comments
  // Remove optimistic comments that have been confirmed by the server
  const activeOptimisticComments = optimisticComments.filter(oc => {
    // If this optimistic comment has a temp ID, check if a real version exists
    if (oc.id.startsWith('temp-')) {
      // Check top-level comments for matching content and similar timestamp
      const hasRealVersionTopLevel = initialComments.some(rc =>
        rc.content === oc.content &&
        rc.videoId === oc.videoId &&
        Math.abs(new Date(rc.createdAt).getTime() - new Date(oc.createdAt).getTime()) < 10000
      )

      // Check nested replies for matching content and similar timestamp
      const hasRealVersionInReplies = initialComments.some(rc =>
        rc.replies?.some((reply: any) =>
          reply.content === oc.content &&
          reply.videoId === oc.videoId &&
          Math.abs(new Date(reply.createdAt).getTime() - new Date(oc.createdAt).getTime()) < 10000
        )
      )

      return !hasRealVersionTopLevel && !hasRealVersionInReplies
    }

    // Keep non-temp comments (shouldn't happen, but safe fallback)
    return true
  })

  // Merge optimistic comments properly (nest replies under parent comments)
  const mergedComments = initialComments.map(comment => {
    // Find optimistic replies for this comment
    const optimisticReplies = activeOptimisticComments.filter(oc => oc.parentId === comment.id)

    if (optimisticReplies.length > 0) {
      return {
        ...comment,
        replies: [...(comment.replies || []), ...optimisticReplies]
      }
    }
    return comment
  })

  // Add optimistic top-level comments (no parentId)
  const optimisticTopLevel = activeOptimisticComments.filter(oc => !oc.parentId)
  const comments = [...mergedComments, ...optimisticTopLevel]

  const cleanupAttachmentAsset = useCallback(async (attachment: PendingAttachment) => {
    try {
      if (shareToken) {
        await fetch(`/api/videos/${attachment.videoId}/client-assets?assetId=${attachment.assetId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${shareToken}` },
        })
      } else if (useAdminAuth) {
        await apiDelete(`/api/videos/${attachment.videoId}/client-assets?assetId=${attachment.assetId}`)
      } else {
        await fetch(`/api/videos/${attachment.videoId}/client-assets?assetId=${attachment.assetId}`, {
          method: 'DELETE',
        })
      }
    } catch {
      // Best-effort cleanup only. Ignore errors for now.
    }
  }, [shareToken, useAdminAuth])

  // Auto-select first video when videos list changes (admin panel without player)
  useEffect(() => {
    if (videos.length > 0 && !selectedVideoId) {
      setSelectedVideoId(videos[0].id)
    }
  }, [videos, selectedVideoId])

  // Clear pending attachments when user switches to a different video context.
  useEffect(() => {
    const previousVideoId = previousVideoIdRef.current
    if (
      previousVideoId &&
      selectedVideoId &&
      selectedVideoId !== previousVideoId &&
      pendingAttachments.length > 0
    ) {
      const staleAttachments = pendingAttachments.filter(a => a.videoId !== selectedVideoId)
      if (staleAttachments.length > 0) {
        setPendingAttachments(prev => prev.filter(a => a.videoId === selectedVideoId))
        setAttachmentError(null)
        setAttachmentNotice('Attachments were cleared because you switched videos.')
        staleAttachments.forEach((attachment) => {
          void cleanupAttachmentAsset(attachment)
        })
      }
    }
    previousVideoIdRef.current = selectedVideoId
  }, [selectedVideoId, pendingAttachments, cleanupAttachmentAsset])

  // Sync with video player if available (share page with player)
  // Reduced from 1s to 5s to prevent UI lag during heavy interaction
  useEffect(() => {
    const syncCurrentVideo = () => {
      window.dispatchEvent(
        new CustomEvent('getSelectedVideoId', {
          detail: {
            callback: (videoId: string) => {
              if (videoId && videoId !== selectedVideoId) {
                setSelectedVideoId(videoId)
              }
            },
          },
        })
      )
    }

    syncCurrentVideo()
    const interval = setInterval(syncCurrentVideo, 5000) // Changed from 1000ms to 5000ms
    return () => clearInterval(interval)
  }, [selectedVideoId])

  // Listen for immediate video changes from VideoPlayer (for responsive comment updates)
  useEffect(() => {
    const handleVideoChange = (e: CustomEvent) => {
      const { videoId } = e.detail
      if (videoId && videoId !== selectedVideoId) {
        setSelectedVideoId(videoId)
      }
    }

    window.addEventListener('videoChanged', handleVideoChange as EventListener)
    return () => {
      window.removeEventListener('videoChanged', handleVideoChange as EventListener)
    }
  }, [selectedVideoId])

  // Listen for video selection from admin page (message icon clicks)
  useEffect(() => {
    const handleSelectVideo = (e: CustomEvent) => {
      const { videoId } = e.detail
      if (videoId) {
        setSelectedVideoId(videoId)
      }
    }

    window.addEventListener('selectVideoForComments', handleSelectVideo as EventListener)
    return () => {
      window.removeEventListener('selectVideoForComments', handleSelectVideo as EventListener)
    }
  }, [])

  // Listen for add comment events from video player
  useEffect(() => {
    const handleAddComment = (e: CustomEvent) => {
      setSelectedVideoId(e.detail.videoId)
      setSelectedTimestamp(e.detail.timestamp)
      setHasAutoFilledTimestamp(true)
    }

    window.addEventListener('addComment', handleAddComment as EventListener)
    return () => {
      window.removeEventListener('addComment', handleAddComment as EventListener)
    }
  }, [])

  // Shared helper: capture a timestamp + video for the comment input
  const captureTimestamp = useCallback((time: number, videoId: string) => {
    setSelectedTimestamp(time)
    setSelectedVideoId(videoId)
    setHasAutoFilledTimestamp(true)
    // Single-frame selection by default — no auto-seeded out range.
    // The drag handle on the timeline still appears (at the IN
    // position when there's no OUT yet) so the user can grab it and
    // pull a range when they actually want one.
  }, [])

  // Listen for annotationComplete event from drawing mode
  useEffect(() => {
    const handleAnnotationComplete = (e: CustomEvent) => {
      const { annotations, timecodeStart, timecodeEnd, videoId } = e.detail
      if (annotations) {
        pendingAnnotationRef.current = annotations
        setPendingAnnotation(annotations)
      }
      if (timecodeEnd) {
        setSelectedTimecodeEnd(timecodeEnd)
      }
      if (timecodeStart && videoId) {
        const video = videos.find(v => v.id === videoId)
        const fps = video?.fps || 24
        captureTimestamp(timecodeToSeconds(timecodeStart, fps), videoId)
      }
    }

    window.addEventListener('annotationComplete', handleAnnotationComplete as EventListener)
    return () => {
      window.removeEventListener('annotationComplete', handleAnnotationComplete as EventListener)
    }
  }, [videos, captureTimestamp])

  // Keep selectedTimestamp in sync when the user frame-steps while commenting.
  //
  // 1.3.2+: CRITICAL guard — do NOT re-sync IN when a range OUT has been
  // set (selectedTimecodeEnd !== null). Otherwise, when the user drags the
  // yellow OUT handle (which calls onSeek(safeOut) every move → fires a
  // videoTimeUpdated event), this handler races with the setCommentRange
  // listener and clobbers selectedTimestamp with the OUT time, collapsing
  // the range into a single frame at OUT. The user observed this as
  // "white ball jumps onto the yellow ball when I release the drag".
  // The frame-step use case only applies to single-frame selections
  // anyway, so this guard doesn't break the original intent.
  useEffect(() => {
    const handleVideoTimeUpdated = (e: CustomEvent) => {
      const time = e.detail?.time
      const videoId = e.detail?.videoId

      if (typeof time !== 'number') return
      if (!videoId || videoId !== selectedVideoId) return
      if (!hasAutoFilledTimestamp || selectedTimestamp === null) return
      // 1.3.2+: never touch IN once an OUT (range) is committed.
      if (selectedTimecodeEnd !== null) return

      setSelectedTimestamp(time)
    }

    window.addEventListener('videoTimeUpdated', handleVideoTimeUpdated as EventListener)
    return () => {
      window.removeEventListener('videoTimeUpdated', handleVideoTimeUpdated as EventListener)
    }
  }, [hasAutoFilledTimestamp, selectedTimestamp, selectedTimecodeEnd, selectedVideoId])

  // Broadcast the current pending in/out range so the timeline (which
  // lives several components away) can paint the IN bracket and the
  // range bar without prop drilling. Fires on every change so the
  // timeline always reflects the latest state.
  useEffect(() => {
    const fps =
      videos.find((v: any) => v.id === selectedVideoId)?.fps || 24
    const outTime = selectedTimecodeEnd
      ? timecodeToSeconds(selectedTimecodeEnd, fps)
      : null
    window.dispatchEvent(
      new CustomEvent('commentRangeStateChanged', {
        detail: {
          inTime: selectedTimestamp,
          outTime,
          videoId: selectedVideoId,
        },
      })
    )
  }, [selectedTimestamp, selectedTimecodeEnd, selectedVideoId, videos])

  // The timeline tells us when the user clicks past the in marker —
  // we treat that click as setting the OUT point rather than a seek,
  // so they can pick a range with a single click after focusing the
  // input.
  useEffect(() => {
    const handleSetOut = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      const time = detail.time
      if (typeof time !== 'number' || !Number.isFinite(time)) return
      if (selectedTimestamp === null || time <= selectedTimestamp) return
      const fps =
        videos.find((v: any) => v.id === selectedVideoId)?.fps || 24
      setSelectedTimecodeEnd(secondsToTimecode(time, fps))
    }
    window.addEventListener('setCommentOutPoint', handleSetOut as EventListener)
    return () => {
      window.removeEventListener('setCommentOutPoint', handleSetOut as EventListener)
    }
  }, [selectedTimestamp, selectedVideoId, videos])

  // 1.3.2+: atomic range setter — sets BOTH IN and OUT in one event.
  // CustomVideoControls fires this when the user drags the always-on
  // yellow OUT handle: the IN is snapshotted from where the white
  // playhead was when the drag started, OUT follows the finger. We
  // also accept `inTime: null` to clear the pending range (used when
  // the user taps somewhere else on the timeline to start fresh).
  useEffect(() => {
    const handleSetRange = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      const { inTime, outTime, videoId: evVideoId } = detail
      // Null clears the range entirely (e.g. tap-elsewhere on
      // timeline). We DON'T touch hasAutoFilledTimestamp so a
      // subsequent input focus will still re-capture properly.
      if (inTime === null) {
        setSelectedTimestamp(null)
        setSelectedTimecodeEnd(null)
        return
      }
      if (typeof inTime !== 'number' || !Number.isFinite(inTime)) return
      // Set videoId first if we don't have one yet — the OUT handle
      // drag can start before the input is ever focused.
      if (typeof evVideoId === 'string' && evVideoId.length > 0) {
        setSelectedVideoId(evVideoId)
      }
      setSelectedTimestamp(inTime)
      setHasAutoFilledTimestamp(true)
      // OUT is optional; when omitted or equal to IN we leave it
      // null (single-frame selection). Otherwise we snap to the
      // active video's fps so the timecode is frame-quantized.
      const targetVid = typeof evVideoId === 'string' ? evVideoId : selectedVideoId
      const fps = videos.find((v: any) => v.id === targetVid)?.fps || 24
      if (
        typeof outTime === 'number' &&
        Number.isFinite(outTime) &&
        outTime > inTime + 1 / fps - 0.001
      ) {
        setSelectedTimecodeEnd(secondsToTimecode(outTime, fps))
      } else {
        setSelectedTimecodeEnd(null)
      }
    }
    window.addEventListener('setCommentRange', handleSetRange as EventListener)
    return () => {
      window.removeEventListener(
        'setCommentRange',
        handleSetRange as EventListener,
      )
    }
  }, [selectedVideoId, videos])

  // Auto-fill timestamp when user starts typing
  const handleCommentChange = (value: string) => {
    setNewComment(value)
    setAttachmentError(null)

    if (value.length > 0 && !hasAutoFilledTimestamp && selectedTimestamp === null) {
      // Pause video and capture timestamp when user starts typing
      window.dispatchEvent(new CustomEvent('pauseVideoForComment'))

      window.dispatchEvent(
        new CustomEvent('getCurrentTime', {
          detail: { callback: captureTimestamp },
        })
      )
    }
  }

  // Frame.io-style "click on the input → in marker at playhead". Same
  // pause-and-capture flow as typing, but fires on focus instead of on
  // first keystroke. Only runs when there's no timestamp yet, so an
  // 1.1.1+: re-focusing the textarea always re-captures the current
  // playhead as the new IN point. The previous behaviour skipped
  // re-capture once `hasAutoFilledTimestamp` flipped true, so if you
  // clicked the input, then scrubbed elsewhere on the timeline, then
  // clicked the input again, the IN marker stayed where it was —
  // forcing you to clear and start over. Now every focus syncs IN
  // to "wherever the playhead is right now". Any user-defined OUT is
  // dropped because a range anchored to a now-stale IN is more
  // confusing than helpful — the orange handle takes ~1 second to
  // re-drag.
  const handleCommentInputFocus = useCallback(() => {
    // 1.3.2+: only RE-capture IN + clear OUT on the FIRST focus (when
    // there's no active comment range yet). If the user has already
    // dropped an IN (and maybe dragged the orange OUT handle to make
    // a range) and is just re-tapping the input to bring up the
    // keyboard / type their comment, we MUST NOT touch the range.
    // The previous behaviour wiped selectedTimecodeEnd on every focus
    // and re-captured IN at the current playhead, killing the
    // selection the user had just made.
    if (selectedTimestamp !== null) return
    setSelectedTimecodeEnd(null)
    window.dispatchEvent(new CustomEvent('pauseVideoForComment'))
    window.dispatchEvent(
      new CustomEvent('getCurrentTime', {
        detail: { callback: captureTimestamp },
      })
    )
  }, [captureTimestamp, selectedTimestamp])

  // Submit comment
  const handleSubmitComment = async () => {
    const attachmentsForVideo = pendingAttachments.filter(a => a.videoId === selectedVideoId)
    const hasAttachments = attachmentsForVideo.length > 0
    const hasAnnotations = !!pendingAnnotation

    if (!newComment.trim() && !hasAttachments && !hasAnnotations) return

    // Prevent rapid-fire submissions
    if (loading) return

    if (!selectedVideoId) {
      alert('Please select a video before commenting.')
      return
    }

    if (useAdminAuth && !adminUser) {
      alert('Admin session not loaded yet. Please wait a moment and try again.')
      return
    }

    // Prevent anonymous comments when named recipients are available
    if (!useAdminAuth && isPasswordProtected && namedRecipients.length > 0 && nameSource === 'none') {
      alert('Please select your name from the dropdown or choose "Custom Name" before commenting.')
      return
    }

    const validatedVideoId: string = selectedVideoId
    setAttachmentError(null)
    setAttachmentNotice(null)

    // Check if commenting on latest version only
    if (restrictToLatestVersion) {
      const latestVideoVersion = videos.length > 0 ? Math.max(...videos.map(v => v.version)) : null
      const selectedVideo = videos.find(v => v.id === validatedVideoId)
      if (selectedVideo && selectedVideo.version !== latestVideoVersion) {
        alert('Comments are only allowed on the latest version of this project.')
        return
      }
    }

    setLoading(true)

    // The server now accepts an empty `content` when the comment carries an
    // attachment or annotation, so we no longer fabricate placeholder text
    // like "Attachments uploaded #1" or "Drawing annotation". An empty
    // string is sent through and the bubble renders just the attachment(s)
    // or drawing.
    const commentContent = newComment

    // OPTIMISTIC UPDATE
    const isInternalComment = useAdminAuth || !!adminUser
    // Convert seconds to timecode for API and storage
    const selectedVideo = videos.find(v => v.id === validatedVideoId)
    const fps = selectedVideo?.fps || 24 // Default to 24fps if not available
    // 1.0.9+: image assets have no timeline, so their comments carry
    // no capture moment. The server still requires a syntactically
    // valid `timecode`, so we keep the harmless `00:00:00:00` default
    // for images — but we never send `timestampMs`, and the UI
    // (CommentSection / MessageBubble) suppresses the timecode badge
    // and any click-to-seek for image comments anyway.
    const isImageComment = (selectedVideo as any)?.mediaType === 'IMAGE'
    const timecode =
      !isImageComment && selectedTimestamp !== null
        ? secondsToTimecode(selectedTimestamp, fps)
        : '00:00:00:00'

    const optimisticComment: CommentWithReplies = {
      id: `temp-${Date.now()}`,
      projectId,
      videoId: validatedVideoId,
      videoVersion: videos.find(v => v.id === validatedVideoId)?.version || null,
      timecode,
      // Sub-second precision moment for click-to-seek (1.0.3+).
      // Always null for image comments.
      timestampMs:
        !isImageComment &&
        typeof selectedTimestamp === 'number' &&
        Number.isFinite(selectedTimestamp)
          ? Math.max(0, Math.round(selectedTimestamp * 1000))
          : null,
      timecodeEnd: selectedTimecodeEnd || null,
      annotations: (pendingAnnotation as Prisma.JsonValue) || null,
      content: commentContent,
      // 1.2.0+: if the guest has chosen / edited a display name, use it
      // on the optimistic row too so there's no brief flash of "Client"
      // before the server response lands. Falls back to "Client" for
      // viewers that never opened the rename field.
      authorName: isInternalComment
        ? (adminUser!.name || 'Admin')
        : (authorName?.trim() || (isPasswordProtected ? authorName : 'Client')),
      authorEmail: isInternalComment ? null : (clientEmail || null),
      isInternal: isInternalComment,
      createdAt: new Date(),
      updatedAt: new Date(),
      parentId: replyingToCommentId,
      userId: null,
      editorSessionId: null,
      // 1.2.0+: resolved bookkeeping defaults — a brand-new comment is
      // never resolved at creation time.
      isResolved: false,
      resolvedAt: null,
      resolvedBy: null,
      replies: [],
    }

    setOptimisticComments(prev => [...prev, optimisticComment])

    // Clear form immediately (but keep video selected for next comment)
    const commentTimestamp = selectedTimestamp
    const commentVideoId = validatedVideoId
    const commentParentId = replyingToCommentId
    setNewComment('')
    setSelectedTimestamp(null)
    // Keep selectedVideoId so user can post multiple comments
    setHasAutoFilledTimestamp(false)
    setReplyingToCommentId(null)
    // Snapshot the annotation BEFORE clearing — handleSubmit runs the API
    // call below and we need to read the value the user just drew, not the
    // freshly-cleared state.
    const annotationForSubmit = pendingAnnotationRef.current
    pendingAnnotationRef.current = null
    setPendingAnnotation(null)
    setSelectedTimecodeEnd(null)
    const attachmentsForComment = pendingAttachments.filter(a => a.videoId === validatedVideoId)
    const commentAssetIds = attachmentsForComment.map(a => a.assetId)
    setPendingAttachments(prev => prev.filter(a => !commentAssetIds.includes(a.assetId)))

    try {
      // Convert timestamp to timecode for API
      const commentVideo = videos.find(v => v.id === commentVideoId)
      const fps = commentVideo?.fps || 24
      // 1.0.9+: image comments carry no capture moment — see the
      // optimistic-comment block above for the full rationale.
      const commentIsImage = (commentVideo as any)?.mediaType === 'IMAGE'
      const commentTimecode =
        !commentIsImage && commentTimestamp !== null
          ? secondsToTimecode(commentTimestamp, fps)
          : '00:00:00:00'

      // Build request body - only include fields with values
      const requestBody: any = {
        projectId,
        videoId: commentVideoId,
        timecode: commentTimecode,
        content: commentContent,
        isInternal: isInternalComment,
      }

      // Sub-second precision capture moment so the server-side
      // `timestampMs` field can be the source of truth for click-to-seek.
      // The timecode field is frame-quantized; without this, round-tripping
      // through HH:MM:SS:FF loses up to ~21ms at 24fps. Skipped entirely
      // for image comments — they have no timeline.
      if (
        !commentIsImage &&
        typeof commentTimestamp === 'number' &&
        Number.isFinite(commentTimestamp)
      ) {
        requestBody.timestampMs = Math.max(0, Math.round(commentTimestamp * 1000))
      }

      // Include annotation data if present (using the ref snapshot — see
      // pendingAnnotationRef declaration for why).
      if (annotationForSubmit) {
        requestBody.annotations = annotationForSubmit
      }
      if (selectedTimecodeEnd) {
        requestBody.timecodeEnd = selectedTimecodeEnd
      }

      // Add optional fields only if they have values
      if (isInternalComment) {
        requestBody.authorName = adminUser!.name || 'Admin'
      } else {
        if (authorName) requestBody.authorName = authorName
        if (clientEmail) requestBody.authorEmail = clientEmail
        if (nameSource === 'recipient' && selectedRecipientId) {
          requestBody.recipientId = selectedRecipientId
        }
      }

      // Only include parentId if replying (not null)
      if (commentParentId) {
        requestBody.parentId = commentParentId
      }

      // Include asset IDs if any attachments were added
      if (commentAssetIds.length > 0) {
        requestBody.assetIds = commentAssetIds
      }

      // Submit comment in background without blocking UI
      const submitPromise = shareToken
        ? fetch('/api/comments', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${shareToken}`,
              // Per-browser id (1.0.7+) so two anonymous viewers on
              // the same IP get distinct sessions on the server.
              'X-Framecomment-Client-Id': getClientId(),
            },
            body: JSON.stringify(requestBody),
          }).then(async response => {
            if (!response.ok) {
              const err = await response.json().catch(() => ({}))
              throw new Error(err.error || 'Failed to submit comment')
            }
            return response.json() // Return the updated comments list
          })
        : useAdminAuth
        ? apiPost('/api/comments', requestBody) // apiPost already returns parsed JSON
        : Promise.reject(new Error('Authentication required to submit comment'))

      // Handle submission result in background
      submitPromise
        .then((updatedComments) => {
          // Clear the optimistic comment immediately since we have real data
          setOptimisticComments(prev => prev.filter(c => c.id !== optimisticComment.id))

          // Refresh in background (non-blocking)
          router.refresh()

          // Trigger immediate update with the fresh comments data
          window.dispatchEvent(new CustomEvent('commentPosted', {
            detail: { comments: updatedComments }
          }))
        })
        .catch((error) => {
          // Remove optimistic comment and restore form on error
          setOptimisticComments(prev => prev.filter(c => c.id !== optimisticComment.id))
          setNewComment(commentContent)
          setSelectedTimestamp(commentTimestamp)
          setSelectedVideoId(commentVideoId)
          setAttachmentError(error instanceof Error ? error.message : 'Failed to submit comment')
          setPendingAttachments(prev => {
            const existingIds = new Set(prev.map(a => a.assetId))
            const toRestore = attachmentsForComment.filter(a => !existingIds.has(a.assetId))
            return toRestore.length > 0 ? [...prev, ...toRestore] : prev
          })
        })

      // UI is already unblocked - loading state cleared immediately
    } catch (error) {
      // Handle synchronous errors only
      setOptimisticComments(prev => prev.filter(c => c.id !== optimisticComment.id))
      setNewComment(commentContent)
      setSelectedTimestamp(commentTimestamp)
      setSelectedVideoId(commentVideoId)
      setAttachmentError(error instanceof Error ? error.message : 'Failed to submit comment')
      setPendingAttachments(prev => {
        const existingIds = new Set(prev.map(a => a.assetId))
        const toRestore = attachmentsForComment.filter(a => !existingIds.has(a.assetId))
        return toRestore.length > 0 ? [...prev, ...toRestore] : prev
      })
    } finally {
      // Clear loading immediately so UI is not blocked
      setLoading(false)
    }
  }

  const handleReply = (commentId: string, videoId: string) => {
    // 1.3.2+: toggle behaviour — tapping Reply on the comment that's
    // already being replied to closes the inline input. Otherwise we
    // open a fresh reply session against that comment.
    if (replyingToCommentId === commentId) {
      setReplyingToCommentId(null)
      return
    }
    setReplyingToCommentId(commentId)
    setSelectedVideoId(videoId)
  }

  // 1.3.2+: lightweight inline-reply submission. The MessageBubble
  // renders its own little textarea + Submit/Cancel pair when the
  // user opens a reply on it; this function does the API call without
  // touching the global `newComment` / `selectedTimestamp` state so the
  // user can keep typing a top-level comment in the main input
  // simultaneously.
  const submitInlineReply = async (
    parentId: string,
    videoId: string,
    content: string,
  ) => {
    const text = content.trim()
    if (!text) return

    if (useAdminAuth && !adminUser) {
      alert('Admin session not loaded yet. Please wait a moment and try again.')
      return
    }
    if (!useAdminAuth && isPasswordProtected && namedRecipients.length > 0 && nameSource === 'none') {
      alert('Please select your name from the dropdown or choose "Custom Name" before replying.')
      return
    }

    const isInternalComment = useAdminAuth || !!adminUser
    const targetVideo = videos.find((v) => v.id === videoId)
    const fps = targetVideo?.fps || 24
    // Replies inherit the parent comment's timecode (or default to
    // 00:00:00:00 — the server will normalise either way).
    const parent = mergedComments.find((c) => c.id === parentId)
    const timecode = parent?.timecode || '00:00:00:00'

    const requestBody: any = {
      projectId,
      videoId,
      content: text,
      timecode,
      parentId,
    }
    if (targetVideo?.version) {
      requestBody.videoVersion = targetVideo.version
    }
    if (isInternalComment) {
      requestBody.isInternal = true
      // 1.3.2+: mirror handleSubmitComment so admin replies carry the
      // signed-in admin's display name instead of falling back to the
      // raw User.name field (which may literally be "Admin" in the
      // database). Without this the top-level comment renders as
      // "Dragos" but the reply right under it renders as "Admin",
      // which the user reads as a different person.
      requestBody.authorName = adminUser?.name || 'Admin'
    } else {
      requestBody.authorName =
        authorName?.trim() || (isPasswordProtected ? authorName : 'Client')
    }

    try {
      let updatedComments: any = null
      if (useAdminAuth) {
        updatedComments = await apiPost('/api/comments', requestBody)
      } else if (shareToken) {
        const response = await fetch(`/api/share/${shareToken}/comments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Framecomment-Client-Id': getClientId(),
          },
          body: JSON.stringify(requestBody),
        })
        if (!response.ok) {
          const err = await response.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to submit reply')
        }
        updatedComments = await response.json()
      } else {
        throw new Error('Authentication required to submit reply')
      }

      // Tell CommentSection to splice the fresh comment list in.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('commentPosted', {
            detail: { comments: updatedComments },
          }),
        )
      }
      router.refresh()
      setReplyingToCommentId(null)
    } catch (err) {
      logError('[useCommentManagement] inline reply failed:', err)
      const message = err instanceof Error ? err.message : 'Could not post reply. Please try again.'
      alert(message)
    }
  }

  const handleCancelReply = () => {
    setReplyingToCommentId(null)
  }

  const handleClearTimestamp = () => {
    setSelectedTimestamp(null)
    setSelectedVideoId(null)
    setHasAutoFilledTimestamp(false)
    setSelectedTimecodeEnd(null) // Clear end when clearing start
  }

  const handleNameSourceChange = (source: 'recipient' | 'custom' | 'none', recipientId?: string) => {
    setNameSource(source)
    let newAuthorName = ''
    let newRecipientId = ''

    if (source === 'custom') {
      newAuthorName = ''
    } else if (source === 'none') {
      newAuthorName = ''
      newRecipientId = ''
    } else if (recipientId) {
      newRecipientId = recipientId
      const selected = namedRecipients.find(r => r.id === recipientId)
      newAuthorName = selected?.name || ''
    }

    setAuthorName(newAuthorName)
    setSelectedRecipientId(newRecipientId)

    // Persist to localStorage (persists across sessions)
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        nameSource: source,
        authorName: newAuthorName,
        selectedRecipientId: newRecipientId,
      }))
    } catch {
      // Ignore storage errors
    }
  }

  const handleDeleteComment = async (commentId: string) => {
    // Authorisation is enforced server-side in DELETE /api/comments/[id]:
    //   - Admins can delete any comment.
    //   - The original author can delete their own comment when their share-
    //     token session id matches the comment's editorSessionId.
    // The caller (CommentSection) is responsible for showing a confirm()
    // dialog; we don't double-prompt here.
    try {
      if (shareToken) {
        const response = await fetch(`/api/comments/${commentId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${shareToken}`,
            'X-Framecomment-Client-Id': getClientId(),
          },
        })
        if (!response.ok) {
          const err = await response.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to delete comment')
        }
      } else if (useAdminAuth) {
        await apiDelete(`/api/comments/${commentId}`)
      } else {
        throw new Error('Authentication required to delete comment')
      }

      // Trigger immediate re-fetch via window event (CommentSection polling will pick it up)
      window.dispatchEvent(new CustomEvent('commentDeleted'))
    } catch (error) {
      alert(`Failed to delete comment: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Wrapper for setAuthorName that also persists to localStorage
  const handleAuthorNameChange = (name: string) => {
    setAuthorName(name)

    // Persist to localStorage when custom name is being typed
    if (nameSource === 'custom') {
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          nameSource,
          authorName: name,
          selectedRecipientId,
        }))
      } catch {
        // Ignore storage errors
      }
    }
  }

  const handleAttachmentAdded = (attachment: PendingAttachment) => {
    setAttachmentError(null)
    setAttachmentNotice(null)
    setPendingAttachments(prev => [...prev, attachment])
  }

  const handleRemoveAttachment = async (assetId: string) => {
    const attachment = pendingAttachments.find(a => a.assetId === assetId)
    setPendingAttachments(prev => prev.filter(a => a.assetId !== assetId))
    setAttachmentError(null)
    setAttachmentNotice(null)
    if (attachment) {
      await cleanupAttachmentAsset(attachment)
    }
  }

  const handleAttachmentErrorChange = (message: string | null) => {
    setAttachmentError(message)
    if (message) {
      setAttachmentNotice(null)
    }
  }

  const handleStartDrawing = () => {
    // Dispatch event to VideoPlayer to enter drawing mode
    window.dispatchEvent(
      new CustomEvent('enterDrawingMode', {
        detail: { timecodeEnd: selectedTimecodeEnd },
      })
    )
  }

  const handleClearAnnotation = () => {
    pendingAnnotationRef.current = null
    setPendingAnnotation(null)
    // Tell VideoPlayer to clear its pending annotation preview
    window.dispatchEvent(new CustomEvent('annotationCleared'))
  }

  // Set end timecode from current video playback position
  const handleSetTimecodeEnd = () => {
    window.dispatchEvent(
      new CustomEvent('getCurrentTime', {
        detail: {
          callback: (time: number, videoId: string) => {
            if (videoId) {
              setSelectedVideoId(videoId)
            }
            const video = videos.find(v => v.id === (videoId || selectedVideoId))
            const fps = video?.fps || 24
            const timecode = secondsToTimecode(time, fps)
            setSelectedTimecodeEnd(timecode)
          },
        },
      })
    )
  }

  const handleClearTimecodeEnd = () => {
    setSelectedTimecodeEnd(null)
  }

  // Get FPS of currently selected video
  const selectedVideo = videos.find(v => v.id === selectedVideoId)
  const selectedVideoFps = selectedVideo?.fps || 24

  return {
    comments,
    newComment,
    selectedTimestamp,
    selectedTimecodeEnd,
    selectedVideoId,
    selectedVideoFps,
    loading,
    replyingToCommentId,
    authorName,
    nameSource,
    selectedRecipientId,
    namedRecipients,
    isOtpAuthenticated: !!authenticatedEmail,
    pendingAttachments,
    attachmentError,
    attachmentNotice,
    pendingAnnotation: !!pendingAnnotation,
    handleCommentChange,
    handleCommentInputFocus,
    handleSubmitComment,
    handleReply,
    submitInlineReply,
    handleCancelReply,
    handleClearTimestamp,
    handleDeleteComment,
    setAuthorName: handleAuthorNameChange,
    handleNameSourceChange,
    handleAttachmentAdded,
    handleRemoveAttachment,
    handleAttachmentErrorChange,
    handleStartDrawing,
    handleClearAnnotation,
    handleSetTimecodeEnd,
    handleClearTimecodeEnd,
  }
}
