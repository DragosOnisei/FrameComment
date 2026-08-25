'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, usePathname, useRouter } from 'next/navigation'
import VideoPlayer from '@/components/VideoPlayer'
import CommentSection from '@/components/CommentSection'
import ShareOnboarding from '@/components/ShareOnboarding'
import { useDelayedFlag } from '@/lib/use-delayed-flag'
import { AnnotationProvider } from '@/contexts/AnnotationContext'
import ThumbnailGrid from '@/components/ThumbnailGrid'
import ThumbnailReel from '@/components/ThumbnailReel'
import ShareOpenInProjectBanner from '@/components/ShareOpenInProjectBanner'
import ResizableSidebar from '@/components/ResizableSidebar'
import { OTPInput } from '@/components/OTPInput'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Button } from '@/components/ui/button'
import { Lock, Check, Mail, KeyRound, Download, Loader2 } from 'lucide-react'
import BrandLogo from '@/components/BrandLogo'
import { loadShareToken, saveShareToken } from '@/lib/share-token-store'
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
  // 3.2.x: single-video share detection. A `sig` param means the link
  // was minted for ONE video (HMAC-signed via share-video-sig), so the
  // dataset is locked to that clip — there is no grid to go "Back" to.
  const isSingleVideoShare = !!(searchParams?.get('sig'))

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
    // 6.2.1: NEVER scope down to nothing. Arriving from a folder share with a
    // folderId that matches no video (its clips aren't READY yet, or the
    // payload simply doesn't carry them) used to leave the visitor on a blank
    // "Select a video to begin" page with no explanation. Falling back to the
    // whole project is imperfect, but it is never a dead end.
    if (Object.keys(filtered).length === 0) return project.videosByName
    return filtered
  }, [project?.videosByName, urlFolderId])
  // 6.3.2: name the medium on the page-level slate — a still used to greet
  // the client with "Loading video...".
  const pageLoadingLabel = (() => {
    const group = urlVideoName
      ? (project?.videosByName as Record<string, any[]> | undefined)?.[urlVideoName]
      : null
    const first = Array.isArray(group) ? group[0] : null
    return (first as any)?.mediaType === 'IMAGE' ? 'Loading Image…' : 'Loading Video…'
  })()

  const [comments, setComments] = useState<any[]>([])
  const [_commentsLoading, setCommentsLoading] = useState(false)
  const [_companyName, setCompanyName] = useState('Studio')
  const [defaultQuality, setDefaultQuality] = useState<'720p' | '1080p' | '2160p'>('720p')
  const [activeVideoName, setActiveVideoName] = useState<string>('')
  // Currently-playing video id, surfaced from VideoPlayer via
  // onVideoStateChange. Used by ThumbnailReel to highlight the active row
  // in the version dropdown.
  const [activeVideoId, setActiveVideoId] = useState<string | undefined>(undefined)
  // 7.1.0: a signed-in viewer is no longer redirected off this page.
  //
  // 3.8.x through 7.0.1 detected an admin session here and immediately
  // `router.replace()`d into the admin app, aiming at the folder holding the
  // shared content. For a link scoped to ONE video that meant landing in a
  // folder listing every video in it — and when a folder holds several
  // near-identical cuts, the person who followed the link could no longer tell
  // which one was shared with them. The link failed precisely by succeeding.
  //
  // The share now always shows what was shared. ShareOpenInProjectBanner offers
  // the trip to the folder instead, and only to a session that has proved it can
  // actually read this project — see the component for why authentication alone
  // was the wrong test.

  const [activeVideos, setActiveVideos] = useState<any[]>([])
  const [activeVideosRaw, setActiveVideosRaw] = useState<any[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  // 6.3.4: one quiet loading state instead of a chain of cards.
  const showTokenSlate = useDelayedFlag(tokensLoading, 350)
  // 6.3.5: "still resolving" is NOT the same as "nothing to review" — see the
  // render branch below for the bug this distinction fixes.
  const stillPreparing = tokensLoading || (!!activeVideoName && activeVideos.length === 0)
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
  // 7.1.3: sprite sheet per grid tile, so a client can scrub a thumbnail with
  // the mouse exactly as an admin can inside the app.
  const [storyboardsByName, setStoryboardsByName] = useState<Map<string, string>>(new Map())
  const storyboardUrlCacheRef = useRef<Map<string, string>>(new Map())
  const [thumbnailsLoading, setThumbnailsLoading] = useState(true)
  const [downloadingAll, setDownloadingAll] = useState(false)
  // 7.1.5: a failed download used to be swallowed entirely — see the handler.
  const [downloadError, setDownloadError] = useState<string | null>(null)
  // 3.2.x: mobile-only vertical resize of the player vs comments. On
  // phones the layout stacks (video on top, comments below); a grip
  // between them lets the viewer drag the split up/down. `null` height
  // = natural/default. We only apply the inline height while the mobile
  // (stacked) layout is active so it never fights the desktop lg: flex
  // sizing.
  const [isMobileLayout, setIsMobileLayout] = useState(false)
  const [mobileVideoHeight, setMobileVideoHeight] = useState<number | null>(null)
  const mobileResizeRef = useRef<{ active: boolean; startY: number; startHeight: number }>({
    active: false,
    startY: 0,
    startHeight: 0,
  })
  // 3.5.x: the natural (default) split height of the video on mobile.
  // Captured the first time the user drags from the un-resized state.
  // It's the MAXIMUM the video is allowed to be — you can drag the grip
  // UP to shrink/hide the video, but never DOWN to grow it past default.
  const defaultMobileVideoHeightRef = useRef<number | null>(null)
  const playerColRef = useRef<HTMLDivElement>(null)
  const mainContentRef = useRef<HTMLDivElement>(null)
  const storageKey = token || ''
  const tokenCacheRef = useRef<Map<string, any>>(new Map())
  const inFlightTokenRequestsRef = useRef<Map<string, Promise<string>>>(new Map())
  // 2.2.3+: thumbnail URL cache (videoId → /api/content/<token>).
  // Mirrors the admin share page fix — see the long comment above the
  // thumbnails effect there. The public share page doesn't have a 3.5s
  // poll, but `fetchProjectData` (called on OTP / password
  // success) wipes `tokenCacheRef` and triggers a fresh `setProject`,
  // which re-fires the thumbnails effect with a new `videosByName`
  // reference. Without per-videoId thumbnail caching every refetch
  // burst-fires N thumbnail token requests at the same endpoint —
  // small N today, but the public path has no rate-limit headroom and
  // a project with many versions would hit the same wall.
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

  // Fetch project data function
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

        // Clear token cache to force a re-fetch of the video tokens
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
      ].join('|'))
      .join('::')
  }, [])

  // Set active video when project loads, handling URL parameters
  useEffect(() => {
    // 3.9.x/4.0: use the FOLDER-SCOPED map (effectiveVideosByName), not
    // the raw project map. When a client opens a folder share link
    // (`&folderId=`), two different assets that happen to share a name in
    // different folders (e.g. a 4:5 cut in the 4:5 folder and a 9:16 cut
    // in the 9:16 folder) must NOT be merged into one version group —
    // otherwise the player picks the wrong variant's stream/dimensions
    // and a 9:16 clip renders at 4:5. Same fix as the admin player.
    if (effectiveVideosByName) {
      const videoNames = Object.keys(effectiveVideosByName)
      if (videoNames.length === 0) return

      // Determine which video group should be active
      if (!activeVideoName) {
        let videoNameToUse: string | null = null

        // Priority 1: URL parameter for video name
        if (urlVideoName && effectiveVideosByName[urlVideoName]) {
          videoNameToUse = urlVideoName
        }
        // Priority 2: First video
        if (!videoNameToUse) {
          videoNameToUse = videoNames[0]
        }

        setActiveVideoName(videoNameToUse)

        const videos = effectiveVideosByName[videoNameToUse]
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
        // Keep activeVideos in sync when project data refreshes (thumbnails / tokens)
        const videos = effectiveVideosByName[activeVideoName]
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
  }, [effectiveVideosByName, activeVideoName, urlVideoName, urlVersion, urlTimestamp, fingerprintRawVideos])

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

          // 6.11.0: one token plan for every video. Approval used to switch
          // between "stream the original" and "stream the preview ladder";
          // it no longer exists, so we always mint the ladder for playback
          // and, when the project allows downloads, an original for the
          // download button.
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
          if (project?.allowAssetDownload) {
            downloadToken = await fetchVideoTokenWithRetry(video.id, 'original')
          }

          let thumbnailUrl = null
          if (video.thumbnailPath) {
            const thumbToken = await fetchVideoTokenWithRetry(video.id, 'thumbnail')
            if (thumbToken) {
              thumbnailUrl = `/api/content/${thumbToken}`
            }
          }

          // 3.8.x: mint the storyboard sprite token so the player
          // timeline can show the Frame.io-style hover-scrub frame
          // preview. The token route returns '' when there's no sprite.
          let storyboardUrl = null
          if (video.storyboardPath) {
            const storyboardToken = await fetchVideoTokenWithRetry(video.id, 'storyboard')
            if (storyboardToken) {
              storyboardUrl = `/api/content/${storyboardToken}`
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
            storyboardUrl,
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
  }, [shareToken, fetchVideoTokenWithRetry, project?.allowAssetDownload])

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
  // `project.videosByName` reference (refetch, OTP /
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
      const newStoryboards = new Map<string, string>()

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
      // 7.1.3: "are we in player view" has to mean the targeted video actually
      // EXISTS in this payload, not merely that the URL carries a name. When a
      // single-video link no longer resolves — the server then serves the whole
      // project rather than an empty page — the old test stayed true, so this
      // filtered the fetch list down to a name that is not there and came back
      // with NOTHING. The client was shown the grid, correctly, with every tile
      // missing its thumbnail. That empty-looking grid is what read as "the old
      // platform".
      const inPlayerView = !!(
        urlVideoName &&
        (project.videosByName as Record<string, any[]> | undefined)?.[urlVideoName]
      )
      // 4.7.x safety net: never eagerly mint more than this many thumbnail
      // tokens for a full-project grid. A client opening a project-wide share
      // of a multi-thousand-video project would otherwise fan out one signed
      // token request per clip and strain the instance; tiles past the cap
      // render without a thumbnail rather than taking the server down.
      const GRID_THUMBNAIL_CAP = 120
      const targetEntries = inPlayerView
        ? Array.from(nameToVideoWithThumb.entries()).filter(([name]) => name === urlVideoName)
        : Array.from(nameToVideoWithThumb.entries()).slice(0, GRID_THUMBNAIL_CAP)

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
          if (isMounted) newThumbnails.set(name, cachedUrl)
        } else {
          const thumbToken = await fetchVideoTokenWithRetry(videoWithThumb.id, 'thumbnail')
          if (thumbToken && isMounted) {
            const url = `/api/content/${thumbToken}`
            thumbnailUrlCacheRef.current.set(videoWithThumb.id, url)
            newThumbnails.set(name, url)
          }
        }

        // 7.1.3: the sprite for hover-scrub. Grid only — the player has its own
        // storyboard for the timeline, and doubling the token fan-out on the
        // player path is exactly what 3.2.3 fixed. Skipped entirely when the
        // row has no sprite, so nothing is requested that cannot exist.
        if (inPlayerView || !videoWithThumb.storyboardPath) return
        const cachedSprite = storyboardUrlCacheRef.current.get(videoWithThumb.id)
        if (cachedSprite) {
          if (isMounted) newStoryboards.set(name, cachedSprite)
          return
        }
        const spriteToken = await fetchVideoTokenWithRetry(videoWithThumb.id, 'storyboard')
        if (spriteToken && isMounted) {
          const url = `/api/content/${spriteToken}`
          storyboardUrlCacheRef.current.set(videoWithThumb.id, url)
          newStoryboards.set(name, url)
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
            setStoryboardsByName(newStoryboards)
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
    // 4.0: folder-scoped group (see the selection effect note) so a
    // same-named clip in another folder can't leak its stream/aspect in.
    setActiveVideosRaw(
      effectiveVideosByName?.[videoName] ?? project.videosByName[videoName],
    )
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
  }, [project?.videosByName, effectiveVideosByName, searchParams, pathname, router])

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

  // 3.2.x: track whether we're in the stacked (mobile) layout — matches
  // the lg breakpoint Tailwind uses to switch from column to row. When
  // we leave mobile, drop any custom video height so the desktop flex
  // sizing takes over cleanly.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 1023px)')
    const update = () => {
      setIsMobileLayout(mq.matches)
      if (!mq.matches) setMobileVideoHeight(null)
    }
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // 3.2.x: drag the mobile video/comments split. Records the player's
  // current height on grab, then tracks pointer/touch movement on the
  // window so the drag keeps working past the thin grip. Clamped so
  // neither the video nor the comments can collapse to nothing.
  const beginMobileResize = useCallback((clientY: number) => {
    const el = playerColRef.current
    if (!el) return
    const startHeight = el.getBoundingClientRect().height
    // The default natural split is the MAX video size. Capture it the
    // first time we drag from the un-resized (null) state so we can clamp
    // against it forever after.
    if (mobileVideoHeight === null) {
      defaultMobileVideoHeightRef.current = startHeight
    }
    mobileResizeRef.current = {
      active: true,
      startY: clientY,
      startHeight,
    }
    const clampHeight = (h: number) => {
      // 3.5.x: the video can shrink all the way to 0 (drag the grip UP to
      // hide it and leave just the comments — the grip stays pinned at
      // the top so it can be pulled back down), but it can NEVER grow
      // past the default natural height (no dragging DOWN past default).
      const max = defaultMobileVideoHeightRef.current ?? startHeight
      return Math.max(0, Math.min(h, max))
    }
    const move = (cy: number) => {
      if (!mobileResizeRef.current.active) return
      const dy = cy - mobileResizeRef.current.startY
      setMobileVideoHeight(clampHeight(mobileResizeRef.current.startHeight + dy))
    }
    const onMouseMove = (e: MouseEvent) => move(e.clientY)
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) {
        move(e.touches[0].clientY)
        // Stop the page from scrolling while dragging the split.
        e.preventDefault()
      }
    }
    const end = () => {
      mobileResizeRef.current.active = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', end)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', end)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', end)
  }, [mobileVideoHeight])

  /**
   * 7.1.5: one video downloads as that video, not as a ZIP of one.
   *
   * This handler has always minted the bulk-ZIP token, which is right for a
   * share holding several clips and wrong for a share holding one: the server
   * builds an archive nobody asked for, the transfer is slow enough to look
   * broken — Dragos watched it sit at 64KB "Resuming…" — and what lands is
   * `<project>_all_videos.zip` rather than the film. The single-clip case now
   * takes the same route the player uses: mint an `original` token for the
   * newest version and let the browser save the file. `allowAssetDownload`
   * still gates it, on the server as well as on the button.
   *
   * The failure is no longer silent. `catch { // Silently fail - user can
   * retry }` is how a broken download looks identical to a slow one, which is
   * exactly the confusion this started as.
   */
  const handleDownloadAll = useCallback(async () => {
    if (downloadingAll || !shareToken) return

    const saveAs = (url: string) => {
      const link = document.createElement('a')
      link.href = url
      link.download = ''
      link.rel = 'noopener'
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }

    try {
      setDownloadingAll(true)
      setDownloadError(null)

      const groups = Object.values(
        (project?.videosByName as Record<string, any[]> | undefined) ?? {},
      )
      // Newest version first — the server sorts each group descending.
      const onlyVideoId =
        groups.length === 1 ? (groups[0]?.[0]?.id as string | undefined) : undefined

      if (onlyVideoId) {
        const originalToken = await fetchVideoTokenWithRetry(onlyVideoId, 'original')
        if (!originalToken) throw new Error('Download link unavailable')
        saveAs(`/api/content/${originalToken}?download=true`)
        return
      }

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
      saveAs(url)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloadingAll(false)
    }
  }, [downloadingAll, shareToken, token, project, fetchVideoTokenWithRetry])

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
      // 7.1.2: see the grid branch below — flat `bg-background` is the pre-2.5
      // #121212 surface, and "your link expired" should not also look like the
      // product was abandoned.
      <div className="spotlight-bg-tr flex-1 min-h-0 flex items-center justify-center p-6">
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
      // 7.1.2: this is the FIRST thing a client ever sees of a protected share,
      // so it gets the same surface as everything after it rather than the flat
      // legacy one.
      <div className="spotlight-bg-tr flex-1 min-h-0 flex items-center justify-center p-4">
        {/* Language toggle for auth view. 3.2.6+: theme toggle removed —
            the client share is dark-only, no light-mode switch. */}
        <div className="fixed top-3 right-3 z-20 flex items-center gap-2">
          <LanguageToggle />
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
          <p className="text-sm font-medium text-white/85">{pageLoadingLabel}</p>
        </div>
      </div>
    )
  }

  // Filter to READY videos first
  const readyVideos = activeVideos.filter((v: any) => v.status === 'READY')

  // 6.11.0: no approval filter — every ready version is listed.

  // 3.2.x: active version's signed download URL for the top-right
  // download button in the player toolbar. `downloadUrl` is only set on
  // the tokenized video when the clip is actually downloadable (project
  // allows it + the right token was minted), so gating the button on it
  // keeps the control honest.
  const activeReadyVideoForDownload =
    readyVideos.find((v: any) => v.id === activeVideoId) || readyVideos[0]
  const activeVideoDownloadUrl: string | null =
    activeReadyVideoForDownload?.downloadUrl || null
  const showToolbarDownload = !!(
    project.allowAssetDownload &&
    activeVideoDownloadUrl &&
    !isGuest
  )

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
          <p className="text-sm font-medium text-white/85">{pageLoadingLabel}</p>
        </div>
      </div>
    )
  }

  // Show thumbnail grid when in grid view (scrollable)
  //
  // 7.1.2: the wrapper was `bg-background`, which in dark mode is a flat
  // #121212 — the surface this app looked like before 2.5. Every other screen a
  // reviewer sees, including the player one branch below, paints
  // `spotlight-bg-tr`. So the moment a client opened a multi-video share they
  // met the old product, then stepped into the current one by picking a clip.
  //
  // It went unnoticed inside the org because a logged-in admin was redirected
  // straight into the admin app; 7.1.0 removed that redirect, which is what put
  // this page back in front of us. Clients had been seeing it all along.
  if (effectiveViewState === 'grid') {
    return (
      <>
      <div className="spotlight-bg-tr fixed inset-0 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {/* 7.1.5: the boxed layout the folder share uses, down to the same
              container and the same title row. Until now this page ran edge to
              edge with its controls pinned to the corners of the viewport, so
              two share links from the same product opened two different-looking
              pages — the last structural difference between them. */}
          <div className="max-w-screen-xl mx-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6 space-y-5">

            {/* Title row. The folder share puts the folder name on the left and
                its actions on the right; this page has no title to show — the
                project name was removed in 7.1.3 as part of the old header — so
                the language picker takes the left and the actions keep the
                right, which holds the row's shape. */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <LanguageToggle />
              <div className="flex items-center gap-2 flex-wrap" data-tutorial="grid-actions">
                {/* 7.1.6: only the reverse-share upload lives here now. The
                    download moved to the foot of the page, beside "Open in
                    project folder". */}
                {!isGuest && project.allowReverseShare && shareToken && (
                  <ReverseShareUploadPanel
                    shareToken={shareToken}
                    shareSlug={token}
                    maxFiles={project.settings?.maxReverseShareFiles ?? 10}
                  />
                )}
                {/* Item count, worded exactly as the folder share words it. */}
                {(() => {
                  const itemCount = project.videosByName
                    ? Object.keys(project.videosByName as Record<string, any[]>).length
                    : 0
                  return (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {itemCount === 1 ? '1 item' : `${itemCount} items`}
                    </span>
                  )
                })()}

              </div>
            </div>

            <div data-tutorial="video-grid">
              <ThumbnailGrid
                videosByName={effectiveVideosByName ?? project.videosByName}
                thumbnailsByName={thumbnailsByName}
                storyboardsByName={storyboardsByName}
                thumbnailsLoading={thumbnailsLoading}
                onVideoSelect={handleVideoSelect}
                projectDescription={isGuest ? undefined : project.description}
              />
            </div>
          </div>
          {/* 7.1.2: grid mode never had the "open in the full app" button —
              it was only wired into the player branch, so a project-level share
              (the case that lands here) had no way back. It goes above the
              footer, out of the way of the thumbnails.

              7.1.6: the download joins it here, to its right. The two are the
              only things on this page a visitor can DO, so they belong together
              rather than at opposite corners.

              7.1.6: it went green for one release and came straight back — the
              accent green read as a warning next to the blue beside it rather
              than as the friendlier button it was meant to be. Both actions now
              share the default primary, which is also what the folder share
              uses.

              A guest renders no banner at all, in which case the download
              simply centres on its own. */}
          <div className="pb-3 flex items-center justify-center gap-2 flex-wrap">
            <ShareOpenInProjectBanner
              projectId={project?.id}
              folderId={urlFolderId || null}
            />
            {(() => {
              if (isGuest) return null
              const downloadableCount = project.videosByName
                ? Object.keys(project.videosByName as Record<string, any[]>).length
                : 0
              if (!project.allowAssetDownload || downloadableCount < 1) return null
              return (
                <Button
                  size="sm"
                  onClick={handleDownloadAll}
                  disabled={downloadingAll}
                  className="gap-1.5"
                >
                  {downloadingAll ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  <span>
                    {downloadableCount === 1
                      ? t('downloadVideo')
                      : t('downloadAllVideos', { count: downloadableCount })}
                  </span>
                </Button>
              )
            })()}
            {/* 7.1.5: a download that fails says so — beside the button it
                describes, not in a different row. It used to fail into a silent
                catch, which is indistinguishable from one that is merely
                slow. */}
            {downloadError && (
              <span role="status" className="text-xs text-destructive w-full text-center">
                {downloadError}
              </span>
            )}
          </div>
          {/* Powered by footer.
              7.1.4: the AGPL-3.0 link is gone at Dragos's request, so this
              matches the folder share, which never carried one. Worth knowing
              what was traded: 6.7.1 added it because a reviewer reaches this
              page without ever seeing the public site, and AGPL §13 is about
              everyone who uses the software over a network. The repository link
              below still reaches the source, and /source serves it too. */}
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
      // 3.5.x: disable accidental text/element selection across the
      // whole player chrome (video, title, buttons). Click-dragging on
      // the video used to paint a big selection. The comments panel
      // re-enables selection on itself (see CommentSection) so feedback
      // text stays copyable.
      className="spotlight-bg-tr h-screen overflow-hidden lg:fixed lg:inset-0 flex flex-col select-none"
      style={{ height: '100dvh' }}
    >
      {/* 7.1.2: in the PLAYER branch this stays at the top, right-aligned.
          There is no "Powered by" line to sit above here — the player is a
          locked 100dvh layout with the reel, the video and the comments filling
          it exactly — so a bottom row would have to steal height from the
          video. It is a single small button now, not the old full-width notice.
          Resolves the same target the removed `router.replace` computed: the
          folder holding the shared content, falling back to the project root. */}
      {/* 7.1.6: only where there is no Back button.
          Reaching the player by clicking a tile in the grid, or from a folder
          share, leaves a Back arrow in the reel that already walks to the folder
          the clip lives in — so an "open in project folder" button beside it
          offers a second route to the same place and just crowds the bar.
          `showBackButton={!isSingleVideoShare}` below is the same condition, so
          the two can never both be missing.
          A link locked to a single clip is the exception: it draws no Back
          arrow, because there is no grid behind it to return to. There, this
          button is the only way a signed-in admin gets into the full app, and it
          stays. */}
      {isSingleVideoShare && (
      <div className="shrink-0 flex justify-end px-2 pt-2 sm:px-3 empty:hidden">
        <ShareOpenInProjectBanner
          projectId={project?.id}
          folderId={
            urlFolderId ||
            ((project as any)?.videos as
              | Array<{ id: string; folderId?: string | null }>
              | undefined)?.find((v) => v.id === activeVideoId)?.folderId ||
            ((project as any)?.videos as
              | Array<{ id: string; folderId?: string | null }>
              | undefined)?.[0]?.folderId ||
            null
          }
        />
      </div>
      )}

      {/* Thumbnail Reel - always visible, collapsible */}
        <ThumbnailReel
          videosByName={effectiveVideosByName ?? project.videosByName}
          thumbnailsByName={thumbnailsByName}
          activeVideoName={activeVideoName}
          activeVideoId={activeVideoId}
          // 3.2.x: feed the tokenized versions so the version reel shows
          // each version's real thumbnail (v1, v2, v3 …) instead of
          // blank placeholders. The admin share page already did this;
          // the client page didn't, so multi-version reels were empty.
          activeVersionsTokenized={activeVideos}
          onVideoSelect={handleVideoSelect}
          onBackToGrid={handleBackToGrid}
          // 3.2.x: no "Back" on a single-video share — there's no grid
          // to return to (the link is locked to one clip via `sig`).
          // Folder/project shares keep the button so the client can go
          // back to the folder grid.
          showBackButton={!isSingleVideoShare}
          showCommentToggle={!project.hideFeedback && !isGuest}
          isCommentPanelVisible={!hideComments}
          onToggleCommentPanel={() => setHideComments(!hideComments)}
          showThemeToggle={false}
          // 3.2.x: top-right download button so the client can grab the
          // current video (gated on the project allowing downloads + a
          // real download token). Especially relevant for single-video
          // shares, which have no grid-level "Download all".
          trailingAction={
            showToolbarDownload && activeVideoDownloadUrl ? (
              <button
                type="button"
                onClick={() => {
                  const a = document.createElement('a')
                  a.href = activeVideoDownloadUrl
                  a.download = ''
                  a.rel = 'noopener'
                  document.body.appendChild(a)
                  a.click()
                  a.remove()
                }}
                title={t('downloadVideo')}
                aria-label={t('downloadVideo')}
                className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/15 hover:ring-white/25 text-white/80 hover:text-white transition-colors"
              >
                <Download className="w-4 h-4" />
              </button>
            ) : undefined
          }
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
      <div ref={mainContentRef} className="flex-1 min-h-0 flex flex-col lg:flex-row p-2 sm:p-3 gap-2 sm:gap-3">
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
              {/* 6.3.5: same root cause as the admin player — "no ready
                  videos" is ALSO true for a beat while the version tokens are
                  being minted, so a perfectly good asset briefly told the
                  client there was nothing to review. Preparing and empty are
                  now separate states. */}
              {stillPreparing ? (
                showTokenSlate ? (
                  <>
                    <div className="h-5 w-5 rounded-full border-2 border-white/20 border-t-white/85 animate-spin shrink-0" />
                    <p className="text-sm font-medium text-white/85">{pageLoadingLabel}</p>
                  </>
                ) : null
              ) : (
                <p className="text-sm font-medium text-white/85">
                  No videos are ready for review yet. Please check back later.
                </p>
              )}
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
            <div
              ref={playerColRef}
              data-tutorial="video-player"
              className={`shrink-0 lg:shrink lg:h-full lg:min-h-0 lg:flex-1 min-w-0 flex flex-col ${showCommentPanel ? 'xl:flex-[2] 2xl:flex-[2.5]' : ''}`}
              // 3.2.x: on mobile (stacked layout) apply the dragged
              // height; on desktop leave it to the lg: flex sizing.
              style={isMobileLayout && mobileVideoHeight ? { height: `${mobileVideoHeight}px` } : undefined}
            >
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
                authenticatedEmail={authenticatedEmail}
                authenticatedName={authenticatedName}
                initialSeekTime={initialSeekTime}
                initialVideoIndex={initialVideoIndex}
                isAdmin={false}
                isGuest={isGuest}
                allowAssetDownload={project.allowAssetDownload}
                shareToken={shareToken}
                comments={!project.hideFeedback && !isGuest ? filteredComments : []}
                timestampDisplayMode={project.timestampDisplay || 'TIMECODE'}
                onCommentFocus={(commentId) => setFocusCommentId(commentId)}
                fillContainer={true}
                onVideoStateChange={(state) => {
                  // Surface the currently-playing video id so the title-bar
                  // version dropdown (ThumbnailReel) can highlight the row.
                  setActiveVideoId(state.selectedVideo?.id)
                }}
              />
              {/* 3.8.x: first-visit 3-step onboarding (name → range handle
                  → annotate). Only runs once, and never for a logged-in
                  admin. Mounts with the player so its anchors exist. */}
              <ShareOnboarding />
            </div>

            {/* 3.2.x: mobile-only drag grip between the video and the
                comments. Drag up/down to grow/shrink the video (and so
                shrink/grow the comments). Double-click resets to the
                natural split. Hidden from lg+ where the side
                ResizableSidebar handles resizing instead. */}
            {showCommentPanel && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize video and comments"
                onMouseDown={(e) => {
                  e.preventDefault()
                  beginMobileResize(e.clientY)
                }}
                onTouchStart={(e) => {
                  if (e.touches[0]) beginMobileResize(e.touches[0].clientY)
                }}
                onDoubleClick={() => setMobileVideoHeight(null)}
                className="lg:hidden shrink-0 h-6 -my-1 flex items-center justify-center cursor-ns-resize touch-none select-none group"
                title="Drag to resize • double-click to reset"
              >
                <div className="h-1.5 w-12 rounded-full bg-white/30 ring-1 ring-white/10 group-hover:w-16 group-hover:bg-primary/70 group-hover:ring-primary/40 transition-all" />
              </div>
            )}

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
