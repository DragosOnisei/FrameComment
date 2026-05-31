'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import VideoPlayer from '@/components/VideoPlayer'
import CommentSection from '@/components/CommentSection'
import { AnnotationProvider } from '@/contexts/AnnotationContext'
import ThumbnailGrid from '@/components/ThumbnailGrid'
import ThumbnailReel from '@/components/ThumbnailReel'
import ResizableSidebar from '@/components/ResizableSidebar'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import ThemeToggle from '@/components/ThemeToggle'
import PlayerTopMenu from '@/components/PlayerTopMenu'
import { useTranslations } from 'next-intl'

const MAX_TOKEN_FETCH_ATTEMPTS = 2
const TOKEN_FETCH_RETRY_BASE_MS = 120
const TOKEN_FETCH_RETRY_MAX_MS = 400

type TokenFetchTelemetryEvent = 'first-attempt-failure' | 'retry-success' | 'retry-failure'

export default function AdminSharePage() {
  return (
    <AnnotationProvider>
      <AdminSharePageInner />
    </AnnotationProvider>
  )
}

function AdminSharePageInner() {
  const t = useTranslations('projects')
  const tc = useTranslations('common')
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const id = params?.id as string

  // Parse URL parameters for video seeking (same as public share page)
  const urlTimestamp = searchParams?.get('t') ? parseFloat(searchParams.get('t')!) : null
  // 1.9.4+ Phase B: when the player triggers a "new tier
  // arrived" page refresh, it appends `&autoplay=1` so playback
  // resumes seamlessly from where the user was watching. Without
  // this the reload would land at currentTime=t but paused.
  const urlAutoplay = searchParams?.get('autoplay') === '1'
  const urlVideoName = searchParams?.get('video') || null
  const urlVersion = searchParams?.get('version') ? parseInt(searchParams.get('version')!, 10) : null
  const urlFocusCommentId = searchParams?.get('comment') || null

  const [focusCommentId, setFocusCommentId] = useState<string | null>(urlFocusCommentId)
  const [project, setProject] = useState<any>(null)
  const [comments, setComments] = useState<any[]>([])
  const [_commentsLoading, setCommentsLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [_companyName, setCompanyName] = useState('Studio')
  const [defaultQuality, setDefaultQuality] = useState<'720p' | '1080p' | '2160p'>('720p')
  const [activeVideoName, setActiveVideoName] = useState<string>('')
  // Currently-playing video id (specific version), surfaced from
  // VideoPlayer via onVideoStateChange. Used by ThumbnailReel to
  // highlight the active row in the version dropdown.
  const [activeVideoId, setActiveVideoId] = useState<string | undefined>(undefined)
  const [activeVideos, setActiveVideos] = useState<any[]>([])
  const [activeVideosRaw, setActiveVideosRaw] = useState<any[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  const [initialSeekTime, setInitialSeekTime] = useState<number | null>(null)
  const [initialVideoIndex, setInitialVideoIndex] = useState<number>(0)
  const [adminUser, setAdminUser] = useState<any>(null)
  const [hideComments, setHideComments] = useState(false)
  const [viewState, setViewState] = useState<'grid' | 'player'>('grid')
  const [thumbnailsByName, setThumbnailsByName] = useState<Map<string, string>>(new Map())
  const [thumbnailsLoading, setThumbnailsLoading] = useState(true)
  const tokenCacheRef = useRef<Map<string, any>>(new Map())
  const sessionIdRef = useRef<string>(`admin:${Date.now()}`)
  const inFlightTokenRequestsRef = useRef<Map<string, Promise<string>>>(new Map())
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
      window.dispatchEvent(new CustomEvent('adminShareTokenFetchTelemetry', { detail }))
    }

    if (process.env.NODE_ENV !== 'production') {
      console.debug('admin-share-token-fetch', detail)
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

  const fetchAdminVideoToken = useCallback(async (videoId: string, quality: string, sessionId: string) => {
    const response = await apiFetch(
      `/api/admin/video-token?videoId=${videoId}&projectId=${id}&quality=${quality}&sessionId=${sessionId}`,
      { cache: 'no-store' }
    )

    if (!response.ok) return ''
    const data = await response.json()
    return data.token || ''
  }, [id])

  const fetchAdminVideoTokenWithRetry = useCallback(async (videoId: string, quality: string, sessionId: string) => {
    const requestKey = `${sessionId}:${videoId}:${quality}`
    const inFlight = inFlightTokenRequestsRef.current.get(requestKey)
    if (inFlight) {
      return inFlight
    }

    const requestPromise = (async () => {
      for (let attempt = 1; attempt <= MAX_TOKEN_FETCH_ATTEMPTS; attempt += 1) {
        const tokenValue = await fetchAdminVideoToken(videoId, quality, sessionId)
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
  }, [
    emitTokenFetchTelemetry,
    fetchAdminVideoToken,
    waitForTokenRetry,
  ])

  // Fetch comments separately for security (same pattern as public share)
  const fetchComments = useCallback(async () => {
    if (!id) return

    setCommentsLoading(true)
    try {
      const response = await apiFetch(`/api/comments?projectId=${id}`, { cache: 'no-store' })
      if (response.ok) {
        const commentsData = await response.json()
      setComments(commentsData)
    }
  } catch (error) {
    // Failed to load comments
  } finally {
    setCommentsLoading(false)
  }
  }, [id])

  const transformProjectData = (projectData: any) => {
    const videosByName = projectData.videos.reduce((acc: any, video: any) => {
      const name = video.name
      if (!acc[name]) {
        acc[name] = []
      }
      acc[name].push(video)
      return acc
    }, {})

    // Sort versions within each video name (newest first)
    Object.keys(videosByName).forEach(name => {
      videosByName[name].sort((a: any, b: any) => b.version - a.version)
    })

    return {
      ...projectData,
      videosByName
    }
  }

  const fetchTokensForVideos = useCallback(async (videos: any[]) => {
    const sessionId = sessionIdRef.current

    return Promise.all(
      videos.map(async (video: any) => {
        // 1.9.4+ Phase A: cache key fingerprints both status AND
        // which tier paths have landed, so the cache rotates
        // whenever a new progressive tier becomes available (new
        // streamUrl* slot needs a real token). Status alone
        // wasn't enough — after the 480p READY flip, when 720p
        // and 1080p later finished the cache still returned the
        // pre-720p tokenization with their slots blank.
        const tierFingerprint = `${!!video.preview480Path ? 1 : 0}${!!video.preview720Path ? 1 : 0}${!!video.preview1080Path ? 1 : 0}${!!video.preview2160Path ? 1 : 0}`
        const cacheKey = `${sessionId}:${video.id}:${video.status || 'PROCESSING'}:${tierFingerprint}`
        const cached = tokenCacheRef.current.get(cacheKey)
        if (cached) {
          // Stream URLs are expensive to generate (one API call
          // per tier per session) so we keep them cached, but
          // overlay the fresh `processingProgress` + tier-path
          // flags + hlsQualities from the latest poll so the
          // Quality menu's "720p · 50%" badge actually advances
          // tick by tick AND the VideoPlayer's HLS manifest
          // reload effect sees new tiers as they land.
          return {
            ...cached,
            status: video.status,
            processingProgress: video.processingProgress,
            preview480Path: video.preview480Path,
            preview720Path: video.preview720Path,
            preview1080Path: video.preview1080Path,
            preview2160Path: video.preview2160Path,
            hlsQualities: video.hlsQualities,
            hlsBasePath: video.hlsBasePath,
            transcodeProgressByTier: (video as any).transcodeProgressByTier ?? {},
          }
        }

        try {
          // 1.9.4+ Phase A: also fetch 480p token for the fastest
          // progressive tier. Empty string for any tier that
          // hasn't transcoded yet — share-page UI honours that.
          // 1.9.4+ Phase B: also fetch an HLS session token; the
          // player prefers HLS when available (seamless quality
          // upgrade mid-playback), fallback to MP4 otherwise.
          const [token480, token720, token1080, token2160, tokenHls] = await Promise.all([
            fetchAdminVideoTokenWithRetry(video.id, '480p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, '720p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, '1080p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, '2160p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, 'hls', sessionId),
          ])

          let streamToken480p = token480
          let streamToken720p = token720
          let streamToken1080p = token1080
          let streamToken2160p = token2160
          let downloadToken = null

          // Always fetch the original as a fallback for admin preview.
          // Without this, videos uploaded with "Skip transcoding" (which
          // never produce 720p/1080p/2160p variants) couldn't be played
          // in the admin share page until they were approved — making it
          // impossible to actually review them before approval. The
          // /api/admin/video-token endpoint enforces admin auth, so the
          // original isn't exposed beyond the studio.
          //
          // 1.9.4+ Phase A: only fall back to the original when NO
          // preview tier is available. With progressive transcoding
          // a video may legitimately have 720p but no 1080p/2160p
          // yet; falling those higher slots back to the original
          // would lie about quality and serve full-res bytes when
          // 720p is actually ready. The skipTranscoding case still
          // works because in that mode none of the three tier
          // tokens are issued, so every slot is empty and we fall
          // back to original for all three.
          const originalToken = await fetchAdminVideoTokenWithRetry(video.id, 'original', sessionId)
          if (originalToken) {
            downloadToken = originalToken
            const hasAnyPreviewToken = streamToken480p || streamToken720p || streamToken1080p || streamToken2160p
            if (!hasAnyPreviewToken) {
              streamToken480p = originalToken
              streamToken720p = originalToken
              streamToken1080p = originalToken
              streamToken2160p = originalToken
            }
          }

          let thumbnailUrl = null
          if (video.thumbnailPath) {
            const thumbToken = await fetchAdminVideoTokenWithRetry(video.id, 'thumbnail', sessionId)
            if (thumbToken) {
              thumbnailUrl = `/api/content/${thumbToken}`
            }
          }

          // 1.9.4+ Phase B: build the HLS master URL when the
          // worker has produced HLS variants. hls.js / Safari
          // both follow ?token=xxx forward to playlists and
          // segments, so a single signed master URL covers the
          // whole adaptive session.
          const hlsUrl =
            tokenHls && (video as any).hlsQualities && (video as any).hlsQualities.length > 0
              ? `/api/videos/${video.id}/hls/master.m3u8?token=${encodeURIComponent(tokenHls)}`
              : ''

          const tokenized = {
            ...video,
            streamUrl480p: streamToken480p ? `/api/content/${streamToken480p}` : '',
            streamUrl720p: streamToken720p ? `/api/content/${streamToken720p}` : '',
            streamUrl1080p: streamToken1080p ? `/api/content/${streamToken1080p}` : '',
            streamUrl2160p: streamToken2160p ? `/api/content/${streamToken2160p}` : '',
            hlsUrl,
            downloadUrl: downloadToken ? `/api/content/${downloadToken}?download=true` : null,
            thumbnailUrl,
          }

          if (tokenized.streamUrl480p || tokenized.streamUrl720p || tokenized.streamUrl1080p || tokenized.streamUrl2160p || tokenized.downloadUrl || tokenized.thumbnailUrl) {
            tokenCacheRef.current.set(cacheKey, tokenized)
          }
          return tokenized
        } catch (error) {
          return video
        }
      })
    )
  }, [fetchAdminVideoTokenWithRetry])

  // Load project data, settings, and admin user
  // 1.9.4+ Phase A: extracted into a useCallback so we can re-call
  // it from the processing-progress poll below. `silent=true` skips
  // the `setLoading` flip so the page doesn't flash a "Loading..."
  // screen on each refresh while the worker chews through tiers.
  const loadProject = useCallback(
    async (silent: boolean = false) => {
      if (!id) {
        if (!silent) setLoading(false)
        return
      }
      try {
        const [projectResponse, userResponse, settingsResponse] = await Promise.all([
          apiFetch(`/api/projects/${id}`, { cache: 'no-store' }),
          apiFetch('/api/auth/session', { cache: 'no-store' }),
          apiFetch('/api/settings', { cache: 'no-store' }),
        ])

        if (projectResponse.ok) {
          const projectData = await projectResponse.json()

          if (userResponse.ok) {
            const userData = await userResponse.json()
            setAdminUser(userData.user)
          }

          if (settingsResponse.ok) {
            const settingsData = await settingsResponse.json()
            setCompanyName(settingsData.companyName || 'Studio')
          } else {
            setCompanyName(projectData.companyName || 'Studio')
          }

          const transformedData = transformProjectData(projectData)
          setProject(transformedData)
          // 1.9.4+ Phase A: "auto" is not a valid VideoPlayer
          // default — map it to 1080p (the typical good-quality
          // default for the player's quality picker). The actual
          // tier the worker produces is still source-matched.
          const playerDefault = projectData.previewResolution === 'auto'
            ? '1080p'
            : (projectData.previewResolution || '720p')
          setDefaultQuality(playerDefault)

          if (!projectData.hideFeedback && !silent) {
            fetchComments()
          }
        }
      } catch {
        // Silent fail
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [id, fetchComments],
  )

  useEffect(() => {
    loadProject()
  }, [loadProject])

  // 1.9.4+ Phase A: progressive transcoding poll.
  //
  // Polls the project endpoint every 3.5 s while:
  //   - any active video is still in PROCESSING / UPLOADING
  //     (first tier driving the spinner overlay), OR
  //   - the progressive ladder hasn't filled in for the current
  //     source — i.e. there's at least one tier between 480p and
  //     the input's short-side resolution that doesn't have a
  //     preview path yet.
  //
  // The second condition is what fixes "the Quality menu shows
  // 8% and never updates after status=READY": without it the
  // poll stopped the moment 480p landed, leaving the higher
  // tiers (720/1080/2160) frozen at whatever percentage they
  // were caught at on the last poll. The interval auto-clears
  // once the full ladder is in.
  useEffect(() => {
    const hasProcessing = (activeVideosRaw || []).some(
      (v: any) => v?.status === 'PROCESSING' || v?.status === 'UPLOADING',
    )
    const hasPendingHigherTier = (activeVideosRaw || []).some((v: any) => {
      if (!v) return false
      const shortSide = Math.min(v.width || 0, v.height || 0)
      if (shortSide <= 0) return false
      // 1.9.4+ Phase A: 90% tolerance so cinematic 1920×1008
      // sources still trigger polling for the 1080p tier.
      const meetsTier = (h: number) => shortSide >= h * 0.9
      if (meetsTier(720) && !v.preview720Path) return true
      if (meetsTier(1080) && !v.preview1080Path) return true
      if (meetsTier(2160) && !v.preview2160Path) return true
      return false
    })
    if (!hasProcessing && !hasPendingHigherTier) return
    const interval = setInterval(() => {
      loadProject(true)
    }, 3500)
    return () => clearInterval(interval)
  }, [activeVideosRaw, loadProject])

  // Listen for comment updates (post, delete, etc.)
  useEffect(() => {
    const handleCommentPosted = (e: CustomEvent) => {
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

  // Set active video when project loads, handling URL parameters
  useEffect(() => {
    if (project?.videosByName) {
      const videoNames = Object.keys(project.videosByName)
      if (videoNames.length === 0) return

      if (!activeVideoName) {
        let videoNameToUse: string | null = null

        if (urlVideoName && project.videosByName[urlVideoName]) {
          videoNameToUse = urlVideoName
        } else {
          const savedVideoName = sessionStorage.getItem('approvedVideoName')
          if (savedVideoName) {
            sessionStorage.removeItem('approvedVideoName')
            if (project.videosByName[savedVideoName]) {
              videoNameToUse = savedVideoName
            }
          }
        }

        if (!videoNameToUse) {
          const sortedVideoNames = videoNames.sort((nameA, nameB) => {
            const hasApprovedA = project.videosByName[nameA].some((v: any) => v.approved)
            const hasApprovedB = project.videosByName[nameB].some((v: any) => v.approved)

            if (hasApprovedA !== hasApprovedB) {
              return hasApprovedA ? 1 : -1
            }
            return 0
          })
          videoNameToUse = sortedVideoNames[0]
        }

        setActiveVideoName(videoNameToUse)

        const videos = project.videosByName[videoNameToUse]
        setActiveVideosRaw(videos)

        if (urlVersion !== null && videos) {
          const targetIndex = videos.findIndex((v: any) => v.version === urlVersion)
          if (targetIndex !== -1) {
            setInitialVideoIndex(targetIndex)
          }
        }

        if (urlTimestamp !== null) {
          setInitialSeekTime(urlTimestamp)
        }
      } else {
        const videos = project.videosByName[activeVideoName]
        if (videos) {
          setActiveVideosRaw(videos)
        }
      }
    }
  }, [project, activeVideoName, urlVideoName, urlVersion, urlTimestamp])

  // Tokenize active videos lazily
  useEffect(() => {
    let isMounted = true

    async function loadTokens() {
      if (!activeVideosRaw || activeVideosRaw.length === 0) {
        setTokensLoading(false)
        return
      }
      setTokensLoading(true)
      const tokenized = await fetchTokensForVideos(activeVideosRaw)
      if (isMounted) {
        setActiveVideos(tokenized)
      }
      setTokensLoading(false)
    }

    loadTokens()

    return () => {
      isMounted = false
    }
  }, [activeVideosRaw, fetchTokensForVideos])

  // Fetch thumbnails for all video groups
  useEffect(() => {
    let isMounted = true
    const sessionId = sessionIdRef.current

    async function fetchThumbnails() {
      if (!project?.videosByName || !id) {
        return
      }

      setThumbnailsLoading(true)
      const newThumbnails = new Map<string, string>()

      try {
        await Promise.all(
          Object.entries(project.videosByName as Record<string, any[]>).map(async ([name, videos]) => {
            const videoWithThumb = videos.find((v: any) => v.thumbnailPath)
            if (videoWithThumb) {
              const thumbToken = await fetchAdminVideoTokenWithRetry(videoWithThumb.id, 'thumbnail', sessionId)
              if (thumbToken && isMounted) {
                newThumbnails.set(name, `/api/content/${thumbToken}`)
              }
            }
          })
        )

        if (isMounted) {
          setThumbnailsByName(newThumbnails)
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
  }, [project?.videosByName, id, fetchAdminVideoTokenWithRetry])

  // Determine initial view state based on URL params (same behavior as public share)
  useEffect(() => {
    if (!project?.videosByName) return

    if (urlVideoName && project.videosByName[urlVideoName]) {
      setViewState('player')
      return
    }

    setViewState('grid')
  }, [project?.videosByName, urlVideoName])

  // 1.0.9+: track HOW the player was reached. `true` only when the
  // user picked a video from the in-page "Select a video" grid;
  // `false` when they landed straight on the player via a `?video=`
  // URL — which is exactly what the admin folder / project pages do
  // when you click a video card. The "Back" button reads this to
  // decide where to go (see `handleBackToGrid`).
  const enteredViaGridRef = useRef(false)

  // Handle video selection
  const handleVideoSelect = useCallback((videoName: string) => {
    enteredViaGridRef.current = true
    setActiveVideoName(videoName)
    setActiveVideosRaw(project.videosByName[videoName])
    setViewState('player')

    const params = new URLSearchParams(searchParams?.toString() || '')
    params.set('video', videoName)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [project?.videosByName, searchParams, pathname, router])

  // Handle the player's "Back" button.
  const handleBackToGrid = useCallback(() => {
    // Case A — the user picked this video from the in-page grid:
    // "Back" returns to that grid (the original behaviour).
    if (enteredViaGridRef.current) {
      setViewState('grid')
      const params = new URLSearchParams(searchParams?.toString() || '')
      params.delete('video')
      const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname
      router.replace(newUrl || '', { scroll: false })
      return
    }
    // Case B — the user arrived straight on the player (clicked a
    // card on the admin folder / project page). The in-page grid is
    // NOT where they came from — it's a redundant detour that just
    // looks like the client share view. Leave the share route
    // entirely and go back to the folder the video was opened from,
    // or the project root when there's no folder context.
    const folderId = searchParams?.get('folderId')
    router.push(
      folderId
        ? `/admin/projects/${id}/folder/${folderId}`
        : `/admin/projects/${id}`,
    )
  }, [searchParams, pathname, router, id])

  // "Back" target (1.0.9+). When the player was opened from inside a
  // folder, FolderBrowser tacks a `&folderId=` onto the share URL —
  // so "Back" should return to THAT folder, not the project root.
  // Falls back to the project root when there's no folder context.
  // This always stays on the admin side (`/admin/projects/...`); it
  // never bounces the admin out to the client-facing share view.
  const backFolderId = searchParams?.get('folderId') || null
  const projectUrl = backFolderId
    ? `/admin/projects/${id}/folder/${backFolderId}`
    : `/admin/projects/${id}`

  // Show loading state
  if (loading) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">{tc('loading')}</p>
      </div>
    )
  }

  // Show project not found
  if (!project) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center p-4">
        <Card className="bg-card">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">{t('projectNotFound')}</p>
            <Link href="/admin/projects">
              <Button>
                <ArrowLeft className="w-4 h-4 mr-2" />
                {t('backToProjects')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Filter to READY videos
  let readyVideos = activeVideos.filter((v: any) => v.status === 'READY')

  const hasApprovedVideo = readyVideos.some((v: any) => v.approved)
  if (hasApprovedVideo) {
    readyVideos = readyVideos.filter((v: any) => v.approved)
  }

  const activeVideoIds = new Set(activeVideos.map((v: any) => v.id))
  const filteredComments = comments.filter((comment: any) => {
    return !comment.videoId || activeVideoIds.has(comment.videoId)
  })

  const clientDisplayName = (() => {
    const primaryRecipient = project.recipients?.find((r: any) => r.isPrimary) || project.recipients?.[0]
    return project.companyName || primaryRecipient?.name || primaryRecipient?.email || t('client')
  })()

  const showCommentPanel = !project.hideFeedback && !hideComments

  // 1.3.2+: helpers feeding the new top-right PlayerTopMenu (Share /
  // Delete this version / Copy / Paste comments / theme).
  // - `activeVideo` is the specific version currently in the player
  //   (set by VideoPlayer via onVideoStateChange) so Delete targets it.
  // - `commentsForActiveVideo` mirrors what the sidebar shows, so the
  //   menu's "Copy comments (N)" badge matches the visible list.
  const activeVideo = activeVideoId
    ? readyVideos.find((v: any) => v.id === activeVideoId)
    : readyVideos[0]
  const commentsForActiveVideo = activeVideo
    ? filteredComments.filter((c: any) => c.videoId === activeVideo.id)
    : []
  const activeVersionLabel = activeVideo?.versionLabel
    || (activeVideo?.version ? `v${activeVideo.version}` : null)

  // Show thumbnail grid when in grid view (same as public share layout)
  if (viewState === 'grid') {
    return (
      <div className="fixed inset-0 bg-background flex flex-col overflow-hidden">
        {/* Grid view toolbar */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-background/95 backdrop-blur-sm z-20 flex-shrink-0">
          {/* Left: back to project */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(projectUrl)}
            title={t('backToProject')}
          >
            <ArrowLeft className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">{t('backToProject')}</span>
          </Button>

          {/* Right: theme toggle */}
          <ThemeToggle />
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="w-full px-3 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8">
            <ThumbnailGrid
              videosByName={project.videosByName}
              thumbnailsByName={thumbnailsByName}
              thumbnailsLoading={thumbnailsLoading}
              onVideoSelect={handleVideoSelect}
              projectTitle={project.title}
              projectDescription={project.description}
              clientName={clientDisplayName}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="h-screen overflow-hidden lg:fixed lg:inset-0 bg-background flex flex-col"
      style={{ height: '100dvh' }}
    >
      {/* Thumbnail Reel - always visible, collapsible.
          1.3.2+: admin only — the standalone ThemeToggle is replaced
          with a consolidated `PlayerTopMenu` (Share link / Delete this
          version / Copy / Paste comments / Switch theme). Public share
          page keeps the original ThemeToggle. */}
      <ThumbnailReel
        videosByName={project.videosByName}
        thumbnailsByName={thumbnailsByName}
        activeVideoName={activeVideoName}
        activeVideoId={activeVideoId}
        onVideoSelect={handleVideoSelect}
        onBackToGrid={handleBackToGrid}
        showBackButton={true}
        showLanguageToggle={false}
        showCommentToggle={!project.hideFeedback}
        isCommentPanelVisible={!hideComments}
        onToggleCommentPanel={() => setHideComments(!hideComments)}
        topRightMenu={
          <PlayerTopMenu
            projectId={project.id}
            projectSlug={project.slug}
            currentVideoId={activeVideo?.id || null}
            currentVersionLabel={activeVersionLabel}
            currentVideoName={activeVideoName || null}
            commentCount={commentsForActiveVideo.length}
            onVideoDeleted={() => {
              // Whole version is gone — bounce back to the project page so
              // the admin doesn't sit on a dead player. If they want to
              // see what's left in the project they're already there.
              router.push(`/admin/projects/${project.id}`)
            }}
          />
        }
      />
      {/* Main Content Area — fills viewport from lg+, side-by-side layout
          (player left, comments right) from lg+ so landscape devices like
          Nest Hub (1024×600) don't squeeze the player vertically. */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row p-2 sm:p-3 gap-2 sm:gap-3">
        {readyVideos.length === 0 ? (() => {
          // 1.9.4+ Phase A: themed "still processing" overlay.
          //
          // If the user clicked into a video whose first quality
          // tier hasn't landed yet, show a spinner + percentage
          // pulled straight from the worker's processingProgress.
          // The polling effect upstream keeps this number fresh
          // every ~3.5s; when the worker flips status=READY the
          // next poll sees a non-empty readyVideos and this branch
          // disappears, replaced by the actual player.
          //
          // We cap at 99% so the user never sees "100%" while
          // still PROCESSING — the visual jump from 99 → player
          // is the right "and now it's ready" payoff.
          const processingVideo = (activeVideosRaw || []).find(
            (v: any) => v?.status === 'PROCESSING' || v?.status === 'UPLOADING',
          )
          if (processingVideo) {
            const rawProgress = typeof processingVideo.processingProgress === 'number'
              ? processingVideo.processingProgress
              : 0
            const progress = Math.min(99, Math.max(0, Math.round(rawProgress)))
            const isUploading = processingVideo.status === 'UPLOADING'
            return (
              <div className="flex-1 flex items-center justify-center p-4">
                <Card className="bg-card border-border max-w-md w-full">
                  <CardContent className="py-10 px-8 flex flex-col items-center text-center gap-5">
                    <div className="relative">
                      <Loader2 className="w-12 h-12 text-primary animate-spin" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-lg font-semibold text-card-foreground">
                        {isUploading
                          ? (t('preparingVideo') || 'Preparing video…')
                          : (t('processingVideo') || 'Processing video…')}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('processingFirstTierHint')
                          || "We're generating the first playback quality. The player will open automatically once it's ready."}
                      </p>
                    </div>
                    {/* Progress bar — theme-aware, not a raw browser <progress>. */}
                    <div className="w-full">
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary transition-[width] duration-500 ease-out"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                        {progress}%
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )
          }
          return (
            <div className="flex-1 flex items-center justify-center p-4">
              <Card className="bg-card">
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">
                    {tokensLoading ? t('loadingVideo') : t('noVideosReadyForReview')}
                  </p>
                </CardContent>
              </Card>
            </div>
          )
        })() : (
          <>
            {/* Video Player — natural height on mobile, fills space
                from lg+ so the control bar never gets clipped.
                1.3.2+: `shrink-0` on phones so the player keeps its
                natural height inside a fixed-height page; the comment
                section below takes the remaining space and scrolls
                internally. */}
            <div className={`shrink-0 bg-background lg:shrink lg:h-full lg:min-h-0 lg:flex-1 min-w-0 flex flex-col ${showCommentPanel ? 'xl:flex-[2] 2xl:flex-[2.5]' : ''}`}>
              <VideoPlayer
                videos={readyVideos}
                projectId={project.id}
                projectStatus={project.status}
                defaultQuality={defaultQuality}
                projectTitle={project.title}
                projectDescription={project.description}
                clientName={project.clientName}
                isPasswordProtected={!!project.sharePassword}
                watermarkEnabled={project.watermarkEnabled}
                activeVideoName={activeVideoName}
                initialSeekTime={initialSeekTime}
                autoPlayOnInitialSeek={urlAutoplay}
                initialVideoIndex={initialVideoIndex}
                isAdmin={true}
                isGuest={false}
                allowAssetDownload={project.allowAssetDownload}
                shareToken={null}
                onApprove={undefined}
                hideDownloadButton={true}
                comments={!project.hideFeedback ? filteredComments : []}
                timestampDisplayMode={project.timestampDisplay || 'TIMECODE'}
                onCommentFocus={(commentId) => setFocusCommentId(commentId)}
                fillContainer={true}
                onVideoStateChange={(state) => {
                  // Surface the currently-playing video id so the title-bar
                  // version dropdown (ThumbnailReel) can highlight the row.
                  setActiveVideoId(state.selectedVideo?.id)
                }}
              />
            </div>

            {/* Comments Section - max one screen height on mobile, side panel on desktop */}
            {showCommentPanel && (
              <ResizableSidebar
                storageKey={`framecomment:sidebar-width:${project.id}`}
                defaultWidth={360}
                minWidth={280}
                maxFraction={0.55}
                className="flex-1 min-h-0 flex flex-col lg:max-h-full lg:h-full overflow-hidden rounded-xl bg-card"
              >
                <CommentSection
                  projectId={project.id}
                  projectSlug={project.slug}
                  comments={filteredComments}
                  focusCommentId={focusCommentId}
                  clientName={clientDisplayName}
                  clientEmail={project.recipients?.[0]?.email}
                  isApproved={project.status === 'APPROVED' || project.status === 'SHARE_ONLY'}
                  restrictToLatestVersion={project.restrictCommentsToLatestVersion}
                  videos={readyVideos}
                  isAdminView={true}
                  smtpConfigured={project.smtpConfigured}
                  isPasswordProtected={!!project.sharePassword}
                  adminUser={adminUser}
                  recipients={project.recipients || []}
                  shareToken={null}
                  // 1.0.9+: the admin always gets the attachment +
                  // voice-recorder buttons in their own comment box.
                  // This prop gated BOTH buttons and was never passed
                  // on the admin share page, so they silently never
                  // rendered. It's an admin capability, independent of
                  // the client-facing upload toggle.
                  allowClientAssetUpload={true}
                  timestampDisplayMode={project.timestampDisplay || 'TIMECODE'}
                  mobileCollapsible={true}
                  initialMobileCollapsed={false}
                  onToggleVisibility={() => setHideComments(!hideComments)}
                  showToggleButton={false}
                />
              </ResizableSidebar>
            )}
          </>
        )}
      </div>
    </div>
  )
}
