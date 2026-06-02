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

// 2.2.4+: module-scope persistent token cache + sessionId.
//
// The old per-mount `tokenCacheRef` cache was being thrown away
// every time the page unmounted (eg user hits Back to return to
// the dashboard, then re-enters the same project). On the next
// mount we'd re-mint every video token from scratch — 5–7 token
// requests per video × N videos in the project = ~5s of
// "Loading video..." on what should be a near-instant re-entry.
//
// Hoisting the cache to module scope and persisting `sessionId`
// in sessionStorage means a re-mount sees the SAME cache key for
// the same (videoId, status, tierFingerprint) tuple and hits
// cache for every video. Net effect: re-entering the same
// project after watching one video opens the player almost
// instantly.
//
// The cache is keyed by (sessionId, videoId, status, tierFingerprint),
// so it auto-invalidates when a new tier lands (tierFingerprint
// rotates) or the row's status flips — no stale tokens served.
//
// Module-scope state survives Next.js client-side navigations
// within the same browser tab (the JS bundle stays loaded). It
// resets on a hard reload — exactly when the backend's signed
// tokens may have rotated anyway.
const ADMIN_SHARE_TOKEN_CACHE = new Map<string, any>()

function getPersistentAdminSessionId(): string {
  if (typeof window === 'undefined') return `admin:${Date.now()}`
  const STORAGE_KEY = 'frameComment.adminShareSessionId'
  try {
    const existing = window.sessionStorage.getItem(STORAGE_KEY)
    if (existing) return existing
    const fresh = `admin:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    window.sessionStorage.setItem(STORAGE_KEY, fresh)
    return fresh
  } catch {
    // sessionStorage can throw in private browsing modes / strict
    // permissions. Falling back to a per-call ID is fine — the
    // module-scope cache will still hit within the same mount.
    return `admin:${Date.now()}`
  }
}

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
  // 2.2.0+: Cache the last successfully-tokenized activeVideos so we
  // can fall back to it when a refresh cycle produces a degraded
  // result (empty array, all bare videos without stream URLs, etc.).
  // Without this, the polling effect would flicker the player UI
  // between "Loading video…" / "No videos are ready for review yet."
  // / the actual player on every poll for clips whose source height
  // doesn't match an expected tier (so `hasPendingHigherTier` keeps
  // the poll alive forever). See the loop description in the 2.2.0
  // bug-fix notes for the exact symptom.
  const lastGoodActiveVideosRef = useRef<any[]>([])
  const [initialSeekTime, setInitialSeekTime] = useState<number | null>(null)
  const [initialVideoIndex, setInitialVideoIndex] = useState<number>(0)
  const [adminUser, setAdminUser] = useState<any>(null)
  const [hideComments, setHideComments] = useState(false)
  const [viewState, setViewState] = useState<'grid' | 'player'>('grid')
  const [thumbnailsByName, setThumbnailsByName] = useState<Map<string, string>>(new Map())
  const [thumbnailsLoading, setThumbnailsLoading] = useState(true)
  // 2.2.4+: the token cache + sessionId are now MODULE-SCOPE
  // (declared at the top of the file). This is what makes
  // re-entering the same project show the player almost
  // instantly: tokens minted on the first mount survive the
  // unmount/remount cycle as long as the browser tab is alive,
  // so the second open hits cache for every video and never
  // re-fetches. The localRef wrappers below keep the existing
  // closures untouched while pointing them at the persistent
  // store underneath.
  const tokenCacheRef = useRef<Map<string, any>>(ADMIN_SHARE_TOKEN_CACHE)
  const sessionIdRef = useRef<string>(getPersistentAdminSessionId())
  const inFlightTokenRequestsRef = useRef<Map<string, Promise<string>>>(new Map())
  // 2.2.3+: thumbnail tokens are per-session-stable — the file backing
  // a thumbnail never changes once uploaded, so the signed URL minted
  // for a given videoId is good for the entire mount. Pre-2.2.3 the
  // thumbnails effect (see further below) called
  // `fetchAdminVideoTokenWithRetry(videoId, 'thumbnail', ...)` for
  // EVERY video group in the project on every poll cycle, because the
  // effect's dependency was `project?.videosByName` and the project
  // refresher rebuilds that map by reference every 3.5s. The tokenize
  // effect's `tokenCacheRef` was never consulted on this path, so each
  // 3.5s tick fired N thumbnail token requests (N = number of video
  // groups). For a folder with 30 videos plus a single still-encoding
  // clip keeping the poll alive, that's ~510 token requests per minute
  // dedicated to thumbnails alone, which is what blew the per-IP rate
  // limit and surfaced as thousands of 429s in the network panel.
  // This Map caches the resolved thumbnail URL per videoId.
  const thumbnailUrlCacheRef = useRef<Map<string, string>>(new Map())
  // 2.2.3+: stable fingerprint of the last thumbnails sweep — `name ::
  // videoIdWithThumb` joined. The thumbnails effect short-circuits
  // when the fingerprint matches, so identical-content polls don't
  // re-call the (now cached) loop. Without this guard the effect still
  // walks every group, hits the cache, and calls `setThumbnailsByName`
  // with a fresh Map every 3.5s — fine for tokens but pointless React
  // work and a downstream re-render of ThumbnailReel / ThumbnailGrid.
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
          //
          // 2.2.4+: pre-2.2.4 this was 3 serial rounds — the 5
          // preview/HLS tokens parallel, THEN await the original
          // token, THEN (conditionally) await the thumbnail
          // token. Three round-trips per video × N videos was
          // the dominant chunk of the "5s Loading video…" the
          // user reported on first entry. Folding everything
          // into ONE Promise.all collapses it to a single round-
          // trip per video (~3× faster). The original + thumbnail
          // aren't on the playback-critical path so making them
          // race the tier tokens has no functional cost.
          const [token480, token720, token1080, token2160, tokenHls, originalToken, thumbToken, storyboardToken] = await Promise.all([
            fetchAdminVideoTokenWithRetry(video.id, '480p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, '720p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, '1080p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, '2160p', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, 'hls', sessionId),
            fetchAdminVideoTokenWithRetry(video.id, 'original', sessionId),
            video.thumbnailPath
              ? fetchAdminVideoTokenWithRetry(video.id, 'thumbnail', sessionId)
              : Promise.resolve(''),
            // 2.2.4+: storyboard sprite-sheet token. Needed by the
            // new version-reel hover-scrub (ThumbnailReel) so each
            // version thumbnail responds to mouse movement with the
            // same CSS-background-position scrubbing VideoCard
            // already does in the grid view. Empty string when the
            // worker never produced a storyboard (legacy rows,
            // images, very short clips).
            video.storyboardPath
              ? fetchAdminVideoTokenWithRetry(video.id, 'storyboard', sessionId)
              : Promise.resolve(''),
          ])

          let streamToken480p = token480
          let streamToken720p = token720
          let streamToken1080p = token1080
          let streamToken2160p = token2160
          let downloadToken: string | null = null

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

          const thumbnailUrl = thumbToken ? `/api/content/${thumbToken}` : null
          const storyboardUrl = storyboardToken ? `/api/content/${storyboardToken}` : null

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
            // 2.2.4+: per-version storyboard sprite, surfaces in
            // the new version reel hover-scrub.
            storyboardUrl,
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
    // 2.2.0+: keep polling while the HLS master playlist hasn't
    // caught up to the MP4 ladder. The worker writes
    // `preview<tier>Path` as soon as MP4 transcode finishes but
    // remuxes the HLS variant playlist a few seconds later, so the
    // user kept seeing "1080p · Finalizing…" until a manual page
    // refresh — even though the tier was already encoded. The
    // Quality-menu readySet uses `hlsQualities` as the source of
    // truth when HLS is active, so we keep polling until every MP4
    // tier has a matching HLS variant.
    const hasPendingHlsRemux = (activeVideosRaw || []).some((v: any) => {
      if (!v || !v.hlsUrl) return false
      const hlsSet = new Set<string>(
        Array.isArray(v.hlsQualities) ? v.hlsQualities : [],
      )
      if (v.preview480Path && !hlsSet.has('480p')) return true
      if (v.preview720Path && !hlsSet.has('720p')) return true
      if (v.preview1080Path && !hlsSet.has('1080p')) return true
      if (v.preview2160Path && !hlsSet.has('2160p')) return true
      return false
    })
    if (!hasProcessing && !hasPendingHigherTier && !hasPendingHlsRemux) return
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

  // 2.2.0+: Build a stable fingerprint of the "raw videos" list so we
  // can short-circuit `setActiveVideosRaw` when nothing meaningful has
  // changed across a poll. `transformProjectData` rebuilds the
  // videosByName arrays on every poll (new reference), which was
  // re-triggering the tokenize effect every 3.5 s and flickering the
  // player UI between "Loading video…" / the actual player / "No
  // videos are ready for review yet." for clips whose source short-
  // side doesn't fit a clean tier (so `hasPendingHigherTier` keeps
  // the poll alive indefinitely). Only re-tokenize when something
  // the tokenizer actually cares about has changed.
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
        // 2.2.0+: refuse to seed `activeVideosRaw` with an empty
        // array on the very first project load — the rest of the
        // pipeline assumes that once we have a videoNameToUse we
        // also have at least one raw video to tokenize.
        if (Array.isArray(videos) && videos.length > 0) {
          setActiveVideosRaw(videos)
        }

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
        // 2.2.0+: only push a fresh raw-videos array down to the
        // tokenize effect when something the tokenizer cares about
        // has actually changed. The polling effect upstream calls
        // `loadProject(true)` every ~3.5 s while a higher tier is
        // pending, and `transformProjectData` rebuilds the arrays
        // each time — so without this guard the tokenize effect
        // would re-fire on every poll and bounce `tokensLoading`
        // up + down, which is what surfaced as the visible flicker
        // between the player and the "No videos are ready" card.
        // Also: never overwrite a populated list with an empty /
        // missing one — a transient poll that drops the active
        // video group must not flush the player to empty.
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
  }, [project, activeVideoName, urlVideoName, urlVersion, urlTimestamp, fingerprintRawVideos])

  // 2.2.0+: A tokenized video is "useful" when at least one playable
  // surface is available (any tier stream URL, an HLS master, a
  // download URL, or a thumbnail). The catch branch in
  // `fetchTokensForVideos` returns the raw `video` object without any
  // of these, which would slip past the simple
  // `activeVideos.filter(v => v.status === 'READY')` check downstream
  // and render the player with `videoUrl === ''` — the source of the
  // "Loading video…" flash inside the actual player frame. We use
  // this helper to decide whether a fresh tokenization is good enough
  // to publish into `activeVideos`, or whether we should keep the
  // last-known-good list around so the player stays mounted on real
  // stream URLs while a transient token-fetch failure rotates through.
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
      if (!isMounted) return
      // 2.2.0+: defend against degraded poll cycles.
      //
      // The poll → `loadProject(true)` → `setProject` → effect-461
      // → `setActiveVideosRaw` → this effect chain re-runs every
      // ~3.5 s while `hasPendingHigherTier` is true. If a single
      // refresh produces an "empty" or "all-bare" tokenized array
      // (transient 401 + refresh, brief network blip, the
      // `fetchTokensForVideos` catch branch returning the raw video
      // object without any signed URLs, etc.), we MUST NOT clobber
      // the previously-good `activeVideos` — that's exactly what
      // makes the player UI bounce between the actual VideoPlayer
      // and the "No videos are ready for review yet." card.
      //
      // Policy:
      //  * empty tokenized array → keep the previous activeVideos
      //  * tokenized array where every clip lacks stream URLs but
      //    we already have a good cached list → keep the previous
      //  * otherwise → publish the new array, and snapshot it as
      //    the next "last known good" baseline.
      const tokenizedAny = Array.isArray(tokenized) ? tokenized : []
      const anyUsable = tokenizedAny.some(isTokenizedVideoUsable)
      const lastGood = lastGoodActiveVideosRef.current
      const haveLastGood = Array.isArray(lastGood) && lastGood.length > 0
      if (tokenizedAny.length === 0 && haveLastGood) {
        // Don't surface an empty list; keep the player mounted.
      } else if (!anyUsable && haveLastGood) {
        // Every entry came back without a playable surface — keep
        // serving the cached good list rather than flashing the
        // empty-state card.
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
  }, [activeVideosRaw, fetchTokensForVideos, isTokenizedVideoUsable])

  // Fetch thumbnails for all video groups.
  //
  // 2.2.3+: ROOT-CAUSE FIX for the "6000+ 429s on /api/admin/video-token"
  // bug reported against 2.2.2.
  //
  // The progressive transcoding poll above re-runs `loadProject(true)`
  // every 3.5s while any active video is still in PROCESSING / has a
  // pending higher MP4 tier / is waiting on an HLS remux.
  // `transformProjectData` then returns a brand-new `videosByName` map
  // by reference on every poll, which retriggers this effect (its dep
  // is `project?.videosByName`). Pre-fix the effect walked every video
  // group and called `fetchAdminVideoTokenWithRetry(..., 'thumbnail')`
  // for each — bypassing `tokenCacheRef` entirely (that cache lives in
  // `fetchTokensForVideos` and only covers the active video group).
  //
  // Two layers of defence applied below:
  //   1. `lastThumbnailFingerprintRef` short-circuits the effect when
  //      the (name → videoIdWithThumb) mapping hasn't changed across a
  //      poll. This handles the common case: same set of videos, same
  //      thumbnail-bearing version picked. The effect becomes a true
  //      no-op rather than a "walk N cached entries and re-render".
  //   2. `thumbnailUrlCacheRef` (videoId → /api/content/<token> URL).
  //      Thumbnails are stable for the lifetime of the session — the
  //      backing file never changes — so once we have a URL for a
  //      videoId we never re-fetch it. This handles the edge case
  //      where the fingerprint DID change (new video added, different
  //      version surfaced as the thumbnail carrier, etc.) — only the
  //      newly-needed videoIds hit the wire; everything else replays
  //      from the cache.
  useEffect(() => {
    let isMounted = true
    const sessionId = sessionIdRef.current

    async function fetchThumbnails() {
      if (!project?.videosByName || !id) {
        return
      }

      // 2.2.3+: fingerprint the (name → videoIdWithThumb) mapping —
      // that's the ONLY shape this effect actually depends on. If it
      // matches the prior sweep we skip both the token fetches AND the
      // `setThumbnailsByName` call, so identical-content polls cost
      // literally zero requests and zero downstream re-renders.
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
        // Don't skip on the very first call (empty initial ref vs empty
        // project) — we still need to flush `thumbnailsLoading` to false.
        lastThumbnailFingerprintRef.current !== ''
      ) {
        return
      }

      setThumbnailsLoading(true)
      const newThumbnails = new Map<string, string>()

      try {
        await Promise.all(
          Array.from(nameToVideoWithThumb.entries()).map(async ([name, videoWithThumb]) => {
            // 2.2.3+: serve from cache when we've already minted a
            // thumbnail URL for this videoId during this session.
            const cachedUrl = thumbnailUrlCacheRef.current.get(videoWithThumb.id)
            if (cachedUrl) {
              if (isMounted) {
                newThumbnails.set(name, cachedUrl)
              }
              return
            }
            const thumbToken = await fetchAdminVideoTokenWithRetry(videoWithThumb.id, 'thumbnail', sessionId)
            if (thumbToken && isMounted) {
              const url = `/api/content/${thumbToken}`
              thumbnailUrlCacheRef.current.set(videoWithThumb.id, url)
              newThumbnails.set(name, url)
            }
          })
        )

        if (isMounted) {
          setThumbnailsByName(newThumbnails)
          lastThumbnailFingerprintRef.current = fingerprint
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
    // 2.2.0+: switching to a different video group means the
    // last-known-good `activeVideos` snapshot is for the OLD group
    // and must not be replayed onto the new one (otherwise the
    // tokenize-effect's "keep previous on degraded result" guard
    // would briefly show the wrong clip in the player). Reset so
    // the next successful tokenization seeds a fresh baseline.
    lastGoodActiveVideosRef.current = []

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
        // 2.2.4+: tokenized active group — gives ThumbnailReel
        // per-version thumbnailUrl + storyboardUrl for the new
        // version reel (thumbnails + hover-scrub).
        activeVersionsTokenized={activeVideos}
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
