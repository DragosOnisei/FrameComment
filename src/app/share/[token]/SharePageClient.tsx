'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, usePathname, useRouter } from 'next/navigation'
import VideoPlayer from '@/components/VideoPlayer'
import CommentSection from '@/components/CommentSection'
import { AnnotationProvider } from '@/contexts/AnnotationContext'
import ThumbnailGrid from '@/components/ThumbnailGrid'
import ThumbnailReel from '@/components/ThumbnailReel'
import ResizableSidebar from '@/components/ResizableSidebar'
import { OTPInput } from '@/components/OTPInput'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Button } from '@/components/ui/button'
import { Lock, Check, Mail, KeyRound, Download, Loader2 } from 'lucide-react'
import BrandLogo from '@/components/BrandLogo'
import { loadShareToken, saveShareToken } from '@/lib/share-token-store'
import ThemeToggle from '@/components/ThemeToggle'
import LanguageToggle from '@/components/LanguageToggle'
import PrivacyBanner, { PRIVACY_STORAGE_KEY } from '@/components/PrivacyBanner'
import ReverseShareUploadPanel from '@/components/ReverseShareUploadPanel'

interface SharePageClientProps {
  token: string
}

const MAX_TOKEN_FETCH_ATTEMPTS = 2
const TOKEN_FETCH_RETRY_BASE_MS = 120
const TOKEN_FETCH_RETRY_MAX_MS = 400

type TokenFetchTelemetryEvent = 'first-attempt-failure' | 'retry-success' | 'retry-failure'

export default function SharePageClient(props: SharePageClientProps) {
  return (
    <AnnotationProvider>
      <SharePageClientInner {...props} />
    </AnnotationProvider>
  )
}

function SharePageClientInner({ token }: SharePageClientProps) {
  const t = useTranslations('share')
  const tc = useTranslations('common')
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()

  // Parse URL parameters for video seeking
  const urlTimestamp = searchParams?.get('t') ? parseFloat(searchParams.get('t')!) : null
  const urlVideoName = searchParams?.get('video') || null
  const urlVersion = searchParams?.get('version') ? parseInt(searchParams.get('version')!, 10) : null
  const urlFocusCommentId = searchParams?.get('comment') || null
  // Folder share context (1.0.6+). When the client opens a video from
  // /share/folder/[slug], that page tacks `&folderId=<cuid>&folderSlug=<slug>`
  // onto the URL. We use folderId to scope the title-flyout / version
  // dropdown to just that folder, and folderSlug to power the
  // "Back to folder" button (which replaces the default "All Videos").
  const urlFolderId = searchParams?.get('folderId') || null
  const urlFolderSlug = searchParams?.get('folderSlug') || null

  const [focusCommentId, setFocusCommentId] = useState<string | null>(urlFocusCommentId)
  const [isPasswordProtected, setIsPasswordProtected] = useState<boolean | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isGuest, setIsGuest] = useState(false)
  const [authMode, setAuthMode] = useState<string>('PASSWORD')
  const [guestMode, setGuestMode] = useState(false)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [authenticatedEmail, setAuthenticatedEmail] = useState<string | null>(null) // Track OTP-authenticated email
  const [authenticatedName, setAuthenticatedName] = useState<string | null>(null) // Track OTP-authenticated name
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [error, setError] = useState('')
  const [project, setProject] = useState<any>(null)
  // 1.4.x+: when the API returns 410 Gone (share link past its
  // expiration date) we land here. Renders a dedicated "link expired"
  // notice instead of the password prompt / loading spinner.
  const [linkExpired, setLinkExpired] = useState<{ at: string | null } | null>(
    null,
  )

  // Scoped videosByName (1.0.6+) — when a folderId param is present
  // the share player only shows the siblings inside THAT folder in
  // its title flyout + version dropdown + grid view, so a client
  // opening a folder share link doesn't accidentally walk into a
  // different folder's content from this player. Falls back to the
  // full project map when no folder context is supplied.
  const effectiveVideosByName = useMemo<Record<string, any[]> | null>(() => {
    if (!project?.videosByName) return null
    if (!urlFolderId) return project.videosByName
    const filtered: Record<string, any[]> = {}
    for (const [name, vids] of Object.entries(
      project.videosByName as Record<string, any[]>,
    )) {
      const inFolder = vids.filter(
        (v) => (v.folderId ?? null) === urlFolderId,
      )
      if (inFolder.length > 0) filtered[name] = inFolder
    }
    return filtered
  }, [project?.videosByName, urlFolderId])
  const [comments, setComments] = useState<any[]>([])
  const [_commentsLoading, setCommentsLoading] = useState(false)
  const [_companyName, setCompanyName] = useState('Studio')
  const [defaultQuality, setDefaultQuality] = useState<'720p' | '1080p' | '2160p'>('720p')
  const [activeVideoName, setActiveVideoName] = useState<string>('')
  // Currently-playing video id, surfaced from VideoPlayer via
  // onVideoStateChange. Used by ThumbnailReel to highlight the active row
  // in the version dropdown.
  const [activeVideoId, setActiveVideoId] = useState<string | undefined>(undefined)
  const [activeVideos, setActiveVideos] = useState<any[]>([])
  const [activeVideosRaw, setActiveVideosRaw] = useState<any[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  // 2.2.0+: Mirror of the admin share page's "last good tokenized
  // list" guard — used by the tokenize effect to refuse publishing a
  // degraded array (empty, or every entry missing a playable surface)
  // over a previously-good `activeVideos`. See the matching comment
  // in `src/app/admin/projects/[id]/share/page.tsx`.
  const lastGoodActiveVideosRef = useRef<any[]>([])
  const [initialSeekTime, setInitialSeekTime] = useState<number | null>(null)
  const [initialVideoIndex, setInitialVideoIndex] = useState<number>(0)
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [hideComments, setHideComments] = useState(false)
  const [viewState, setViewState] = useState<'grid' | 'player'>('grid')
  const [thumbnailsByName, setThumbnailsByName] = useState<Map<string, string>>(new Map())
  const [thumbnailsLoading, setThumbnailsLoading] = useState(true)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const storageKey = token || ''
  const tokenCacheRef = useRef<Map<string, any>>(new Map())
  const inFlightTokenRequestsRef = useRef<Map<string, Promise<string>>>(new Map())
  // 2.2.3+: thumbnail URL cache (videoId → /api/content/<token>).
  // Mirrors the admin share page fix — see the long comment above the
  // thumbnails effect there. The public share page doesn't have a 3.5s
  // poll, but `fetchProjectData` (called on approve / OTP / password
  // success) wipes `tokenCacheRef` and triggers a fresh `setProject`,
  // which re-fires the thumbnails effect with a new `videosByName`
  // reference. Without per-videoId thumbnail caching every approval
  // burst-fires N thumbnail token requests at the same endpoint —
  // small N today, but the public path has no rate-limit headroom and
  // a project with many approved versions would hit the same wall.
  const thumbnailUrlCacheRef = useRef<Map<string, string>>(new Map())
  // 2.2.3+: stable fingerprint of the last thumbnails sweep so the
  // effect can no-op on identical-content re-runs.
  const lastThumbnailFingerprintRef = useRef<string>('')
  const tokenFetchTelemetryRef = useRef({
    firstAttemptFailures: 0,
    retrySuccesses: 0,
    retryFailures: 0,
  })

  const emitTokenFetchTelemetry = useCallback((
    event: TokenFetchTelemetryEvent,
    meta: { videoId: string; quality: string; attempts: number }
  ) => {
    const counters = tokenFetchTelemetryRef.current
    if (event === 'first-attempt-failure') counters.firstAttemptFailures += 1
    if (event === 'retry-success') counters.retrySuccesses += 1
    if (event === 'retry-failure') counters.retryFailures += 1

    const detail = {
      event,
      ...meta,
      counters: { ...counters },
      timestamp: Date.now(),
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('shareTokenFetchTelemetry', { detail }))
    }

    if (process.env.NODE_ENV !== 'production') {
      console.debug('share-token-fetch', detail)
    }
  }, [])

  const waitForTokenRetry = useCallback(async (attempt: number) => {
    const exponentialDelay = Math.min(
      TOKEN_FETCH_RETRY_MAX_MS,
      TOKEN_FETCH_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1))
    )
    const jitterMs = Math.floor(Math.random() * 40)
    await new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitterMs))
  }, [])

  /** Read GDPR analytics consent from localStorage for inclusion in auth request headers */
  const getConsentHeader = (): Record<string, string> => {
    try {
      const stored = localStorage.getItem(PRIVACY_STORAGE_KEY)
      if (stored === 'true') return { 'X-Analytics-Consent': 'true' }
      if (stored === 'declined') return { 'X-Analytics-Consent': 'false' }
    } catch { /* ignore */ }
    return {}
  }

  // Load stored token once (persist across refresh)
  useEffect(() => {
    if (!storageKey) return
    const stored = loadShareToken(storageKey)
    if (stored) {
      setShareToken(stored)
    }
  }, [storageKey])

  // Restore authenticatedEmail from server-provided authenticatedRecipientId (for OTP users)
  // Server extracts recipientId from token - client never decodes token
  useEffect(() => {
    if (!project?.authenticatedRecipientId || !project?.recipients?.length) return
    // Match server-provided recipientId with recipients to get email/name
    const recipient = project.recipients.find((r: any) => r.id === project.authenticatedRecipientId)
    if (recipient?.email) {
      if (!authenticatedEmail) setAuthenticatedEmail(recipient.email)
      if (!authenticatedName && recipient.name) setAuthenticatedName(recipient.name)
    }
  }, [project?.authenticatedRecipientId, project?.recipients, authenticatedEmail, authenticatedName])

  // Resolve authenticated name from recipients when we have email but no name
  useEffect(() => {
    if (!authenticatedEmail || authenticatedName || !project?.recipients?.length) return
    const recipient = project.recipients.find(
      (r: any) => r.email?.toLowerCase() === authenticatedEmail.toLowerCase()
    )
    if (recipient?.name) setAuthenticatedName(recipient.name)
  }, [authenticatedEmail, authenticatedName, project?.recipients])

  // Fetch comments separately for security
  const fetchComments = useCallback(async () => {
    if (!token || !shareToken) return

    setCommentsLoading(true)
    try {
      // 1.2.0+: forward the single-video signature so the comments
      // endpoint can scope its result to the same one video the
      // share GET is already serving. Without this the reviewer
      // would see a filtered video list but the FULL comments
      // listing — including comments on videos they can't open.
      const currentParams = new URLSearchParams(window.location.search)
      const passThrough = new URLSearchParams()
      const sigVideo = currentParams.get('v') || currentParams.get('video')
      const sig = currentParams.get('sig')
      if (sigVideo) passThrough.set('v', sigVideo)
      if (sig) passThrough.set('sig', sig)
      const qs = passThrough.toString()
      const url = `/api/share/${token}/comments${qs ? `?${qs}` : ''}`
      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${shareToken}`
        }
      })
      if (response.ok) {
        const commentsData = await response.json()
        setComments(commentsData)
      }
    } catch (error) {
      // Failed to load comments
    } finally {
      setCommentsLoading(false)
    }
  }, [token, shareToken])

  // Listen for comment updates (post, delete, etc.)
  useEffect(() => {
    const handleCommentPosted = (e: CustomEvent) => {
      // Use the comments data from the event if available, otherwise refetch
      if (e.detail?.comments) {
        setComments(e.detail.comments)
      } else {
        fetchComments()
      }
    }

    const handleCommentDeleted = () => {
      fetchComments()
    }

    window.addEventListener('commentPosted', handleCommentPosted as EventListener)
    window.addEventListener('commentDeleted', handleCommentDeleted)

    return () => {
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
      window.removeEventListener('commentDeleted', handleCommentDeleted)
    }
  }, [fetchComments])

  // Fetch project data function (for refresh after approval)
  const fetchProjectData = async (tokenOverride?: string | null) => {
    try {
      const authToken = tokenOverride || shareToken
      // 1.2.0+: forward the single-video signed params so the share
      // GET endpoint can scope its response. Without this the URL
      // params would only affect the initial server render — every
      // client-side refresh would re-fetch the unscoped full project.
      const currentParams =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search)
          : new URLSearchParams()
      const passThrough = new URLSearchParams()
      const sigVideo = currentParams.get('v') || currentParams.get('video')
      const sig = currentParams.get('sig')
      if (sigVideo) passThrough.set('v', sigVideo)
      if (sig) passThrough.set('sig', sig)
      const qs = passThrough.toString()
      const projectResponse = await fetch(
        `/api/share/${token}${qs ? `?${qs}` : ''}`,
        {
          cache: 'no-store',
          headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}), ...getConsentHeader() }
        }
      )

      // Recover automatically from stale/expired stored share token.
      if (projectResponse.status === 401 && authToken) {
        saveShareToken(storageKey, null)
        setShareToken(null)
        return
      }

      if (projectResponse.ok) {
        const projectData = await projectResponse.json()

        if (projectData.shareToken) {
          setShareToken(projectData.shareToken)
          saveShareToken(storageKey, projectData.shareToken)
        } else if (tokenOverride) {
          setShareToken(tokenOverride)
          saveShareToken(storageKey, tokenOverride)
        }
        setProject(projectData)

        // Clear token cache to force re-fetch of video tokens with updated approval status
        tokenCacheRef.current.clear()

        // Fetch comments after project loads (if not hidden)
        if (!projectData.hideFeedback) {
          fetchComments()
        }
      }
    } catch (error) {
      // Failed to load project data
    }
  }

  // Company name and default quality now loaded from project settings
  // This ensures they're only accessible after authentication

  // Load project data (handles auth check implicitly via API response)
  useEffect(() => {
    let isMounted = true

    async function loadProject() {
      try {
        // 1.2.0+: forward the single-video signed params on the initial
        // load too. This is the path the very first paint goes through,
        // so without it the user briefly sees the full project before
        // any client-side fetch kicks in to re-scope.
        const initialParams =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams()
        const initialPass = new URLSearchParams()
        const sigVideo = initialParams.get('v') || initialParams.get('video')
        const sig = initialParams.get('sig')
        if (sigVideo) initialPass.set('v', sigVideo)
        if (sig) initialPass.set('sig', sig)
        const initialQs = initialPass.toString()
        const response = await fetch(
          `/api/share/${token}${initialQs ? `?${initialQs}` : ''}`,
          {
            cache: 'no-store',
            headers: { ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}), ...getConsentHeader() }
          }
        )

        if (!isMounted) return

        if (response.status === 401) {
          saveShareToken(storageKey, null)

          // If a stale share token was sent, clear in-memory state and retry once.
          // This removes the need for a manual F5 when a cached token expires.
          if (shareToken) {
            setShareToken(null)
            return
          }

          const data = await response.json()
          if (data.authMode === 'NONE' && data.guestMode) {
            try {
              const guestResponse = await fetch(`/api/share/${token}/guest`, {
                method: 'POST',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json', ...getConsentHeader() },
              })
              if (guestResponse.ok) {
                const guestData = await guestResponse.json()
                if (guestData.shareToken) {
                  setShareToken(guestData.shareToken)
                  saveShareToken(storageKey, guestData.shareToken)
                  setIsGuest(true)
                  setIsAuthenticated(true)
                  await loadProject()
                  return
                }
              }
            } catch {
              // fall through
            }
          }

          setIsPasswordProtected(true)
          setIsAuthenticated(false)
          setAuthMode(data.authMode || 'PASSWORD')
          setGuestMode(data.guestMode || false)
          return
        }

        if (response.status === 403 || response.status === 404) {
          // Server already validated slug exists, this shouldn't happen
          // but handle gracefully by showing project not found
          return
        }

        if (response.status === 410) {
          // 1.4.x+: share link has expired. Surface a friendly notice
          // with the expiration timestamp the API sends back.
          const body = await response.json().catch(() => ({}))
          if (isMounted) {
            setLinkExpired({ at: body?.expiredAt || null })
          }
          return
        }

        if (response.ok) {
          const projectData = await response.json()
          if (projectData.shareToken) {
            setShareToken(projectData.shareToken)
            saveShareToken(storageKey, projectData.shareToken)
          }
          if (isMounted) {
            setProject(projectData)
            setIsPasswordProtected(!!projectData.recipients && projectData.recipients.length > 0)
            setIsAuthenticated(true)
            setIsGuest(projectData.isGuest || false)

            if (projectData.settings) {
              setCompanyName(projectData.settings.companyName || 'Studio')
              // Prefer per-project resolution, fall back to global default
              setDefaultQuality(projectData.previewResolution || projectData.settings.defaultPreviewResolution || 'auto')
            }

            if (!projectData.hideFeedback) {
              fetchComments()
            }
          }
        }
      } catch (error) {
        // Silent fail
      }
    }

    loadProject()

    return () => {
      isMounted = false
    }
  }, [token, shareToken, storageKey, fetchComments])

  // 2.2.0+: Stable fingerprint of the raw videos list. Used to skip
  // no-op `setActiveVideosRaw` calls when the source data hasn't
  // meaningfully changed between project refreshes — same guard as
  // the admin share page, see comments there for the full rationale.
  const fingerprintRawVideos = useCallback((videos: any[] | null | undefined): string => {
    if (!videos || videos.length === 0) return ''
    return videos
      .map((v: any) => [
        v?.id ?? '',
        v?.status ?? '',
        v?.processingProgress ?? '',
        v?.preview480Path ? 1 : 0,
        v?.preview720Path ? 1 : 0,
        v?.preview1080Path ? 1 : 0,
        v?.preview2160Path ? 1 : 0,
        Array.isArray(v?.hlsQualities) ? v.hlsQualities.length : 0,
        v?.approved ? 1 : 0,
      ].join('|'))
      .join('::')
  }, [])

  // Set active video when project loads, handling URL parameters
  useEffect(() => {
    if (project?.videosByName) {
      const videoNames = Object.keys(project.videosByName)
      if (videoNames.length === 0) return

      // Determine which video group should be active
      if (!activeVideoName) {
        let videoNameToUse: string | null = null

        // Priority 1: URL parameter for video name
        if (urlVideoName && project.videosByName[urlVideoName]) {
          videoNameToUse = urlVideoName
        }
        // Priority 2: Saved video name from recent approval
        else {
          const savedVideoName = sessionStorage.getItem('approvedVideoName')
          if (savedVideoName) {
            sessionStorage.removeItem('approvedVideoName')
            if (project.videosByName[savedVideoName]) {
              videoNameToUse = savedVideoName
            }
          }
        }

        // Priority 3: First video
        if (!videoNameToUse) {
          videoNameToUse = videoNames[0]
        }

        setActiveVideoName(videoNameToUse)

        const videos = project.videosByName[videoNameToUse]
        // 2.2.0+: refuse to seed `activeVideosRaw` with an empty
        // array. Mirrors the admin share page guard.
        if (Array.isArray(videos) && videos.length > 0) {
          setActiveVideosRaw(videos)
        }

        // If URL specifies a version, calculate the index for initial selection
        if (urlVersion !== null && videos) {
          const targetIndex = videos.findIndex((v: any) => v.version === urlVersion)
          if (targetIndex !== -1) {
            setInitialVideoIndex(targetIndex)
          }
        }

        // Set initial seek time if URL parameter exists
        if (urlTimestamp !== null) {
          setInitialSeekTime(urlTimestamp)
        }
      } else {
        // Keep activeVideos in sync when project data refreshes (ensures updated approval status/thumbnails/tokens)
        const videos = project.videosByName[activeVideoName]
        // 2.2.0+: same fingerprint-based no-op suppression as the
        // admin share page — avoids re-tokenizing every refresh
        // when nothing the tokenizer cares about actually changed,
        // and never overwrites a populated list with an empty one.
        if (Array.isArray(videos) && videos.length > 0) {
          setActiveVideosRaw((prev) => {
            if (fingerprintRawVideos(prev) === fingerprintRawVideos(videos)) {
              return prev
            }
            return videos
          })
        }
      }
    }
  }, [project?.videosByName, activeVideoName, urlVideoName, urlVersion, urlTimestamp, fingerprintRawVideos])

  const fetchVideoToken = useCallback(async (videoId: string, quality: string) => {
    if (!shareToken) return ''
    const response = await fetch(`/api/share/${token}/video-token?videoId=${videoId}&quality=${quality}`, {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${shareToken}`,
      }
    })
    if (!response.ok) return ''
    const data = await response.json()
    return data.token || ''
  }, [shareToken, token])

  const fetchVideoTokenWithRetry = useCallback(async (videoId: string, quality: string) => {
    if (!shareToken) return ''

    const requestKey = `${shareToken}:${videoId}:${quality}`
    const inFlight = inFlightTokenRequestsRef.current.get(requestKey)
    if (inFlight) {
      return inFlight
    }

    const requestPromise = (async () => {
      for (let attempt = 1; attempt <= MAX_TOKEN_FETCH_ATTEMPTS; attempt += 1) {
        const tokenValue = await fetchVideoToken(videoId, quality)
        if (tokenValue) {
          if (attempt > 1) {
            emitTokenFetchTelemetry('retry-success', { videoId, quality, attempts: attempt })
          }
          return tokenValue
        }

        if (attempt === 1) {
          emitTokenFetchTelemetry('first-attempt-failure', { videoId, quality, attempts: attempt })
          await waitForTokenRetry(attempt)
        }
      }

      emitTokenFetchTelemetry('retry-failure', {
        videoId,
        quality,
        attempts: MAX_TOKEN_FETCH_ATTEMPTS,
      })
      return ''
    })().finally(() => {
      inFlightTokenRequestsRef.current.delete(requestKey)
    })

    inFlightTokenRequestsRef.current.set(requestKey, requestPromise)
    return requestPromise
  }, [shareToken, fetchVideoToken, emitTokenFetchTelemetry, waitForTokenRetry])

  const fetchTokensForVideos = useCallback(async (videos: any[]) => {
    if (!shareToken) return videos

    return Promise.all(
      videos.map(async (video: any) => {
        // 1.9.4+ Phase A: cache key fingerprints status AND
        // which tier paths have landed, so the cache rotates
        // whenever a new tier comes online. The cached entry's
        // stream URLs are kept (expensive to regenerate), but
        // progress + tier-path flags are overlaid from the fresh
        // poll data so the Quality menu's "720p · 50%" badge
        // actually advances between polls.
        const tierFingerprint = `${!!video.preview480Path ? 1 : 0}${!!video.preview720Path ? 1 : 0}${!!video.preview1080Path ? 1 : 0}${!!video.preview2160Path ? 1 : 0}`
        const cacheKey = `${shareToken}:${video.id}:${video.status || 'PROCESSING'}:${tierFingerprint}`
        const cached = tokenCacheRef.current.get(cacheKey)
        if (cached) {
          return {
            ...cached,
            status: video.status,
            processingProgress: video.processingProgress,
            preview480Path: video.preview480Path,
            preview720Path: video.preview720Path,
            preview1080Path: video.preview1080Path,
            preview2160Path: video.preview2160Path,
          }
        }

        try {
          // 1.9.4+ Phase A: 480p is the fastest progressive tier.
          // We fetch a token for it alongside the higher tiers so
          // the player can serve it the moment it lands, even
          // before 720p+ finish.
          let streamToken480p = ''
          let streamToken720p = ''
          let streamToken1080p = ''
          let streamToken2160p = ''
          let downloadToken = null

          if (video.approved) {
            // Check if project uses preview for approved playback
            if (project?.usePreviewForApprovedPlayback) {
              // Use preview tokens for streaming, original for download
              const [token480, token720, token1080, token2160, originalToken] = await Promise.all([
                fetchVideoTokenWithRetry(video.id, '480p'),
                fetchVideoTokenWithRetry(video.id, '720p'),
                fetchVideoTokenWithRetry(video.id, '1080p'),
                fetchVideoTokenWithRetry(video.id, '2160p'),
                fetchVideoTokenWithRetry(video.id, 'original'),
              ])
              streamToken480p = token480
              streamToken720p = token720
              streamToken1080p = token1080
              streamToken2160p = token2160
              downloadToken = originalToken
            } else {
              // Default: original for everything
              const originalToken = await fetchVideoTokenWithRetry(video.id, 'original')
              streamToken480p = originalToken
              streamToken720p = originalToken
              streamToken1080p = originalToken
              streamToken2160p = originalToken
              downloadToken = originalToken
            }
          } else {
            const [token480, token720, token1080, token2160] = await Promise.all([
              fetchVideoTokenWithRetry(video.id, '480p'),
              fetchVideoTokenWithRetry(video.id, '720p'),
              fetchVideoTokenWithRetry(video.id, '1080p'),
              fetchVideoTokenWithRetry(video.id, '2160p'),
            ])
            streamToken480p = token480
            streamToken720p = token720
            streamToken1080p = token1080
            streamToken2160p = token2160
          }

          let thumbnailUrl = null
          if (video.thumbnailPath) {
            const thumbToken = await fetchVideoTokenWithRetry(video.id, 'thumbnail')
            if (thumbToken) {
              thumbnailUrl = `/api/content/${thumbToken}`
            }
          }

          const tokenized = {
            ...video,
            streamUrl480p: streamToken480p ? `/api/content/${streamToken480p}` : '',
            streamUrl720p: streamToken720p ? `/api/content/${streamToken720p}` : '',
            streamUrl1080p: streamToken1080p ? `/api/content/${streamToken1080p}` : '',
            streamUrl2160p: streamToken2160p ? `/api/content/${streamToken2160p}` : '',
            downloadUrl: downloadToken ? `/api/content/${downloadToken}?download=true` : null,
            thumbnailUrl,
          }

          // Only cache successful tokenization results.
          // Avoid caching empty URLs from transient failures on first load.
          if (tokenized.streamUrl480p || tokenized.streamUrl720p || tokenized.streamUrl1080p || tokenized.streamUrl2160p || tokenized.downloadUrl || tokenized.thumbnailUrl) {
            tokenCacheRef.current.set(cacheKey, tokenized)
          }
          return tokenized
        } catch (error) {
          return video
        }
      })
    )
  }, [shareToken, fetchVideoTokenWithRetry, project?.usePreviewForApprovedPlayback])

  // 2.2.0+: Match the admin share page's "usable tokenized clip"
  // predicate so the same defensive guard works here. A clip needs at
  // least one playable surface (any tier stream URL, an HLS master, a
  // download URL, or a thumbnail) before we'll publish it into
  // `activeVideos`; otherwise the player would mount with
  // `videoUrl === ''` and immediately show its internal "Loading
  // video…" placeholder.
  const isTokenizedVideoUsable = useCallback((v: any): boolean => {
    if (!v) return false
    return Boolean(
      v.streamUrl480p ||
      v.streamUrl720p ||
      v.streamUrl1080p ||
      v.streamUrl2160p ||
      v.hlsUrl ||
      v.downloadUrl ||
      v.thumbnailUrl,
    )
  }, [])

  useEffect(() => {
    let isMounted = true

    async function loadTokens() {
      if (!activeVideosRaw || activeVideosRaw.length === 0) {
        setTokensLoading(false)
        return
      }
      if (!shareToken) {
        setTokensLoading(true)
        return
      }
      setTokensLoading(true)
      const tokenized = await fetchTokensForVideos(activeVideosRaw)
      if (!isMounted) return
      // 2.2.0+: same defence as the admin share page — never replace
      // a previously-good `activeVideos` with a degraded result
      // (empty array, or every clip missing a playable surface).
      // Without this the public share page would briefly flash
      // "No videos are ready for review yet." on any transient
      // token-fetch hiccup.
      const tokenizedAny = Array.isArray(tokenized) ? tokenized : []
      const anyUsable = tokenizedAny.some(isTokenizedVideoUsable)
      const lastGood = lastGoodActiveVideosRef.current
      const haveLastGood = Array.isArray(lastGood) && lastGood.length > 0
      if (tokenizedAny.length === 0 && haveLastGood) {
        // Keep the previously-published list.
      } else if (!anyUsable && haveLastGood) {
        // Same — refuse to clobber a working list with bare clips.
      } else {
        setActiveVideos(tokenizedAny)
        if (anyUsable) {
          lastGoodActiveVideosRef.current = tokenizedAny
        }
      }
      setTokensLoading(false)
    }

    loadTokens()

    return () => {
      isMounted = false
    }
  }, [activeVideosRaw, shareToken, fetchTokensForVideos, isTokenizedVideoUsable])

  // Fetch thumbnails for all video groups (for grid and reel display).
  //
  // 2.2.3+: same root-cause fix as the admin share page — guard the
  // effect with a (name → videoIdWithThumb) fingerprint and a per-
  // videoId thumbnail URL cache so re-runs triggered by a fresh
  // `project.videosByName` reference (post-approve refetch, OTP /
  // password success seeding `fetchProjectData`, etc.) don't re-mint
  // thumbnail tokens that haven't changed. See the matching comment on
  // the admin share page for the full rationale.
  useEffect(() => {
    let isMounted = true

    async function fetchThumbnails() {
      if (!project?.videosByName || !shareToken) {
        return
      }

      // 2.2.3+: fingerprint + per-videoId cache, as above.
      const entries = Object.entries(
        project.videosByName as Record<string, any[]>,
      )
      const fingerprintParts: string[] = []
      const nameToVideoWithThumb = new Map<string, any>()
      for (const [name, videos] of entries) {
        const videoWithThumb = videos.find((v: any) => v.thumbnailPath)
        const thumbVideoId = videoWithThumb?.id ?? ''
        fingerprintParts.push(`${name}::${thumbVideoId}`)
        if (videoWithThumb) {
          nameToVideoWithThumb.set(name, videoWithThumb)
        }
      }
      const fingerprint = fingerprintParts.join('||')
      if (
        fingerprint === lastThumbnailFingerprintRef.current &&
        lastThumbnailFingerprintRef.current !== ''
      ) {
        return
      }

      setThumbnailsLoading(true)
      const newThumbnails = new Map<string, string>()

      // 3.2.3+ CRITICAL FIX — mirror of the 3.2.2 admin-share fix, now
      // applied to the CLIENT share page. When we're in player view
      // (URL targets a specific video via ?video=<name>) only fetch the
      // thumbnail for the active video group. The grid is hidden, so
      // fetching thumbnails for ALL videos here was firing one
      // `/api/share/<token>/video-token?quality=thumbnail` per clip in a
      // single `Promise.all`. On a 250+ clip share that's 250 parallel
      // fetches the instant the page mounts — Chrome hits its global
      // concurrent-fetch ceiling and starts returning
      // `net::ERR_INSUFFICIENT_RESOURCES`. The ACTIVE video's own token
      // fetch (480p/720p/1080p/2160p/hls/original/thumbnail) then lands
      // on the exhausted pool, all come back errored, every streamUrl is
      // empty, and the player is stuck on "Loading video…" forever. The
      // public share endpoint had the exact same fan-out the admin page
      // did before 3.2.2.
      const inPlayerView = !!urlVideoName
      const targetEntries = inPlayerView
        ? Array.from(nameToVideoWithThumb.entries()).filter(([name]) => name === urlVideoName)
        : Array.from(nameToVideoWithThumb.entries())

      // 3.2.3+: run bulk thumbnails (grid view) through a small
      // concurrency-limited worker pool instead of `Promise.all` so we
      // never burst N requests at once. 4 is conservative — under
      // Chrome's 6-per-origin cap so other UI requests (auth poll,
      // processing-status, the active video's own tokens) still get
      // bandwidth. Cached entries return synchronously without a fetch.
      const CONCURRENCY = 4
      const fetchOne = async ([name, videoWithThumb]: [string, any]) => {
        const cachedUrl = thumbnailUrlCacheRef.current.get(videoWithThumb.id)
        if (cachedUrl) {
          if (isMounted) {
            newThumbnails.set(name, cachedUrl)
          }
          return
        }
        const thumbToken = await fetchVideoTokenWithRetry(videoWithThumb.id, 'thumbnail')
        if (thumbToken && isMounted) {
          const url = `/api/content/${thumbToken}`
          thumbnailUrlCacheRef.current.set(videoWithThumb.id, url)
          newThumbnails.set(name, url)
        }
      }

      try {
        // Worker-pool: CONCURRENCY workers each pull from a shared queue
        // until it's empty.
        const queue = targetEntries.slice()
        const worker = async () => {
          while (queue.length > 0 && isMounted) {
            const next = queue.shift()
            if (!next) break
            await fetchOne(next)
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
        )

        if (isMounted) {
          // 3.2.3+: in player view `newThumbnails` has only ONE entry —
          // merge into existing state instead of replacing so the grid
          // doesn't lose previously-loaded tiles, and DON'T mark the
          // fingerprint as up-to-date (otherwise the grid view's first
          // run would short-circuit and never load the rest).
          if (inPlayerView) {
            setThumbnailsByName((prev) => {
              const merged = new Map(prev)
              newThumbnails.forEach((url, name) => merged.set(name, url))
              return merged
            })
          } else {
            setThumbnailsByName(newThumbnails)
            lastThumbnailFingerprintRef.current = fingerprint
          }
        }
      } catch (error) {
        // Failed to load thumbnails
      } finally {
        if (isMounted) {
          setThumbnailsLoading(false)
        }
      }
    }

    fetchThumbnails()

    return () => {
      isMounted = false
    }
  }, [project?.videosByName, shareToken, fetchVideoTokenWithRetry, urlVideoName])

  // Determine initial view state based on URL params
  useEffect(() => {
    if (!project?.videosByName) return

    // If URL specifies a video, go to player
    if (urlVideoName && project.videosByName[urlVideoName]) {
      setViewState('player')
      return
    }

    // Default: show grid (same behavior for single and multiple videos)
    setViewState('grid')
  }, [project?.videosByName, urlVideoName])

  // Handle video selection - update URL so refresh preserves state
  const handleVideoSelect = useCallback((videoName: string) => {
    setActiveVideoName(videoName)
    setActiveVideosRaw(project.videosByName[videoName])
    setViewState('player')
    // 2.2.0+: invalidate the "last good tokenized" fallback when
    // switching clip groups so the tokenize-effect guard can't
    // briefly replay the previous video's stream URLs onto the
    // newly-selected one. Mirrors the admin share page.
    lastGoodActiveVideosRef.current = []

    // Update URL with video parameter (preserves state on refresh)
    const params = new URLSearchParams(searchParams?.toString() || '')
    params.set('video', videoName)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [project?.videosByName, searchParams, pathname, router])

  // Handle back to grid - remove video param from URL. When the
  // share player was opened with folder context (1.0.6+), "back"
  // uses router.back() so the visitor returns to whatever folder
  // page they came from — admin folder browser for admins, share
  // folder grid for clients — instead of being forced onto the
  // client-side share folder page. If there is no history (e.g.
  // the URL was pasted directly) we fall back to /share/folder/{slug}.
  const handleBackToGrid = useCallback(() => {
    if (urlFolderId || urlFolderSlug) {
      if (typeof window !== 'undefined' && window.history.length > 1) {
        router.back()
        return
      }
      if (urlFolderSlug) {
        router.push(`/share/folder/${urlFolderSlug}`)
        return
      }
    }
    setViewState('grid')

    // Remove video parameter from URL
    const params = new URLSearchParams(searchParams?.toString() || '')
    params.delete('video')
    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname
    router.replace(newUrl || '', { scroll: false })
  }, [searchParams, pathname, router, urlFolderId, urlFolderSlug])

  const handleDownloadAll = useCallback(async () => {
    if (downloadingAll || !shareToken) return

    try {
      setDownloadingAll(true)

      const response = await fetch(`/api/share/${token}/download-all-token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${shareToken}`,
        },
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Download failed')
      }

      const { url } = await response.json()

      const link = document.createElement('a')
      link.href = url
      link.download = ''
      link.rel = 'noopener'
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch {
      // Silently fail - user can retry
    } finally {
      setDownloadingAll(false)
    }
  }, [downloadingAll, shareToken, token])

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!email) return

    setSendingOtp(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (response.ok) {
        setOtpSent(true)
        setError('') // Clear any previous errors
      } else {
        // Show generic message to prevent email enumeration
        setError(data.error || t('failedToSendCode'))
      }
    } catch (error) {
      setError(tc('errorTryAgain'))
    } finally {
      setSendingOtp(false)
    }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !otp) return

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getConsentHeader() },
        body: JSON.stringify({ email, code: otp }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.shareToken) {
          setShareToken(data.shareToken)
          saveShareToken(storageKey, data.shareToken)
        }
        setIsAuthenticated(true)
        setIsGuest(false)
        setAuthenticatedEmail(email) // Save the authenticated email

        await fetchProjectData(data.shareToken)
      } else {
        setError(t('invalidCode'))
      }
    } catch (error) {
      setError(tc('errorTryAgain'))
    } finally {
      setLoading(false)
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getConsentHeader() },
        body: JSON.stringify({ password }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.shareToken) {
          setShareToken(data.shareToken)
          saveShareToken(storageKey, data.shareToken)
        }
        setIsAuthenticated(true)
        setIsGuest(false)

        await fetchProjectData(data.shareToken)
      } else {
        setError(t('incorrectPassword'))
      }
    } catch (error) {
      setError(tc('error'))
    } finally {
      setLoading(false)
    }
  }

  async function handleGuestEntry() {
    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getConsentHeader() },
      })

      if (response.ok) {
        const data = await response.json()
        if (data.shareToken) {
          setShareToken(data.shareToken)
          saveShareToken(storageKey, data.shareToken)
        }
        setIsAuthenticated(true)
        setIsGuest(true)

        await fetchProjectData(data.shareToken)
      } else {
        setError(t('unableToAccessGuest'))
      }
    } catch (error) {
      setError(tc('error'))
    } finally {
      setLoading(false)
    }
  }

  // 1.4.x+: link has expired — render a friendly notice (the API
  // returned 410 Gone). We show the exact moment the link stopped
  // working in the viewer's local TZ so they have something concrete
  // to send back to the studio when asking for a refresh.
  if (linkExpired) {
    const when = linkExpired.at ? new Date(linkExpired.at) : null
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <div className="mx-auto rounded-full bg-amber-500/10 p-3 w-fit">
            <Lock className="w-6 h-6 text-amber-500" />
          </div>
          <h1 className="text-xl font-semibold">This share link has expired</h1>
          <p className="text-sm text-muted-foreground">
            {when ? (
              <>
                The link stopped working on{' '}
                <span className="text-foreground font-medium">
                  {when.toLocaleString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                .
              </>
            ) : (
              'The link is no longer active.'
            )}{' '}
            Ask the project owner for a fresh link.
          </p>
        </div>
      </div>
    )
  }

  // 3.2.3+ Mobile/client UX: glass loading instead of pre-2.5 flat
  // dark "Loading…" while the share page is figuring out whether
  // the project needs password / OTP auth. Same recipe as the
  // `if (!project)` and player-side glass cards so the client never
  // sees the legacy `bg-background` (#121212) flash before the
  // password gate / player renders.
  if (isPasswordProtected === null) {
    return (
      <div className="spotlight-bg-tr h-screen overflow-hidden lg:fixed lg:inset-0 flex flex-col items-center justify-center p-4" style={{ height: '100dvh' }}>
        <div
          className="rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white px-8 py-7 flex items-center gap-4"
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
          <div className="h-5 w-5 rounded-full border-2 border-white/20 border-t-white/85 animate-spin" />
          <p className="text-sm font-medium text-white/85">{tc('loading')}</p>
        </div>
      </div>
    )
  }

  // Show authentication prompt
  if (isPasswordProtected && !isAuthenticated) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center p-4">
        {/* Language and theme toggles for auth view */}
        <div className="fixed top-3 right-3 z-20 flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
        </div>
        <div className="w-full max-w-md flex flex-col items-center gap-4">
          <BrandLogo height={64} className="mx-auto" />
          <Card className="bg-card border-border w-full">
            <CardHeader className="text-center space-y-3">
              <div className="flex justify-center">
                <Lock className="w-12 h-12 text-muted-foreground" />
              </div>
              <CardTitle className="text-foreground">{t('authRequired')}</CardTitle>
              <p className="text-muted-foreground text-sm mt-2">
                {authMode === 'PASSWORD' && t('passwordPrompt')}
                {authMode === 'OTP' && t('otpPrompt')}
                {authMode === 'BOTH' && t('bothPrompt')}
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Password Authentication - hide when OTP code is being entered */}
              {(authMode === 'PASSWORD' || authMode === 'BOTH') && !otpSent && (
                <div className="space-y-4">
                  {authMode === 'BOTH' && (
                    <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">{t('password')}</p>
                  </div>
                )}
                <form onSubmit={handlePasswordSubmit} className="space-y-4">
                  <PasswordInput
                    placeholder={t('enterPassword')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus={authMode === 'PASSWORD'}
                  />
                  <Button
                    type="submit"
                    variant="default"
                    size="default"
                    disabled={loading || !password}
                    className="w-full"
                  >
                    <Check className="w-4 h-4 mr-2" />
                    {loading ? t('verifying') : tc('submit')}
                  </Button>
                </form>
              </div>
            )}

            {/* Divider for BOTH mode - hide when OTP code is being entered */}
            {authMode === 'BOTH' && !otpSent && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border"></div>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">{tc('or')}</span>
                </div>
              </div>
            )}

            {/* OTP Authentication */}
            {(authMode === 'OTP' || authMode === 'BOTH') && (
              <div className="space-y-4">
                {authMode === 'BOTH' && (
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">{t('emailVerification')}</p>
                  </div>
                )}
                {!otpSent ? (
                  <form onSubmit={handleSendOtp} className="space-y-4">
                    <Input
                      type="email"
                      placeholder={t('enterEmail')}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoFocus={authMode === 'OTP'}
                      required
                    />
                    <Button
                      type="submit"
                      variant="default"
                      size="default"
                      disabled={sendingOtp || !email}
                      className="w-full"
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      {sendingOtp ? t('sendingCode') : t('sendCode')}
                    </Button>
                  </form>
                ) : (
                  <form onSubmit={handleOtpSubmit} className="space-y-4">
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground text-center">
                        {t('codePrompt', { email })}
                      </p>
                      <OTPInput
                        value={otp}
                        onChange={setOtp}
                        disabled={loading}
                        autoFocus
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        onClick={() => {
                          setOtpSent(false)
                          setOtp('')
                          setError('')
                        }}
                        className="flex-1"
                      >
                        Back
                      </Button>
                      <Button
                        type="submit"
                        variant="default"
                        size="default"
                        disabled={loading || otp.length !== 6}
                        className="flex-1"
                      >
                        <Check className="w-4 h-4 mr-2" />
                        {loading ? 'Verifying...' : 'Verify'}
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="p-3 bg-destructive-visible border border-destructive-visible rounded-lg">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}

            {/* Guest Entry Button - hide when OTP code is being entered */}
            {guestMode && !otpSent && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border"></div>
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{t('notRecipient')}</span>
                  </div>
                </div>
                <Button
                  type="button"
                  size="default"
                  onClick={handleGuestEntry}
                  disabled={loading}
                  className="w-full bg-warning text-warning-foreground hover:bg-warning/90 shadow-elevation hover:shadow-elevation-lg hover:-translate-y-0.5 active:translate-y-0 active:shadow-elevation transition-all duration-200"
                >
                  {t('continueAsGuest')}
                </Button>
              </>
            )}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // 3.2.0+: Initial loading state. SSR has already validated the
  // project exists (see /share/[token]/page.tsx — invalid slugs are
  // 404'd before this client component ever mounts), so reaching
  // `!project` here ALWAYS means "fetch hasn't resolved yet", not
  // "project genuinely missing". Render a single frosted-glass card
  // that visually matches the "Loading video…" card shown later in
  // the empty-state branch — so the brief gap between (a) `project`
  // becoming non-null and (b) `tokensLoading` flipping false is a
  // seamless single screen instead of two distinct flat cards. Old
  // behaviour was: bare "Loading…" flash → "Loading video…" card
  // flash; new behaviour: one glass card the whole time.
  if (!project) {
    return (
      <div className="spotlight-bg-tr h-screen overflow-hidden lg:fixed lg:inset-0 flex flex-col items-center justify-center p-4" style={{ height: '100dvh' }}>
        <div
          className="rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white px-8 py-7 flex items-center gap-4"
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
          <div className="h-5 w-5 rounded-full border-2 border-white/20 border-t-white/85 animate-spin" />
          <p className="text-sm font-medium text-white/85">{t('loadingVideo')}</p>
        </div>
      </div>
    )
  }

  // Filter to READY videos first
  let readyVideos = activeVideos.filter((v: any) => v.status === 'READY')

  // If any video is approved, show ONLY approved videos (for both admin and client)
  const hasApprovedVideo = readyVideos.some((v: any) => v.approved)
  if (hasApprovedVideo) {
    readyVideos = readyVideos.filter((v: any) => v.approved)
  }

  // Filter comments to only show comments for active videos
  const activeVideoIds = new Set(activeVideos.map((v: any) => v.id))
  const filteredComments = comments.filter((comment: any) => {
    // Show general comments (no videoId) or comments for active videos
    return !comment.videoId || activeVideoIds.has(comment.videoId)
  })

  // 3.2.0+: render-time override that prefers the player view as soon
  // as the share URL points at a specific video (?video=<name>) AND
  // the project actually contains it. Without this override, between
  // (a) `project` resolving via fetch and (b) the URL-sync useEffect
  // at line ~869 calling `setViewState('player')`, React paints one
  // frame with viewState='grid' + project loaded — which renders the
  // full thumbnail grid for the entire project (every video!) before
  // the effect re-renders into the player. Visible to the reviewer
  // as a jarring flash of "all videos" between the share link and
  // the requested clip. The actual state still settles via the
  // effect; this is purely a guard against the in-between frame.
  const targetingSpecificVideo = !!(
    urlVideoName && project.videosByName?.[urlVideoName]
  )
  const effectiveViewState: 'grid' | 'player' = targetingSpecificVideo
    ? 'player'
    : viewState

  // 3.2.0+: if the URL targets a specific video but `activeVideoName`
  // hasn't been set yet (fetchProjectData wires it up via its own
  // effect, which fires the same render tick we're in), keep the
  // initial glass-loading card on screen instead of mounting the
  // player with empty `readyVideos`. The player branch handles
  // `readyVideos.length === 0` with its own loading spinner, but
  // showing the SAME glass card the whole way through (initial !project
  // → URL-targeted player) means the user sees a single continuous
  // loading state instead of two distinct ones.
  if (targetingSpecificVideo && !activeVideoName) {
    return (
      <div className="spotlight-bg-tr h-screen overflow-hidden lg:fixed lg:inset-0 flex flex-col items-center justify-center p-4" style={{ height: '100dvh' }}>
        <div
          className="rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white px-8 py-7 flex items-center gap-4"
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
          <div className="h-5 w-5 rounded-full border-2 border-white/20 border-t-white/85 animate-spin" />
          <p className="text-sm font-medium text-white/85">{t('loadingVideo')}</p>
        </div>
      </div>
    )
  }

  // Show thumbnail grid when in grid view (scrollable)
  if (effectiveViewState === 'grid') {
    return (
      <>
      <div className="fixed inset-0 bg-background flex flex-col overflow-hidden">
        {/* Grid view toolbar */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-background/95 backdrop-blur-sm z-20 flex-shrink-0">
          {/* Left: download all + reverse share upload */}
          <div className="flex items-center gap-2" data-tutorial="grid-actions">
            {(() => {
              if (isGuest) return null
              const approvedCount = project.videosByName
                ? Object.values(project.videosByName as Record<string, any[]>)
                    .filter((versions) => versions.some((v: any) => v.approved))
                    .length
                : 0
              const showDownloadAll = project.allowAssetDownload && approvedCount >= 2
              const showUpload = project.allowReverseShare && shareToken
              if (!showDownloadAll && !showUpload) return null
              return (
                <>
                  {showDownloadAll && (
                    <button
                      onClick={handleDownloadAll}
                      disabled={downloadingAll}
                      className="p-2 rounded-lg border border-border bg-background hover:bg-accent transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {downloadingAll ? <Loader2 className="h-5 w-5 text-foreground animate-spin" /> : <Download className="h-5 w-5 text-foreground" />}
                      <span className="hidden sm:inline text-sm font-medium text-foreground">{t('downloadAllVideos', { count: approvedCount })}</span>
                    </button>
                  )}
                  {showUpload && (
                    <ReverseShareUploadPanel
                      shareToken={shareToken}
                      shareSlug={token}
                      maxFiles={project.settings?.maxReverseShareFiles ?? 10}
                    />
                  )}
                </>
              )
            })()}
          </div>

          {/* Right: language, theme, tutorial */}
          <div className="flex items-center gap-2 ml-auto">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="w-full px-3 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8" data-tutorial="video-grid">
            <ThumbnailGrid
              videosByName={effectiveVideosByName ?? project.videosByName}
              thumbnailsByName={thumbnailsByName}
              thumbnailsLoading={thumbnailsLoading}
              onVideoSelect={handleVideoSelect}
              projectTitle={project.title}
              projectDescription={isGuest ? undefined : project.description}
              clientName={isGuest ? undefined : project.clientName}
            />
          </div>
          {/* Powered by footer */}
          <div className="pb-4 text-center">
            <a
              href="https://github.com/DragosOnisei/FrameComment"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              Powered by FrameComment
            </a>
          </div>
        </div>
      </div>

      {/* Privacy Disclosure Banner */}
      {project.settings?.privacyDisclosureEnabled && (
        <PrivacyBanner customText={project.settings.privacyDisclosureText} slug={token} shareToken={shareToken} />
      )}
      </>
    )
  }

  // Whether to show comment panel (not hidden by project settings, user toggle, or guest status)
  const showCommentPanel = !project.hideFeedback && !isGuest && !hideComments

  return (
    // 3.2.0+: align client share view with the v2.5+ admin player —
    // `spotlight-bg-tr` paints the same top-right anchored spotlight
    // gradient + accent-tinted radial wash the admin uses, instead of
    // a flat `bg-background`. Combined with the inner glass surfaces
    // (player + comments sidebar), the public share page now reads as
    // the same product instead of a stripped-down clone.
    <div
      className="spotlight-bg-tr h-screen overflow-hidden lg:fixed lg:inset-0 flex flex-col"
      style={{ height: '100dvh' }}
    >
      {/* Thumbnail Reel - always visible, collapsible */}
        <ThumbnailReel
          videosByName={effectiveVideosByName ?? project.videosByName}
          thumbnailsByName={thumbnailsByName}
          activeVideoName={activeVideoName}
          activeVideoId={activeVideoId}
          onVideoSelect={handleVideoSelect}
          onBackToGrid={handleBackToGrid}
          showBackButton={true}
          showCommentToggle={!project.hideFeedback && !isGuest}
          isCommentPanelVisible={!hideComments}
          onToggleCommentPanel={() => setHideComments(!hideComments)}
          trailingAction={undefined}
        />

        {/* 1.4.x+: share-link expiration countdown. Thin strip pinned
            above the player + comments so the recipient sees how much
            time is left on the link they're using. Hidden once we're
            past the cut-off (the 410 branch above takes over). */}
        {project.shareExpiresAt && (() => {
          const expiry = new Date(project.shareExpiresAt)
          const ms = expiry.getTime() - Date.now()
          if (ms <= 0) return null
          const days = Math.floor(ms / (24 * 60 * 60 * 1000))
          const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
          const label =
            days >= 1
              ? `Expires in ${days} ${days === 1 ? 'day' : 'days'}`
              : hours >= 1
                ? `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
                : 'Expires soon'
          const accent =
            ms <= 24 * 60 * 60 * 1000
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'border-border bg-muted/40 text-muted-foreground'
          return (
            <div
              role="status"
              aria-live="polite"
              className={`shrink-0 border-b px-3 sm:px-4 py-1.5 text-xs flex items-center gap-2 ${accent}`}
            >
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {label}{' '}
                <span className="text-foreground/80 font-medium">
                  ({expiry.toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })})
                </span>
              </span>
            </div>
          )
        })()}

      {/* Main Content Area — fills the remaining viewport from lg+. We
          also lay it out side-by-side (player left, comments right) from
          lg+ rather than stacking vertically until xl+: at landscape
          viewports like Nest Hub (1024×600) the stacked layout left the
          comments eating most of the height and the player squeezed to
          ~70px. On mobile the page falls back to a natural-scroll column. */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row p-2 sm:p-3 gap-2 sm:gap-3">
        {readyVideos.length === 0 ? (
          /* 3.2.0+: same frosted-glass card recipe as the `if (!project)`
             initial loading state above — so the transition from "project
             still loading" → "project loaded, video tokens still loading"
             is visually seamless. The user sees ONE continuous glass card
             instead of two flat cards flashing in sequence. */
          <div className="flex-1 flex items-center justify-center p-4">
            <div
              className="rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white px-8 py-7 flex items-center gap-4"
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
              {tokensLoading && (
                <div className="h-5 w-5 rounded-full border-2 border-white/20 border-t-white/85 animate-spin shrink-0" />
              )}
              <p className="text-sm font-medium text-white/85">
                {tokensLoading ? 'Loading video...' : 'No videos are ready for review yet. Please check back later.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Video Player — natural height on mobile, fills space from
                lg+. We use lg: thresholds (not xl:) so a typical laptop
                window also locks the player to the visible area.
                1.3.2+: `sticky top-0` on phones so the video frame +
                timeline + controls stay pinned at the top of the
                viewport while the comments scroll underneath. `bg-
                background` keeps the comments from showing through.
                From lg: up sticky becomes irrelevant (side-by-side
                layout) so we let those classes pass through harmlessly. */}
            {/* 3.2.0+: drop `bg-background` so the outer `spotlight-bg-tr`
                gradient shows through around the player margins — same
                layering as the admin view. */}
            <div data-tutorial="video-player" className={`shrink-0 lg:shrink lg:h-full lg:min-h-0 lg:flex-1 min-w-0 flex flex-col ${showCommentPanel ? 'xl:flex-[2] 2xl:flex-[2.5]' : ''}`}>
              <VideoPlayer
                videos={readyVideos}
                projectId={project.id}
                projectStatus={project.status}
                defaultQuality={defaultQuality}
                projectTitle={project.title}
                projectDescription={isGuest ? null : project.description}
                clientName={isGuest ? null : project.clientName}
                isPasswordProtected={isPasswordProtected || false}
                watermarkEnabled={project.watermarkEnabled}
                activeVideoName={activeVideoName}
                onApprove={isGuest ? undefined : fetchProjectData}
                authenticatedEmail={authenticatedEmail}
                authenticatedName={authenticatedName}
                initialSeekTime={initialSeekTime}
                initialVideoIndex={initialVideoIndex}
                isAdmin={false}
                isGuest={isGuest}
                allowAssetDownload={project.allowAssetDownload}
                clientCanApprove={project.clientCanApprove}
                shareToken={shareToken}
                comments={!project.hideFeedback && !isGuest ? filteredComments : []}
                timestampDisplayMode={project.timestampDisplay || 'TIMECODE'}
                onCommentFocus={(commentId) => setFocusCommentId(commentId)}
                usePreviewForApprovedPlayback={project.usePreviewForApprovedPlayback}
                fillContainer={true}
                onVideoStateChange={(state) => {
                  // Surface the currently-playing video id so the title-bar
                  // version dropdown (ThumbnailReel) can highlight the row.
                  setActiveVideoId(state.selectedVideo?.id)
                }}
              />
            </div>

            {/* Comments Section - max one screen height on mobile, side panel on desktop.
                3.2.0+: matches admin — `rounded-2xl` for the larger, more elegant
                glass-card corners, and drop the opaque `bg-card` so the inner
                CommentSection's frosted glass surface (white/[0.04] + spotlight
                radial) is what we see, not a flat dark fill on top of it. */}
            {showCommentPanel && (
              <ResizableSidebar
                storageKey={`framecomment:sidebar-width:${project.id}`}
                defaultWidth={360}
                minWidth={280}
                maxFraction={0.55}
                className="flex-1 min-h-0 flex flex-col lg:max-h-full lg:h-full overflow-hidden rounded-2xl"
              >
                <CommentSection
                  projectId={project.id}
                  comments={filteredComments}
                  focusCommentId={focusCommentId}
                  clientName={project.clientName}
                  clientEmail={project.clientEmail}
                  isApproved={project.status === 'APPROVED' || project.status === 'SHARE_ONLY'}
                  restrictToLatestVersion={project.restrictCommentsToLatestVersion}
                  videos={readyVideos}
                  isAdminView={false}
                  smtpConfigured={project.smtpConfigured}
                  isPasswordProtected={isPasswordProtected || false}
                  recipients={project.recipients || []}
                  shareToken={shareToken}
                  showShortcutsButton={true}
                  timestampDisplayMode={project.timestampDisplay || 'TIMECODE'}
                  mobileCollapsible={true}
                  initialMobileCollapsed={false}
                  authenticatedEmail={authenticatedEmail}
                  allowClientAssetUpload={project.allowClientAssetUpload || false}
                  maxCommentAttachments={project.settings?.maxCommentAttachments ?? 10}
                  onToggleVisibility={() => setHideComments(!hideComments)}
                  showToggleButton={false}
                  clientSessionId={(project as any).clientSessionId || null}
                />
              </ResizableSidebar>
            )}
          </>
        )}
      </div>

      {/* Privacy Disclosure Banner */}
      {project.settings?.privacyDisclosureEnabled && (
        <PrivacyBanner customText={project.settings.privacyDisclosureText} slug={token} shareToken={shareToken} />
      )}
    </div>
  )
}
