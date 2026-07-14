'use client'

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Video, ProjectStatus, Comment } from '@prisma/client'
import { Button } from './ui/button'
import { CheckCircle2, GitCompareArrows } from 'lucide-react'
import CustomVideoControls from './CustomVideoControls'
import VideoComparison from './VideoComparison'
import ProjectInfo from './ProjectInfo'
import AnnotationOverlay from './AnnotationOverlay'
import AnnotationCanvas from './AnnotationCanvas'
import SafeZoneOverlay, { type SafeZonePreset } from './SafeZoneOverlay'
import RulersOverlay from './RulersOverlay'
import type { QualityChoice } from './PlayerSettingsMenu'
import { useAnnotation } from '@/contexts/AnnotationContext'
import { secondsToTimecode } from '@/lib/timecode'
import { logError } from '@/lib/logging'
import {
  isRangeEditActive,
  setRangeEditActive,
} from '@/lib/comment-range-edit'
import { apiJson, apiPost, apiPatch, apiDelete } from '@/lib/api-client'
import { getClientId } from '@/lib/client-id'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

// 4.1.0+: Premiere-style timeline marker (a coloured flag at a
// millisecond position). Distinct from comment pins.
export type MarkerFlag = {
  id: string
  videoId: string
  videoVersion: number | null
  timestampMs: number
  color: string // red | orange | green | blue
  label: string | null
  authorName: string | null
  isInternal: boolean
  createdAt: string
  mine: boolean
}

interface VideoPlayerProps {
  videos: Video[]
  projectId: string
  projectStatus: ProjectStatus
  defaultQuality?: '480p' | '720p' | '1080p' | '2160p' // Default quality from settings
  onApprove?: () => void // Optional approval callback
  authenticatedEmail?: string | null // Email of OTP-authenticated user
  authenticatedName?: string | null // Name of OTP-authenticated user
  projectTitle?: string
  projectDescription?: string
  clientName?: string
  isPasswordProtected?: boolean
  watermarkEnabled?: boolean
  isAdmin?: boolean // Admin users can see all versions (default: false for clients)
  isGuest?: boolean // Guest mode - limited view (videos only, no downloads)
  activeVideoName?: string // The video group name (for maintaining selection after reload)
  initialSeekTime?: number | null // Initial timestamp to seek to (from URL params)
  // 1.9.4+ Phase B: when set together with initialSeekTime,
  // the player auto-plays after seeking to that timestamp. Used
  // by the "new tier arrived" auto-refresh path so the reload
  // resumes playback exactly where the user was watching.
  autoPlayOnInitialSeek?: boolean
  initialVideoIndex?: number // Initial video index to select (from URL params)
  allowAssetDownload?: boolean // Allow clients to download assets
  clientCanApprove?: boolean // Allow clients to approve videos (false = admin only)
  shareToken?: string | null
  hideDownloadButton?: boolean // Hide download button completely (for admin share view)
  comments?: CommentWithReplies[] // Comments for timeline markers
  timestampDisplayMode?: 'TIMECODE' | 'AUTO' // Timestamp display format (default: TIMECODE)
  onCommentFocus?: (commentId: string) => void // Callback when a timeline marker is clicked
  onVideoStateChange?: (state: {
    selectedVideo: any
    selectedVideoIndex: number
    isVideoApproved: boolean
    displayVideos: any[]
    displayLabel: string
  }) => void // Callback to expose video state for mobile layout
  usePreviewForApprovedPlayback?: boolean // Use preview for approved playback instead of original
  fillContainer?: boolean // Fill parent container height (for full-viewport layouts)
}

/**
 * 2.2.4+ pure helper — picks the index in `levels` we should start
 * playback on for a fresh HLS attach (or an in-place reload that
 * didn't specify an explicit pinned height).
 *
 * Decision order:
 *   1. If the user has explicitly chosen a quality this session
 *      (`qualityChoice !== 'auto'`), honour that.
 *   2. Else, if the project's `previewResolution` (= `defaultQuality`)
 *      is a concrete tier ('720p' etc), use it as a CAP.
 *   3. Otherwise (both are 'auto'), pick the highest available —
 *      same behaviour as a fresh page load before 2.2.4.
 *
 * Within levels we use the SAME `height >= targetH * 0.9` rule the
 * worker uses for tier planning (90% tolerance for cinematic crops
 * like 1920×1008). `findIndex` returns the FIRST level that clears
 * the threshold; since hls.js lists levels in ascending height, that
 * gives us the cheapest-bitrate variant that still satisfies the
 * requested tier.
 *
 * Returns the highest available level as a safe fallback when no
 * variant clears the threshold.
 */
/**
 * 3.8.x: the AUTO cap is DEVICE-AWARE.
 *  - small screens (phones) → HD (720p): >720p is invisible on a phone
 *    and just wastes bandwidth,
 *  - larger screens (tablets / desktops) → HD+ (1080p).
 * 4K (2160p) is always opt-in on every device, and the user can still
 * pick ANY tier manually from the quality menu. This is a resolution-
 * only, auth-agnostic decision computed from the viewport, so it
 * applies identically on public share links (guests included).
 *
 * "Small" keys off the SHORTER viewport dimension so it's robust to
 * orientation — a phone in landscape (e.g. 932×430) still reads as
 * small because its short side (430) is < the threshold, while a
 * desktop or tablet stays large.
 */
const SMALL_DEVICE_MAX = 768
function isSmallDevice(): boolean {
  if (typeof window === 'undefined') return false
  return Math.min(window.innerWidth, window.innerHeight) < SMALL_DEVICE_MAX
}
function autoCapHeight(): number {
  return isSmallDevice() ? 720 : 1080
}

/**
 * AUTO caps playback at the device-appropriate height (see
 * `autoCapHeight`). Returns the index of the highest level whose height
 * is ≤ the cap; higher tiers are opt-in. If the clip somehow only has
 * higher variants, fall back to the lowest available.
 */
function pickAutoCappedLevelIdx(
  levels: Array<{ height?: number }>,
  capH: number = autoCapHeight(),
): number {
  if (!levels || levels.length === 0) return 0
  const CAP_H = capH * 1.1 // tolerance for cinematic crops (~1088 / ~792)
  let capIdx = -1
  for (let i = 0; i < levels.length; i++) {
    if ((levels[i]?.height || 0) <= CAP_H) capIdx = i // ascending → last ≤cap = highest ≤cap
  }
  return capIdx >= 0 ? capIdx : 0
}

function pickInitialHlsLevelIdx(
  levels: Array<{ height?: number }>,
  defaultQuality: string,
  qualityChoice: string,
): number {
  if (!levels || levels.length === 0) return 0

  const target =
    qualityChoice && qualityChoice !== 'auto'
      ? qualityChoice
      : defaultQuality && defaultQuality !== 'auto'
        ? defaultQuality
        : null

  // Both auto → device-aware cap (720p on phones, 1080p on larger
  // screens); never auto-start at 4K.
  if (!target) return pickAutoCappedLevelIdx(levels)

  const targetH =
    target === '2160p' ? 2160 :
    target === '1080p' ? 1080 :
    target === '720p'  ? 720  :
    480

  const idx = levels.findIndex(l => (l?.height || 0) >= targetH * 0.9)
  return idx >= 0 ? idx : levels.length - 1
}

export default function VideoPlayer({
  videos,
  projectId,
  projectStatus: _projectStatus,
  defaultQuality = '720p',
  onApprove,
  projectTitle,
  projectDescription,
  clientName,
  isPasswordProtected,
  watermarkEnabled = true,
  isAdmin = false, // Default to false (client view)
  isGuest = false, // Default to false (full client view)
  activeVideoName,
  initialSeekTime = null,
  autoPlayOnInitialSeek = false,
  initialVideoIndex = 0,
  allowAssetDownload = true,
  clientCanApprove = true, // Default to true (clients can approve)
  shareToken = null,
  hideDownloadButton = false, // Default to false (show download button)
  comments = [], // Default to empty array
  timestampDisplayMode = 'TIMECODE', // Default to TIMECODE format
  onCommentFocus, // Callback when timeline marker is clicked
  onVideoStateChange, // Callback to expose video state for mobile layout
  usePreviewForApprovedPlayback = false, // Default to false (use original)
  fillContainer = false, // Default to false (standard aspect ratio)
  authenticatedEmail = null,
  authenticatedName = null,
}: VideoPlayerProps) {
  const t = useTranslations('videos')
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(initialVideoIndex)
  const [videoUrl, setVideoUrl] = useState<string>('')
  const [resolvedPlaybackQuality, setResolvedPlaybackQuality] = useState<'480p' | '720p' | '1080p' | '2160p'>(defaultQuality)
  // 1.9.4+ Phase B (Frame.io behaviour): User-chosen quality
  // preference. ALWAYS defaults to 'auto' on mount and never
  // hydrates from localStorage. This implements the user's
  // explicit requirement: "tot timpul iti da cea mai mare
  // calitate daca e deja procesata" — every fresh load of the
  // page (or every time the user re-enters a video) starts at
  // the highest available tier, not at whatever they last
  // selected in a previous session. The menu still works for
  // mid-session changes; those just don't persist past reload.
  const [qualityChoice, setQualityChoice] = useState<QualityChoice>('auto')
  // Safe-zone preset + rulers toggle. Session-only (no localStorage) —
  // these are spot-check tools, not preferences you want sticky.
  const [guidesPreset, setGuidesPreset] = useState<SafeZonePreset>('off')
  const [rulersEnabled, setRulersEnabled] = useState<boolean>(false)
  // 1.9.4+ Phase B: hlsUrl is computed further down (after
  // selectedVideo derivation), but `handleQualityChoiceChange`
  // needs it inside the manual destroy+recreate path. The ref
  // sidesteps the temporal dead zone — a small useEffect later
  // keeps it in sync with the current selectedVideo.hlsUrl.
  const hlsUrlRef = useRef<string | null>(null)

  // 1.9.4+ Phase B (transport stability): tracks WHICH videoId
  // we've already committed a videoUrl for. Once set, the
  // loadVideoUrl effect skips re-setting URL for the same clip,
  // even if the parent's hlsUrl/streamUrl* fields change. This
  // is what prevents the MP4 → HLS mid-session swap that used
  // to reset playback to frame 0 the moment a new tier landed.
  const committedVideoIdRef = useRef<string | null>(null)


  // 1.9.4+ Phase B hls.js instance ref. Surfaced so the quality
  // menu can call `hlsRef.current.currentLevel = N` to switch
  // tier without seeking back — seamless mid-playback upgrade.
  const hlsRef = useRef<any>(null)

  // 1.9.4+ Phase B: when the player needs to swap to a tier
  // that wasn't present in the master we originally loaded
  // (i.e. a higher tier finished encoding mid-watch), we tear
  // down the hls.js instance and rebuild it against a freshly
  // fetched master. The new MANIFEST_PARSED handler honours
  // `pendingPinnedHeightRef` so the new instance lands on the
  // exact tier the caller requested. If nothing's pinned, the
  // handler falls back to `pickInitialHlsLevelIdx` (project cap
  // + user preference) instead of always-highest.
  const pendingPinnedHeightRef = useRef<number | null>(null)

  // 2.2.4+: refs mirroring `defaultQuality` (project setting) and
  // `qualityChoice` (user runtime pick) so the `reloadHlsInPlace`
  // callback — which lives inside a `useCallback([])` and therefore
  // can't close over the live state — still reads fresh values when
  // it runs. Without these, a tier-landed silent reload would always
  // pick the highest level (the stale "no info" fallback) instead of
  // honouring the project's previewResolution cap.
  const defaultQualityRef = useRef<string>('720p')
  const qualityChoiceRef = useRef<string>('auto')

  const reloadHlsInPlace = useCallback((targetHeight?: number) => {
    const video = videoRef.current
    const hls = hlsRef.current
    const url = hlsUrlRef.current
    if (!video || !url) return

    // Snapshot exactly enough state to feel seamless on the other
    // side of the rebuild. We don't try to preserve the buffer —
    // hls.js will refill from the new variant starting at the
    // restored currentTime, which on a local network shows up as
    // a sub-second stall, visually identical to the initial-load
    // ABR ramp the user already considers "wonderful".
    const preservedTime = video.currentTime
    const wasPlaying = !video.paused
    pendingPinnedHeightRef.current = typeof targetHeight === 'number' ? targetHeight : null

    if (hls) {
      try {
        const onResize = (hls as any)._onResize
        if (onResize) {
          video.removeEventListener('resize', onResize)
          video.removeEventListener('loadedmetadata', onResize)
        }
        hls.destroy()
      } catch {
        // ignore — even partially destroyed is fine, we replace below
      }
      hlsRef.current = null
    }

    ;(async () => {
      try {
        const HlsModule = await import('hls.js')
        const Hls = HlsModule.default
        if (!Hls.isSupported()) return

        const newHls = new Hls({
          manifestLoadingMaxRetry: Infinity,
          manifestLoadingRetryDelay: 1000,
          levelLoadingMaxRetry: Infinity,
          maxBufferLength: 30,
          backBufferLength: 30,
          // CRITICAL: don't fetch the first fragment automatically.
          // hls.js's default ABR picks the LOWEST level for the
          // initial fragment to stay safe under unknown bandwidth.
          // For our admin-review use case we'd much rather pin to
          // the requested tier first, then trigger loading. With
          // autoStartLoad:false the master is parsed and `levels`
          // populated, but no segment request goes out until we
          // call `startLoad(t)` below — at which point the level
          // is already pinned.
          autoStartLoad: false,
        })
        hlsRef.current = newHls
        newHls.attachMedia(video)

        // Append a cache buster so the server's `master.m3u8`
        // is re-fetched (even though it sets Cache-Control:
        // no-store, intermediaries / hls.js memoisation might
        // serve stale otherwise). The token in the URL is the
        // freshest one because hlsUrlRef.current is kept in
        // sync with parent token rotations.
        const sep = url.includes('?') ? '&' : '?'
        newHls.loadSource(`${url}${sep}_=${Date.now()}`)

        newHls.once(Hls.Events.MANIFEST_PARSED, () => {
          if (!newHls.levels || newHls.levels.length === 0) return
          const pinned = pendingPinnedHeightRef.current
          let chosen: number
          if (typeof pinned === 'number') {
            // 2.2.6+: strict ±15% height match (and NAME match
            // when hls.js exposes it). Same fix as the cheap path
            // in `handleQualityChoiceChange` — see the comment
            // there for the bug we're sidestepping (old `>= * 0.9`
            // happily picked a HIGHER tier when the requested one
            // wasn't in the freshly-fetched master either).
            const pinnedName =
              pinned >= 2160 * 0.85 ? '2160p' :
              pinned >= 1080 * 0.85 ? '1080p' :
              pinned >= 720 * 0.85 ? '720p' :
              '480p'
            const byName = newHls.levels.findIndex((l: any) => {
              const name = l?.name || l?.attrs?.NAME
              return name === pinnedName
            })
            const byHeight = byName >= 0 ? byName : newHls.levels.findIndex(
              (l: any) => {
                const h = l?.height || 0
                return h >= pinned * 0.85 && h <= pinned * 1.15
              },
            )
            chosen = byHeight >= 0 ? byHeight : newHls.levels.length - 1
          } else {
            // 2.2.4+: honour the project's previewResolution cap +
            // the user's runtime pick when no explicit pin was set
            // (e.g. silent reload after a new tier landed). Reads
            // refs because this callback lives in a useCallback([]).
            chosen = pickInitialHlsLevelIdx(
              newHls.levels as any,
              defaultQualityRef.current,
              qualityChoiceRef.current,
            )
          }
          newHls.nextLevel = chosen
          newHls.currentLevel = chosen
          pendingPinnedHeightRef.current = null

          // 4.0.x: reflect the pinned quality in the badge IMMEDIATELY,
          // at manifest-parse time (fast — just the master playlist),
          // instead of waiting for the first LEVEL_SWITCHED which only
          // fires AFTER the first HD/HD+ fragment has buffered (~seconds).
          // That wait is what made the badge sit on "SD" for a few
          // seconds before flipping to "HD+"; the stream was already
          // pinned to HD+ the whole time.
          const chosenH = (newHls.levels?.[chosen] as any)?.height || 0
          setResolvedPlaybackQuality(
            chosenH >= 2160 * 0.9
              ? '2160p'
              : chosenH >= 1080 * 0.9
                ? '1080p'
                : chosenH >= 720 * 0.9
                  ? '720p'
                  : '480p',
          )

          // NOW trigger fragment loading at the preserved time.
          // hls.js will request the variant playlist for the
          // pinned level (chosen), then the fragment containing
          // `preservedTime` — exactly what we want.
          const startAt = Number.isFinite(preservedTime) && preservedTime > 0
            ? preservedTime
            : -1
          newHls.startLoad(startAt)
        })

        // Mirror the badge logic from the main attach effect.
        newHls.on(Hls.Events.LEVEL_SWITCHED, (_: any, data: any) => {
          const lvl = newHls.levels?.[data?.level]
          if (!lvl) return
          const h = lvl.height || 0
          if (h >= 2160 * 0.9) setResolvedPlaybackQuality('2160p')
          else if (h >= 1080 * 0.9) setResolvedPlaybackQuality('1080p')
          else if (h >= 720 * 0.9) setResolvedPlaybackQuality('720p')
          else setResolvedPlaybackQuality('480p')
        })

        // Once the first fragment is fully buffered, resume
        // playback if the user was playing before the rebuild.
        // FRAG_BUFFERED fires AFTER the bytes are in MediaSource,
        // which is the earliest play() reliably succeeds without
        // a "no media data" stall.
        newHls.once(Hls.Events.FRAG_BUFFERED, () => {
          if (wasPlaying) {
            video.play().catch(() => {})
          }
        })
      } catch {
        // hls.js failed to load — silently degrade. The video
        // element is still attached to the previous MediaSource
        // (or empty); the parent page is unaffected.
      }
    })()
  }, [])

  const handleQualityChoiceChange = useCallback((q: QualityChoice) => {
    setQualityChoice(q)
    // 1.9.4+ Phase B (Frame.io behaviour): in-session preference
    // only — localStorage is intentionally not touched, so a
    // future reload still picks the highest available tier
    // automatically (the user explicitly asked for this).
    const video = videoRef.current
    const hls = hlsRef.current
    if (!video) return

    // 2.2.6+: predictive badge update.
    //
    // Both the cheap (hls.currentLevel = idx) and the expensive
    // (reloadHlsInPlace) paths can take a moment to settle —
    // the cheap path waits for LEVEL_SWITCHED to fire, the
    // expensive one for a brand-new MANIFEST_PARSED. In the
    // worst case the badge sits on the previous tier for the
    // half-second the buffer needs to flush, and the user's
    // click looks like a no-op. Flipping the badge state right
    // now reflects intent immediately; if the level switch
    // somehow fails the resize listener will still correct it
    // once the video element decodes the new variant.
    if (q !== 'auto') {
      setResolvedPlaybackQuality(q)
    }

    if (q === 'auto') {
      // 3.8.x: Auto caps at the device-appropriate height (720p on
      // phones, 1080p on larger screens) — pin to the highest level
      // ≤ cap, NOT the absolute highest. 4K stays opt-in. Cheap path,
      // instant; no reload, no destroy.
      if (hls && hls.levels && hls.levels.length > 0) {
        const idx = pickAutoCappedLevelIdx(hls.levels)
        hls.nextLevel = idx
        hls.currentLevel = idx
      }
      return
    }

    const targetH =
      q === '2160p' ? 2160 :
      q === '1080p' ? 1080 :
      q === '720p' ? 720 :
      480

    if (hls && hls.levels && hls.levels.length > 0) {
      // 2.2.6+ BUG FIX: pick the level whose tier MATCHES the
      // request exactly, not "first level whose height clears a
      // lowball threshold".
      //
      // Before: `findIndex(l => l.height >= targetH * 0.9)` on
      // an ASCENDING-by-bitrate array would happily match a HIGHER
      // tier when the requested one wasn't in the master. Concrete
      // reproductions:
      //   - hls.js attached with [1080p, 2160p]. User clicks 720p
      //     → old code: `1080 >= 648` ✓ → idx=0 → stays on 1080p,
      //     badge HD+ even though menu shows 720p ticked.
      //   - hls.js attached with [720p, 1080p, 2160p]. User clicks
      //     480p → old code: `720 >= 432` ✓ → idx=0 → stays on
      //     720p, badge HD even though menu shows 480p ticked.
      //
      // Matching strategy:
      //   1. NAME match — our master.m3u8 emits `NAME="480p"` etc,
      //      so a level's `attrs.NAME` (or `.name`) is authoritative.
      //   2. Strict height ±15% — falls back when hls.js builds
      //      without exposing the NAME attr at all. ±15% lets
      //      cinematic variants (e.g. 1920x1008 for 1080p) match
      //      while still rejecting cross-tier hits.
      //   3. -1 (no match) — caller drops to `reloadHlsInPlace`,
      //      which fetches a fresh master.m3u8 (the worker may
      //      have published the requested tier after we attached).
      const findLevelIdx = () => {
        // Pass 1: exact tier-name match.
        const byName = hls.levels.findIndex((l: any) => {
          const name = l?.name || l?.attrs?.NAME
          return name === q
        })
        if (byName >= 0) return byName
        // Pass 2: tight height window (±15%).
        return hls.levels.findIndex((l: any) => {
          const h = l?.height || 0
          return h >= targetH * 0.85 && h <= targetH * 1.15
        })
      }
      const idx = findLevelIdx()
      if (idx >= 0) {
        // Cheap path — tier already in hls.js's variant list.
        // Set all three knobs hls.js exposes so the switch is
        // unambiguous regardless of which internal state machine
        // the build version reads:
        //   - nextLevel: applied at next fragment boundary
        //   - loadLevel: which playlist to fetch next
        //   - currentLevel: hard switch, flushes buffer, disables ABR
        hls.nextLevel = idx
        hls.loadLevel = idx
        hls.currentLevel = idx

        // 2.3.0+ WATCHDOG: in some browsers / hls.js builds the
        // cheap path doesn't actually flush the buffer — the user
        // sees the menu update but playback continues on the old
        // variant. Without a fallback they'd think the switch
        // failed (this was the share-page regression report:
        // "menu shows SD but video stays HD").
        //
        // Strategy: snapshot the current level + buffered ranges,
        // give hls.js 1.5 s to actually do the switch (the buffer
        // flush + first new-variant fragment takes 300-800 ms in
        // the happy path), and if `hls.currentLevel` hasn't moved
        // to `idx` AND no LEVEL_SWITCHED has fired, escalate to
        // the expensive reload-in-place. The reload destroys the
        // current instance and fetches a fresh master pinned to
        // the requested tier — guaranteed visible switch.
        let levelSwitchSeen = false
        const onLevelSwitched = (_evt: any, data: any) => {
          if (data?.level === idx) {
            levelSwitchSeen = true
          }
        }
        try {
          hls.on('hlsLevelSwitched', onLevelSwitched)
        } catch {
          // If the event name isn't recognised by this build,
          // the watchdog still works via the currentLevel check.
        }
        setTimeout(() => {
          try {
            hls.off('hlsLevelSwitched', onLevelSwitched)
          } catch {
            // ignore
          }
          const stillNotSwitched =
            !levelSwitchSeen && hls.currentLevel !== idx
          if (stillNotSwitched && hlsRef.current === hls) {
            // Cheap path didn't take. Escalate.
            reloadHlsInPlace(targetH)
          }
        }, 1500)
        return
      }
    }

    // Expensive path — tier was added on the server AFTER the
    // master we loaded. Do a VIEWPORT-ONLY reload of hls.js:
    // destroy current instance, fetch a fresh master (with the
    // new variant listed), pin to the requested height. The
    // page (comments, timeline, header) stays exactly as it is.
    // Visually identical to the seamless ABR ramp-up the user
    // sees on a fresh page load.
    reloadHlsInPlace(targetH)
  }, [reloadHlsInPlace])
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [currentTimeState, setCurrentTimeState] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoWrapperRef = useRef<HTMLDivElement>(null)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasInitiallySeenRef = useRef(false) // Track if initial seek already happened
  const lastTimeUpdateRef = useRef(0) // Throttle time updates
  const previousVideoNameRef = useRef<string | null>(null)
  const currentTimeRef = useRef(0)
  const selectedVideoIdRef = useRef<string | null>(null)
  // 1.9.0+: refs that mirror the range-edit module state and the
  // pending comment IN/OUT range. The arrow-key handler reads them
  // synchronously to decide between stepping the playhead (normal
  // mode) and moving the yellow OUT handle frame-by-frame (range-
  // edit mode).
  const rangeEditingRef = useRef(false)
  const pendingInTimeRef = useRef<number | null>(null)
  const pendingOutTimeRef = useRef<number | null>(null)

  // If ANY video is approved, only show approved videos (for both admin and client)
  // Memoize to prevent infinite loops with onVideoStateChange callback
  const displayVideos = useMemo(() => {
    const hasAnyApprovedVideo = videos.some((v: any) => v.approved === true)
    return hasAnyApprovedVideo
      ? videos.filter((v: any) => v.approved === true)
      : videos
  }, [videos])

  // Safety check: ensure index is valid
  const safeIndex = Math.min(selectedVideoIndex, displayVideos.length - 1)
  const selectedVideo = displayVideos[safeIndex >= 0 ? safeIndex : 0]

  // 3.9.x: comments are per-VERSION. `comments` arrives scoped to the
  // whole active version group (v1…vN), but a comment — and its saved
  // annotation — belongs to ONE specific version's videoId. Without this
  // filter, an annotation drawn on v2 (e.g. a red box at 00:22) kept
  // rendering on v3 at the same timecode even though v3 has no comments,
  // and v2's timeline marker showed on v3's scrubber too. We narrow to
  // the currently-playing version so annotations + markers match the
  // per-version comment sidebar. Comments with no videoId (rare, project-
  // level) stay visible on every version.
  const activeVersionComments = useMemo(
    () =>
      (comments as any[]).filter(
        (c: any) => !c?.videoId || c.videoId === selectedVideo?.id,
      ),
    [comments, selectedVideo?.id],
  )

  // 4.1.0+: Premiere-style timeline markers (coloured flags). Fetched
  // right here so BOTH the admin review player and the client/share view
  // get them without threading a `markers` prop through every parent.
  // The comment toolbar (a separate component tree) asks us to drop a
  // marker via the `framecomment:addMarker` window event; we own the
  // create/delete + list so all the API auth branching lives in one place.
  const [markers, setMarkers] = useState<MarkerFlag[]>([])

  const buildShareMarkerQuery = useCallback(() => {
    if (typeof window === 'undefined') return ''
    const sp = new URLSearchParams(window.location.search)
    const v = (sp.get('v') || '').trim()
    const sig = (sp.get('sig') || '').trim()
    return v && sig ? `?v=${encodeURIComponent(v)}&sig=${encodeURIComponent(sig)}` : ''
  }, [])

  const fetchMarkers = useCallback(async () => {
    if (!projectId) return
    try {
      let data: any
      if (shareToken) {
        const res = await fetch(`/api/share/${shareToken}/markers${buildShareMarkerQuery()}`, {
          headers: {
            Authorization: `Bearer ${shareToken}`,
            'X-Framecomment-Client-Id': getClientId(),
          },
        })
        if (!res.ok) return
        data = await res.json()
      } else {
        data = await apiJson(`/api/markers?projectId=${encodeURIComponent(projectId)}`)
      }
      setMarkers(Array.isArray(data) ? data : [])
    } catch {
      /* non-fatal — markers are optional chrome */
    }
  }, [projectId, shareToken, buildShareMarkerQuery])

  const createMarker = useCallback(
    async (color: string, label: string | null) => {
      const videoId = selectedVideoIdRef.current
      if (!projectId || !videoId) return
      const timestampMs = Math.max(0, Math.round((currentTimeRef.current || 0) * 1000))
      const body: any = { projectId, videoId, timestampMs, color }
      if (label) body.label = label
      try {
        if (shareToken) {
          await fetch('/api/markers', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${shareToken}`,
              'X-Framecomment-Client-Id': getClientId(),
            },
            body: JSON.stringify(body),
          })
        } else {
          await apiPost('/api/markers', body)
        }
        await fetchMarkers()
      } catch (err) {
        logError('Failed to create marker:', err)
      }
    },
    [projectId, shareToken, fetchMarkers],
  )

  const deleteMarker = useCallback(
    async (id: string) => {
      try {
        if (shareToken) {
          await fetch(`/api/markers/${id}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${shareToken}`,
              'X-Framecomment-Client-Id': getClientId(),
            },
          })
        } else {
          await apiDelete(`/api/markers/${id}`)
        }
        await fetchMarkers()
      } catch (err) {
        logError('Failed to delete marker:', err)
      }
    },
    [shareToken, fetchMarkers],
  )

  const updateMarker = useCallback(
    async (id: string, patch: { color?: string; label?: string | null }) => {
      try {
        if (shareToken) {
          await fetch(`/api/markers/${id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${shareToken}`,
              'X-Framecomment-Client-Id': getClientId(),
            },
            body: JSON.stringify(patch),
          })
        } else {
          await apiPatch(`/api/markers/${id}`, patch)
        }
        await fetchMarkers()
      } catch (err) {
        logError('Failed to update marker:', err)
      }
    },
    [shareToken, fetchMarkers],
  )

  // Initial load + reload when the project changes.
  useEffect(() => {
    fetchMarkers()
  }, [fetchMarkers])

  // Marker-create requests from the comment toolbar + external refresh signals.
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      createMarker(detail.color || 'blue', typeof detail.label === 'string' ? detail.label : null)
    }
    const onChanged = () => {
      fetchMarkers()
    }
    window.addEventListener('framecomment:addMarker', onAdd as EventListener)
    window.addEventListener('framecomment:markersChanged', onChanged)
    return () => {
      window.removeEventListener('framecomment:addMarker', onAdd as EventListener)
      window.removeEventListener('framecomment:markersChanged', onChanged)
    }
  }, [createMarker, fetchMarkers])

  // Per-version markers, sorted by time — feeds the timeline pins + the
  // ↑/↓ jump navigation.
  const activeVersionMarkers = useMemo(
    () =>
      markers
        .filter((m) => m.videoId === selectedVideo?.id)
        .sort((a, b) => a.timestampMs - b.timestampMs),
    [markers, selectedVideo?.id],
  )
  const activeVersionMarkersRef = useRef<MarkerFlag[]>([])
  useEffect(() => {
    activeVersionMarkersRef.current = activeVersionMarkers
  }, [activeVersionMarkers])

  // 1.3.2+: Which stream qualities does THIS clip actually have?
  // We surface them to PlayerSettingsMenu so the Quality submenu only
  // shows options the server can satisfy (no point listing 4K when the
  // worker never produced a 2160p variant). Order is high → low so the
  // menu reads top-down.
  const availableQualities = useMemo(() => {
    // 1.9.4+ Phase A: 480p included as the fastest progressive
    // tier. Order is high → low so the quality menu reads
    // top-down with the best option first.
    //
    // 1.9.4+ Phase B: when HLS is active, qualities come from
    // `hlsQualities` (the server's source-of-truth list of
    // ready tiers) rather than the MP4 stream URL slots. That
    // way newly-finished tiers show up in the menu as soon as
    // the next poll lands, even though hls.js's internal level
    // list is still the original master snapshot.
    const out: ('2160p' | '1080p' | '720p' | '480p')[] = []
    const v: any = selectedVideo
    if (v?.hlsUrl && Array.isArray(v?.hlsQualities) && v.hlsQualities.length > 0) {
      if (v.hlsQualities.includes('2160p')) out.push('2160p')
      if (v.hlsQualities.includes('1080p')) out.push('1080p')
      if (v.hlsQualities.includes('720p')) out.push('720p')
      if (v.hlsQualities.includes('480p')) out.push('480p')
      return out
    }
    if (v?.streamUrl2160p) out.push('2160p')
    if (v?.streamUrl1080p) out.push('1080p')
    if (v?.streamUrl720p) out.push('720p')
    if (v?.streamUrl480p) out.push('480p')
    return out
  }, [selectedVideo])

  // 1.9.4+ Phase A: pending qualities — tiers the progressive
  // ladder PLANS to make but hasn't finished yet. We compute the
  // ladder client-side from the source short-side resolution (no
  // upscaling, same rule the worker uses). The lowest-not-ready
  // tier above the highest READY one is "processing" with the
  // current worker progress; everything past that is "queued".
  // Player picks the tier from the status board so the user
  // understands the full ladder, not just what's downloadable.
  const pendingQualities = useMemo(() => {
    const v: any = selectedVideo
    if (!v) return [] as Array<{ tier: '2160p' | '1080p' | '720p' | '480p'; status: 'processing' | 'queued'; progress?: number }>
    if (v.status !== 'PROCESSING' && v.status !== 'UPLOADING' && v.status !== 'READY') {
      return []
    }
    // 2.0.x+: once the worker writes processingProgress === 100,
    // it's fully done. Any tier still in the source-resolution
    // "universe" but missing from the ladder the worker actually
    // ran (i.e. the project's previewResolution was tighter than
    // the source) would otherwise be stuck in "Finalizing..."
    // forever. The worker is the source of truth — if it says
    // 100 % at READY, nothing more is coming. (UPLOADING /
    // PROCESSING still flow through normally.)
    if (
      v.status === 'READY' &&
      typeof v.processingProgress === 'number' &&
      v.processingProgress >= 100
    ) {
      return []
    }
    const shortSide = Math.min(v.width || 0, v.height || 0)
    if (shortSide <= 0) return []
    // The full universe of tiers the ladder COULD climb to for
    // this source. Mirrors computeProgressiveTiers's 90%
    // tolerance — cinematic / cropped sources like 1920×1008
    // are still considered "1080p enough" to deserve the tier.
    const meetsTier = (h: number) => shortSide >= h * 0.9
    const universe: Array<'480p' | '720p' | '1080p' | '2160p'> = ['480p']
    if (meetsTier(720)) universe.push('720p')
    if (meetsTier(1080)) universe.push('1080p')
    if (meetsTier(2160)) universe.push('2160p')

    // 1.9.4+ Phase B (Bug 5 fix): readiness source must MATCH
    // whatever `availableQualities` reads from, otherwise a
    // tier whose MP4 is done but HLS isn't done yet (or vice
    // versa) ends up in NEITHER bucket and disappears from the
    // menu for a few seconds. When HLS is active, the player
    // is HLS-only, so the source of truth is `hlsQualities`.
    // For legacy MP4-only videos, fall back to the per-tier
    // stream URL slots like before.
    const readySet = new Set<string>()
    if (v.hlsUrl && Array.isArray(v.hlsQualities) && v.hlsQualities.length > 0) {
      for (const q of v.hlsQualities) readySet.add(q)
    } else {
      if (v.streamUrl480p) readySet.add('480p')
      if (v.streamUrl720p) readySet.add('720p')
      if (v.streamUrl1080p) readySet.add('1080p')
      if (v.streamUrl2160p) readySet.add('2160p')
    }

    // 1.9.4+ Phase B (Bug 1+2 fix): per-tier progress map.
    // ALL not-ready tiers process in parallel, and each has
    // its OWN progress key in `transcodeProgressByTier` (e.g.
    // `{"720p": 45, "1080p": 23}`). Worker writes via atomic
    // jsonb_set so two parallel ffmpegs don't clobber each
    // other. This is what makes the menu actually show three
    // different percentages at once instead of three identical
    // ones.
    //
    // Fallback for legacy rows pre-migration: shared
    // `processingProgress` field (everyone sees same %, but
    // at least it's something).
    const pending: Array<{ tier: '2160p' | '1080p' | '720p' | '480p'; status: 'processing' | 'queued'; progress?: number }> = []
    const perTier: Record<string, number> = (v.transcodeProgressByTier && typeof v.transcodeProgressByTier === 'object')
      ? v.transcodeProgressByTier
      : {}
    const fallbackProgress = typeof v.processingProgress === 'number' ? v.processingProgress : 0
    for (const t of universe) {
      if (readySet.has(t)) continue
      const tp = perTier[t]
      const progress = typeof tp === 'number' ? tp : fallbackProgress
      pending.push({
        tier: t,
        status: 'processing',
        progress,
      })
    }
    return pending
  }, [selectedVideo])

  // 1.3.2+: Download Still — grab the current video frame at SOURCE
  // resolution (videoWidth × videoHeight, not the rendered size) and
  // save it as a PNG. Falls back gracefully on browsers that don't
  // expose the canvas API or block tainted-canvas exports.
  const handleDownloadStill = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const w = video.videoWidth || (selectedVideo as any)?.width || 0
    const h = video.videoHeight || (selectedVideo as any)?.height || 0
    if (w <= 0 || h <= 0) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, w, h)
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const baseName = ((selectedVideo as any)?.originalFilename ||
          (selectedVideo as any)?.name ||
          'frame'
        ).replace(/\.[^./]+$/, '')
        const tc = secondsToTimecode(
          currentTimeRef.current,
          (selectedVideo as any)?.fps || 24,
        ).replace(/:/g, '-')
        const a = document.createElement('a')
        a.href = url
        a.download = `${baseName}_${tc}.png`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        // Give the browser a tick to start the download before we
        // revoke the blob URL.
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }, 'image/png')
    } catch (err) {
      logError('[VideoPlayer] download still failed:', err)
    }
  }, [selectedVideo])

  // Comparison mode state
  const [showComparison, setShowComparison] = useState(false)
  // Mirror into a ref so the keyboard handlers (which don't re-bind on
  // every toggle) can cheaply check whether the compare overlay is open
  // and YIELD Space / shortcuts to it — otherwise pressing Space in
  // compare mode would play/pause the main player behind the overlay.
  const showComparisonRef = useRef(false)
  useEffect(() => {
    showComparisonRef.current = showComparison
  }, [showComparison])

  // Drawing mode state
  // Drawing/annotation state lives in a shared Context so the toolbar can
  // be rendered inside CommentInput while the canvas stays here on the video.
  const {
    drawing: annotationDrawing,
    isDrawingMode,
    pendingAnnotation,
    startDrawingMode,
    finishDrawingMode,
    cancelDrawingMode,
  } = useAnnotation()

  // Listen for enterDrawingMode event from CommentInput
  useEffect(() => {
    const handleEnterDrawing = (e: CustomEvent) => {
      const fps = selectedVideo?.fps || 24
      const timecodeStart = secondsToTimecode(currentTimeRef.current, fps)
      startDrawingMode(timecodeStart, e.detail?.timecodeEnd || null)

      // Pause video when entering drawing mode
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause()
      }
    }

    window.addEventListener('enterDrawingMode' as any, handleEnterDrawing as EventListener)
    return () => {
      window.removeEventListener('enterDrawingMode' as any, handleEnterDrawing as EventListener)
    }
  }, [selectedVideo?.fps, startDrawingMode])

  const handleDrawingDone = useCallback(() => {
    finishDrawingMode(selectedVideo?.id)
  }, [finishDrawingMode, selectedVideo?.id])

  const handleDrawingCancel = useCallback(() => {
    cancelDrawingMode()
  }, [cancelDrawingMode])

  // Dispatch event when selected video changes (for immediate comment section update)
  useEffect(() => {
    if (selectedVideo?.id) {
      window.dispatchEvent(new CustomEvent('videoChanged', {
        detail: { videoId: selectedVideo.id }
      }))
    }
  }, [selectedVideo?.id])

  useEffect(() => {
    selectedVideoIdRef.current = selectedVideo?.id ?? null
  }, [selectedVideo?.id])

  useEffect(() => {
    if (!activeVideoName) return
    if (previousVideoNameRef.current && previousVideoNameRef.current !== activeVideoName) {
      setSelectedVideoIndex(0)
      setVideoUrl('')
      currentTimeRef.current = 0
    }
    previousVideoNameRef.current = activeVideoName
  }, [activeVideoName])

  // Listen for the version dropdown in the top bar (ThumbnailReel) — when
  // the user picks a version, locate it in displayVideos by id and jump to
  // that index. We use a window event rather than prop drilling because
  // the dropdown lives several layers above this component (page → reel →
  // event), and the share/admin pages already use the same pattern for
  // other cross-component messages (commentPosted, seekToTime, etc).
  useEffect(() => {
    const handleSelectVersion = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      const targetId: string | undefined = detail.videoId
      if (!targetId) return
      const idx = displayVideos.findIndex((v: any) => v.id === targetId)
      if (idx >= 0) setSelectedVideoIndex(idx)
    }
    window.addEventListener('selectVideoVersion', handleSelectVersion as EventListener)
    return () => {
      window.removeEventListener('selectVideoVersion', handleSelectVersion as EventListener)
    }
  }, [displayVideos])

  // 3.8.x: open the side-by-side version comparison overlay when the
  // top-bar "Compare" button (ThumbnailReel) is clicked. Same window-event
  // pattern as selectVideoVersion above. The overlay + button are gated to
  // ≥2 versions (and the button to large screens), so a stray event on a
  // single-version clip is a harmless no-op.
  useEffect(() => {
    const handleOpenComparison = () => {
      if (displayVideos.length >= 2) setShowComparison(true)
    }
    window.addEventListener('openVersionComparison', handleOpenComparison as EventListener)
    return () => {
      window.removeEventListener('openVersionComparison', handleOpenComparison as EventListener)
    }
  }, [displayVideos])

  // Safety check: ensure selectedVideo exists before accessing properties
  const isVideoApproved = selectedVideo ? (selectedVideo as any).approved === true : false

  // 1.9.4+ Phase B: prefer the HLS master URL when the worker has
  // produced HLS variants. Falls through to the MP4 ladder below
  // when HLS is missing (older videos, transcoding failure, etc.).
  const hlsUrl: string | null = (selectedVideo as any)?.hlsUrl || null

  // 1.9.4+ Phase B FREEZE FIX: stable identity for "which HLS
  // resource is this player attached to", computed by stripping
  // the query string (token + cache busters). Used as the dep
  // for the hls.js attach effect — token rotations on the parent
  // don't trip the destroy+recreate path, which was the source
  // of mid-playback freezes whenever a new tier finished. The
  // full URL (with token) is still used INSIDE the effect for
  // the actual `loadSource` call.
  const hlsResourceKey = useMemo(() => {
    if (!hlsUrl) return ''
    const qIdx = hlsUrl.indexOf('?')
    return qIdx >= 0 ? hlsUrl.slice(0, qIdx) : hlsUrl
  }, [hlsUrl])

  // Keep the ref in sync with the current value so the early-
  // declared `handleQualityChoiceChange` can read the latest URL.
  useEffect(() => {
    hlsUrlRef.current = hlsUrl
  }, [hlsUrl])

  // 2.2.4+: same trick for defaultQuality + qualityChoice so the
  // hls.js MANIFEST_PARSED handlers (both initial attach + reload-
  // in-place) read FRESH values when picking the start level.
  useEffect(() => {
    defaultQualityRef.current = defaultQuality
  }, [defaultQuality])
  useEffect(() => {
    qualityChoiceRef.current = qualityChoice
  }, [qualityChoice])


  // Load video URL with optimization
  useEffect(() => {
    async function loadVideoUrl() {
      try {
        // Safety check: ensure selectedVideo exists
        if (!selectedVideo) {
          return
        }
        // 1.9.4+ Phase B: if this video has HLS configured but
        // we don't yet have a token to build the HLS URL,
        // WAIT. Committing the MP4 path here would lock us in
        // for the session (per committedVideoIdRef), causing
        // the user's complaint: "intru pe video gata-procesat
        // si porneste pe 480p". A few hundred ms of "Loading…"
        // is a much better trade than starting on the wrong
        // tier for the whole session.
        const sv: any = selectedVideo
        const hasHlsConfigured = Array.isArray(sv?.hlsQualities) && sv.hlsQualities.length > 0
        if (hasHlsConfigured && !hlsUrl) {
          return
        }

        // 1.9.4+ Phase B: HLS path. Set videoUrl to the master
        // manifest; the hls.js useEffect below picks it up and
        // attaches to the <video> element (or, on Safari, the
        // browser handles HLS natively from src=).
        //
        // FREEZE FIX: when the parent rotates the token (because a
        // new tier landed and the cache key fingerprint changed),
        // `hlsUrl` here morphs from `...master.m3u8?token=ABC` to
        // `...master.m3u8?token=XYZ`. If we always `setVideoUrl`,
        // Safari (native HLS via <video src>) would reload from
        // scratch — visible freeze. So we keep the OLD videoUrl
        // when only the query string changed, swapping only when
        // the base path differs (new video / new resource). The
        // already-captured token stays valid in Redis long enough
        // to outlast any viewing session, and hls.js / Safari
        // never lose their connection.
        // 1.9.4+ Phase B (ROOT CAUSE FIX for "video resets when
        // 720p lands"): once we've committed to a transport
        // (MP4 or HLS) for this videoId, NEVER switch mid-
        // session. The race the user kept hitting was:
        //   1) page opens while only 480p MP4 is ready (HLS
        //      remux still running) → videoUrl = MP4 stream URL
        //   2) HLS remux finishes for 480p + 720p
        //   3) share page invalidates cache (tier fingerprint
        //      changed), full re-fetch builds a fresh hlsUrl
        //   4) old code saw a "different base" and replaced
        //      videoUrl with HLS master → <video src> changed
        //      → element reset to frame 0 → video freezes,
        //      timeline still at old position
        // The committedVideoIdRef tracks which clip's URL is in
        // the player. While it matches, we leave videoUrl alone
        // — even if the parent has a "better" URL now. Switching
        // to HLS mid-session would always cost the user their
        // playback position.
        if (hlsUrl) {
          if (committedVideoIdRef.current === (selectedVideo as any)?.id) {
            return
          }
          setVideoUrl((prev) => {
            committedVideoIdRef.current = (selectedVideo as any)?.id ?? null
            currentTimeRef.current = 0
            return hlsUrl
          })
          return
        }

        // Use token-based URLs from the video object
        // These are generated by the share API with secure tokens
        // 1.3.2+: the EFFECTIVE quality is the user's explicit choice
        // when set, falling back to the admin-configured defaultQuality
        // when the user has chosen "Auto". The fallback ladder below
        // is shared by both paths.
        // 2.2.0+: defaultQuality can also be the literal `'auto'`
        // string when the project's previewResolution is set to
        // auto (the default). In that case we pick the HIGHEST
        // available tier on first load — exactly what a user
        // expects when they share a fully-processed 1080p clip
        // and the share page opens at 480p ("default se duce la
        // cea mai mica calitate"). The cast to `any` here covers
        // the runtime sentinel that the type union doesn't model.
        const effectiveQuality: '480p' | '720p' | '1080p' | '2160p' | 'auto' =
          qualityChoice === 'auto' ? (defaultQuality as any) : qualityChoice
        let url: string | undefined
        let qualityUsed: '480p' | '720p' | '1080p' | '2160p' =
          (effectiveQuality === 'auto' ? '720p' : effectiveQuality) as '480p' | '720p' | '1080p' | '2160p'

        // 1.9.4+ Phase A: 480p is the "fastest first playable" tier
        // — included as the LAST fallback for every quality choice
        // so a freshly-transcoded video is playable as soon as
        // 480p lands. When we actually serve 480p the menu label
        // honestly says "480p" (not "720p HD") so the user
        // understands why higher options aren't visible yet.
        if (effectiveQuality === 'auto') {
          // 2.2.0+: project set to auto + user hasn't picked a tier
          // yet → start at the highest available tier so a shared
          // fully-processed clip doesn't open at 480p.
          // 3.8.x: BUT the auto pick is now DEVICE-CAPPED — HD (720p)
          // on phones, HD+ (1080p) on larger screens — matching the
          // HLS path (`pickAutoCappedLevelIdx`). We prefer the highest
          // tier AT/BELOW the cap, and only fall back UP to a bigger
          // tier when nothing at/below the cap was encoded. 4K is never
          // auto-selected; the user can still pick it (or any tier)
          // manually from the quality menu on any device. Auth-agnostic,
          // so guests on a public share get the same behaviour.
          const s = selectedVideo as any
          const urlByTier: Record<string, string | undefined> = {
            '2160p': s.streamUrl2160p,
            '1080p': s.streamUrl1080p,
            '720p': s.streamUrl720p,
            '480p': s.streamUrl480p,
          }
          // Highest→lowest ≤cap, then lowest→highest above cap as a
          // last resort.
          const order =
            autoCapHeight() >= 1080
              ? ['1080p', '720p', '480p', '2160p']
              : ['720p', '480p', '1080p', '2160p']
          for (const tier of order) {
            if (urlByTier[tier]) {
              url = urlByTier[tier]
              qualityUsed = tier as '480p' | '720p' | '1080p' | '2160p'
              break
            }
          }
        } else if (effectiveQuality === '2160p') {
          // Prefer 2160p, fall back through the ladder.
          if ((selectedVideo as any).streamUrl2160p) {
            url = (selectedVideo as any).streamUrl2160p
            qualityUsed = '2160p'
          } else if ((selectedVideo as any).streamUrl1080p) {
            url = (selectedVideo as any).streamUrl1080p
            qualityUsed = '1080p'
          } else if ((selectedVideo as any).streamUrl720p) {
            url = (selectedVideo as any).streamUrl720p
            qualityUsed = '720p'
          } else if ((selectedVideo as any).streamUrl480p) {
            url = (selectedVideo as any).streamUrl480p
            qualityUsed = '480p'
          }
        } else if (effectiveQuality === '1080p') {
          if ((selectedVideo as any).streamUrl1080p) {
            url = (selectedVideo as any).streamUrl1080p
            qualityUsed = '1080p'
          } else if ((selectedVideo as any).streamUrl720p) {
            url = (selectedVideo as any).streamUrl720p
            qualityUsed = '720p'
          } else if ((selectedVideo as any).streamUrl2160p) {
            url = (selectedVideo as any).streamUrl2160p
            qualityUsed = '2160p'
          } else if ((selectedVideo as any).streamUrl480p) {
            url = (selectedVideo as any).streamUrl480p
            qualityUsed = '480p'
          }
        } else if (effectiveQuality === '720p') {
          // Prefer 720p, fall back to 480p (fastest), then 1080p, then 2160p.
          if ((selectedVideo as any).streamUrl720p) {
            url = (selectedVideo as any).streamUrl720p
            qualityUsed = '720p'
          } else if ((selectedVideo as any).streamUrl480p) {
            url = (selectedVideo as any).streamUrl480p
            qualityUsed = '480p'
          } else if ((selectedVideo as any).streamUrl1080p) {
            url = (selectedVideo as any).streamUrl1080p
            qualityUsed = '1080p'
          } else if ((selectedVideo as any).streamUrl2160p) {
            url = (selectedVideo as any).streamUrl2160p
            qualityUsed = '2160p'
          }
        } else {
          // 480p chosen explicitly — prefer 480p, then climb.
          if ((selectedVideo as any).streamUrl480p) {
            url = (selectedVideo as any).streamUrl480p
            qualityUsed = '480p'
          } else if ((selectedVideo as any).streamUrl720p) {
            url = (selectedVideo as any).streamUrl720p
            qualityUsed = '720p'
          } else if ((selectedVideo as any).streamUrl1080p) {
            url = (selectedVideo as any).streamUrl1080p
            qualityUsed = '1080p'
          } else if ((selectedVideo as any).streamUrl2160p) {
            url = (selectedVideo as any).streamUrl2160p
            qualityUsed = '2160p'
          }
        }

        if (url) {
          if (committedVideoIdRef.current === (selectedVideo as any)?.id) {
            return
          }
          committedVideoIdRef.current = (selectedVideo as any)?.id ?? null
          // Reset player state
          currentTimeRef.current = 0
          setResolvedPlaybackQuality(qualityUsed)

          // Update video URL - this will trigger React to update the video element's src
          setVideoUrl(url)
        }
      } catch (error) {
        // Video load error - player will show error state
      }
    }

    loadVideoUrl()
  }, [selectedVideo, defaultQuality, qualityChoice, hlsUrl])

  // 1.9.4+ Phase B: hls.js attach for adaptive HLS streaming.
  //
  // CRITICAL: this effect must NEVER re-fire when only the token
  // (query string) in the HLS URL changes. The share page rotates
  // tokens whenever a new tier lands (cache key includes a tier
  // fingerprint), which would cause this effect to destroy +
  // recreate the hls.js instance and FREEZE playback — exactly
  // the bug the user kept reporting. We pin the effect's
  // dependency to `videoUrlBase` (everything before `?`), so
  // token rotations leave the running player untouched and only
  // a real source change (different video / different resource)
  // triggers a re-attach. The URL used for the actual
  // `loadSource` call is captured ONCE at attach time via a ref,
  // so segments load with whatever token was current when we
  // first attached — that token stays valid in Redis long enough
  // to outlast any sane viewing session.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!videoUrl || !videoUrl.includes('.m3u8')) return

    // 1.9.4+ Phase B (Chrome 148+ fix): we no longer skip hls.js
    // for browsers that report native HLS support. Modern Chrome
    // returns `canPlayType('application/vnd.apple.mpegurl') ===
    // 'maybe'`, and the old check treated that as "Safari, let
    // the browser handle it" — meaning we never attached hls.js
    // and Chrome's own ABR was in control, producing the visible
    // 480p → 1080p ramp the user kept hitting. We now always
    // use hls.js when MediaSource is supported, which is true
    // on every desktop browser worth supporting. The async
    // `Hls.isSupported()` check below handles the only platform
    // where MSE is missing (iOS Safari) — there we fall through
    // and the <video src=...> below picks up native HLS as the
    // last resort.

    let hlsInstance: any = null
    let cancelled = false

    ;(async () => {
      try {
        const HlsModule = await import('hls.js')
        const Hls = HlsModule.default
        if (cancelled) return
        if (!Hls.isSupported()) {
          return
        }
        const hls = new Hls({
          manifestLoadingMaxRetry: Infinity,
          manifestLoadingRetryDelay: 1000,
          levelLoadingMaxRetry: Infinity,
          maxBufferLength: 30,
          backBufferLength: 30,
          // CRITICAL: prevent the initial 480p → 720p → 1080p
          // ABR ramp the user keeps hitting.
          //
          //  - autoStartLoad:false → no fragment fetched until
          //    we explicitly call startLoad(). Combined with
          //    pinning currentLevel inside MANIFEST_PARSED, the
          //    very first fragment is from the top tier.
          //  - abrEwmaDefaultEstimate:50Mbps → if ABR is still
          //    consulted somehow (e.g. on the very first probe
          //    before our pin takes effect), it assumes we have
          //    plenty of bandwidth and picks high.
          //  - testBandwidth:false → don't waste an HTTP round-
          //    trip measuring throughput; trust the high estimate.
          //  - capLevelToPlayerSize:false → don't downgrade the
          //    chosen level just because the <video> element is
          //    small on the page (e.g. while UI is still laying
          //    out, intrinsic player size might briefly be 100px
          //    wide and ABR would otherwise pick 480p).
          autoStartLoad: false,
          abrEwmaDefaultEstimate: 50_000_000,
          testBandwidth: false,
          capLevelToPlayerSize: false,
        })
        hlsInstance = hls
        hlsRef.current = hls
        hls.attachMedia(video)
        // FREEZE FIX: read the freshest token-bearing URL at attach
        // time. Subsequent token rotations are ignored — they live
        // in `hlsUrlRef.current` but never re-trigger this effect.
        const attachUrl = hlsUrlRef.current || videoUrl
        hls.loadSource(attachUrl)

        // 1.9.4+ Phase B / 2.2.4+: on initial manifest parse, pin
        // the player to the tier dictated by the project's
        // `previewResolution` cap (`defaultQuality` prop) — or to
        // the highest available when the project is set to "auto".
        // THEN call startLoad() to begin fetching. Because
        // autoStartLoad:false was set in the Hls() config, no
        // fragment has been requested yet, so when startLoad
        // triggers the first request it comes from the pinned
        // level. End result: the user never sees the 480p → 720p
        // → 1080p ABR ramp the hls.js default would produce, AND
        // a project capped at 720p no longer opens at 1080p just
        // because a stale 1080p tier still lives in storage.
        hls.once(Hls.Events.MANIFEST_PARSED, () => {
          if (!hls.levels || hls.levels.length === 0) return
          const chosen = pickInitialHlsLevelIdx(
            hls.levels as any,
            defaultQuality,
            qualityChoice,
          )
          hls.nextLevel = chosen
          hls.currentLevel = chosen
          // 4.0.x: set the badge to the pinned tier NOW (manifest parse
          // is fast) instead of leaving it on the "SD" anchor until the
          // first HD/HD+ fragment buffers seconds later.
          const chosenH = (hls.levels?.[chosen] as any)?.height || 0
          setResolvedPlaybackQuality(
            chosenH >= 2160 * 0.9
              ? '2160p'
              : chosenH >= 1080 * 0.9
                ? '1080p'
                : chosenH >= 720 * 0.9
                  ? '720p'
                  : '480p',
          )
          hls.startLoad(-1) // -1 = start from current playhead (0 on fresh load)
        })

        // 1.9.4+ Phase B: badge is driven by hls.js's own
        // LEVEL_SWITCHED event. This is authoritative — fires
        // the moment hls.js commits to playing a new level,
        // unlike `resize` which depended on the video element
        // catching up. With LEVEL_SWITCHED the SD/HD/HD+ badge
        // matches what's actually being decoded, not what was
        // decoded a moment ago. We keep the `resize` listener
        // below as a Safari-native-HLS fallback (Safari doesn't
        // expose hls.js events, so we depend on videoHeight
        // there).
        hls.on(Hls.Events.LEVEL_SWITCHED, (_: any, data: any) => {
          const lvl = hls.levels?.[data?.level]
          if (!lvl) return
          const h = lvl.height || 0
          if (h >= 2160 * 0.9) setResolvedPlaybackQuality('2160p')
          else if (h >= 1080 * 0.9) setResolvedPlaybackQuality('1080p')
          else if (h >= 720 * 0.9) setResolvedPlaybackQuality('720p')
          else setResolvedPlaybackQuality('480p')
        })

        // 4.0.x: we no longer anchor the badge to 480p on attach. The
        // stream is pinned to the target tier at MANIFEST_PARSED (above)
        // and the badge is set to that same tier right there — so it
        // reads HD/HD+ from the start instead of flashing "SD" for the
        // couple of seconds it took the first HD fragment to buffer
        // (which is when LEVEL_SWITCHED used to first fire). The
        // LEVEL_SWITCHED + resize listeners still keep it honest
        // afterwards (manual quality changes, Safari native HLS).

        // Source of truth for "what's actually playing" is the
        // video element's videoHeight — it changes the instant
        // hls.js swaps to a new variant's segments. Compared to
        // listening on Hls.Events.LEVEL_SWITCHED, this:
        //   - fires on the initial level too (LEVEL_SWITCHED only
        //     fires on changes after the first level loads, so
        //     the badge stayed stuck on whatever the initial
        //     useState value was), and
        //   - works for native HLS on Safari as well, where we
        //     bypass hls.js entirely.
        const onResize = () => {
          const h = video.videoHeight || 0
          if (h <= 0) return
          if (h >= 2160 * 0.9) setResolvedPlaybackQuality('2160p')
          else if (h >= 1080 * 0.9) setResolvedPlaybackQuality('1080p')
          else if (h >= 720 * 0.9) setResolvedPlaybackQuality('720p')
          else setResolvedPlaybackQuality('480p')
        }
        video.addEventListener('resize', onResize)
        video.addEventListener('loadedmetadata', onResize)
        // Stash on the cleanup so the listener is removed when
        // hls.js is destroyed.
        ;(hls as any)._onResize = onResize
      } catch {
        // hls.js failed to load (offline cache miss, blocked, etc.).
        // The <video src> will try to play the .m3u8 anyway —
        // Safari handles it, others will surface an error to the
        // user via the standard <video> error path.
      }
    })()

    return () => {
      cancelled = true
      // 1.9.4+ Phase B: destroy whichever instance hlsRef now
      // points to — `reloadHlsInPlace` may have swapped the
      // captured `hlsInstance` for a fresh one mid-life, and
      // we don't want to leak that new instance when the
      // viewer navigates to a different clip.
      const current = hlsRef.current
      if (current) {
        try {
          const onResize = (current as any)._onResize
          if (onResize) {
            video.removeEventListener('resize', onResize)
            video.removeEventListener('loadedmetadata', onResize)
          }
          current.destroy()
        } catch {}
        hlsRef.current = null
      } else if (hlsInstance) {
        // Race: async attach hadn't finished assigning hlsRef
        // when cleanup ran. Fall back to the local closure.
        try {
          hlsInstance.destroy()
        } catch {}
      }
    }
    // 1.9.4+ Phase B: depend on `videoUrl` directly. With the
    // `committedVideoIdRef` guard upstream, videoUrl no longer
    // mutates on token rotation (we commit a single URL per
    // videoId and never replace it mid-session), so this dep
    // doesn't trigger the cleanup→recreate freeze we used to
    // worry about. Using `[videoUrl]` is also necessary because
    // the body's early-return reads `videoUrl` from the closure;
    // depending on a memo derived from hlsUrl (the previous fix)
    // could fire the effect with a stale empty `videoUrl` and
    // miss the actual attach window.
  }, [videoUrl])

  // 1.9.4+ Phase B (Frame.io behaviour — NO auto-upgrade):
  //
  // When a higher tier finishes encoding mid-watch, the player
  // does NOTHING automatic. The new tier simply shows up in
  // the Quality menu as a clickable row (via the readySet
  // logic in `pendingQualities` + `availableQualities`).
  // Playback continues uninterrupted at whatever the user is
  // currently watching. If the user wants the higher quality,
  // they click it — `handleQualityChoiceChange` does the
  // switch (cheap path if the tier is already in hls.levels,
  // expensive `reloadHlsInPlace` if it isn't).
  //
  // No MP4 → HLS transition either: if the user opened while
  // only MP4 was ready, they stay on MP4 for that session.
  // A page refresh is the only way to pick up HLS once it
  // catches up — which the user explicitly confirmed they
  // prefer over any kind of mid-session swap.

  // Handle initial seek from URL parameters (only once on mount)
  useEffect(() => {
    const video = videoRef.current
    if (initialSeekTime !== null && video && videoUrl && !hasInitiallySeenRef.current) {
      const handleLoadedMetadata = () => {
        if (video && initialSeekTime !== null) {
          // Ensure timestamp is within video duration
          const duration = video.duration
          const seekTime = Math.min(initialSeekTime, duration)

          video.currentTime = seekTime
          currentTimeRef.current = seekTime

          // 1.9.4+ Phase B: when the URL signals autoplay (the
          // "new tier arrived, refresh-and-resume" path), call
          // play() here so the reload feels seamless from the
          // user's POV. Mobile browsers can still block this
          // silently — that's fine, they get a tap-to-play.
          if (autoPlayOnInitialSeek) {
            video.play().catch(() => {})
          }

          // Mark that we've done the initial seek
          hasInitiallySeenRef.current = true
        }
      }

      // If metadata already loaded, seek immediately
      if (video.readyState >= 1) {
        handleLoadedMetadata()
      } else {
        // Otherwise wait for metadata to load
        video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
      }

      return () => {
        video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      }
    }
  }, [initialSeekTime, videoUrl])


  // Expose current time for CommentSection
  useEffect(() => {
    const handleGetCurrentTime = (e: CustomEvent) => {
      if (e.detail.callback) {
        e.detail.callback(currentTimeRef.current, selectedVideoIdRef.current)
      }
    }

    window.addEventListener('getCurrentTime' as any, handleGetCurrentTime as EventListener)
    return () => {
      window.removeEventListener('getCurrentTime' as any, handleGetCurrentTime as EventListener)
    }
  }, [])

  // Expose selected video ID for approval
  useEffect(() => {
    const handleGetSelectedVideoId = (e: CustomEvent) => {
      if (e.detail.callback) {
        e.detail.callback(selectedVideoIdRef.current)
      }
    }

    window.addEventListener('getSelectedVideoId' as any, handleGetSelectedVideoId as EventListener)
    return () => {
      window.removeEventListener('getSelectedVideoId' as any, handleGetSelectedVideoId as EventListener)
    }
  }, [])


  // Handle seek to timestamp requests from comments
  useEffect(() => {
    const handleSeekToTime = (e: CustomEvent) => {
      const { timestamp, videoId } = e.detail

      // If videoId is specified and different from current, try to switch to it
      if (videoId && videoId !== selectedVideo.id) {
        const targetVideoIndex = displayVideos.findIndex(v => v.id === videoId)
        if (targetVideoIndex !== -1) {
          setSelectedVideoIndex(targetVideoIndex)
          // Wait for video to load before seeking
          setTimeout(() => {
            if (videoRef.current) {
              videoRef.current.currentTime = timestamp
              currentTimeRef.current = timestamp
              setCurrentTimeState(timestamp)
            }
          }, 500)
          return
        }
      }

      // Same video - just seek
      if (videoRef.current) {
        videoRef.current.currentTime = timestamp
        currentTimeRef.current = timestamp
        setCurrentTimeState(timestamp)
      }
    }

    window.addEventListener('seekToTime' as any, handleSeekToTime as EventListener)
    return () => {
      window.removeEventListener('seekToTime' as any, handleSeekToTime as EventListener)
    }
  }, [selectedVideo.id, displayVideos])

  // Pause video when user starts typing a comment
  useEffect(() => {
    const handlePauseForComment = () => {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause()
      }
    }

    window.addEventListener('pauseVideoForComment', handlePauseForComment)
    return () => {
      window.removeEventListener('pauseVideoForComment', handlePauseForComment)
    }
  }, [])

  // Apply playback speed to video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed
    }
  }, [playbackSpeed])


  // Keyboard shortcuts: Ctrl+Space (play/pause), Ctrl+,/. (speed), Ctrl+/ (reset speed), Ctrl+J/L (frame step)
  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      // Compare overlay is open → it owns the player shortcuts.
      if (showComparisonRef.current) return
      if (!videoRef.current) return

      const video = videoRef.current

      // 1.1.1+: every Ctrl-based shortcut below also requires
      // `!e.metaKey` so the macOS Character Viewer (Ctrl+Cmd+Space)
      // and any other Cmd-augmented combos fall through to the OS
      // instead of being swallowed by the player. Previously
      // Ctrl+Cmd+Space matched the play/pause check and killed the
      // emoji picker via preventDefault().

      // Ctrl+Space: Play/Pause
      if (e.ctrlKey && !e.metaKey && e.code === 'Space') {
        e.preventDefault()
        e.stopPropagation()
        if (video.paused) {
          video.play()
        } else {
          video.pause()
        }
        return
      }

      // Ctrl+, or Ctrl+<: Decrease speed by 0.25x
      if (e.ctrlKey && !e.metaKey && (e.code === 'Comma' || e.key === '<')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(prev => Math.max(0.25, prev - 0.25))
        return
      }

      // Ctrl+. or Ctrl+>: Increase speed by 0.25x
      if (e.ctrlKey && !e.metaKey && (e.code === 'Period' || e.key === '>')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(prev => Math.min(2.0, prev + 0.25))
        return
      }

      // Ctrl+/: Reset speed to 1.0x
      if (e.ctrlKey && !e.metaKey && (e.code === 'Slash' || e.key === '/' || e.key === '?')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(1.0)
        return
      }

      // Ctrl+J: Go back one frame
      if (e.ctrlKey && !e.metaKey && e.code === 'KeyJ') {
        e.preventDefault()
        e.stopPropagation()
        if (!selectedVideo?.fps) return

        if (!video.paused) {
          video.pause()
        }

        const frameDuration = 1 / selectedVideo.fps
        video.currentTime = Math.max(0, video.currentTime - frameDuration)
        currentTimeRef.current = video.currentTime // Update ref for comment timecode
        window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
          detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current }
        }))
        return
      }

      // Ctrl+L: Go forward one frame
      if (e.ctrlKey && !e.metaKey && e.code === 'KeyL') {
        e.preventDefault()
        e.stopPropagation()
        if (!selectedVideo?.fps) return

        if (!video.paused) {
          video.pause()
        }

        const frameDuration = 1 / selectedVideo.fps
        const duration = Number.isFinite(video.duration) ? video.duration : undefined
        video.currentTime = duration
          ? Math.min(duration, video.currentTime + frameDuration)
          : video.currentTime + frameDuration
        currentTimeRef.current = video.currentTime // Update ref for comment timecode
        window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
          detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current }
        }))
        return
      }

      // 1.9.0+: Escape exits range-edit mode (any focus context).
      if (e.code === 'Escape' && rangeEditingRef.current) {
        e.preventDefault()
        e.stopPropagation()
        setRangeEditActive(false)
        return
      }

      // ArrowUp / ArrowDown: jump between timeline markers on the active
      // version (4.1.0+). ↑ = previous marker before the playhead, ↓ =
      // next marker after it. When there's no marker left in that
      // direction we fall back to the very first frame (↑) or the last
      // frame (↓) — so the keys double as "back to start / go to end".
      // Skipped while typing in an input / textarea / contenteditable and
      // ignored with any modifier held so OS shortcuts fall through.
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        if (e.ctrlKey || e.metaKey || e.altKey) return
        const target = e.target as HTMLElement | null
        if (target) {
          const tag = target.tagName
          if (
            tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT' ||
            target.isContentEditable
          ) {
            return
          }
        }
        e.preventDefault()
        e.stopPropagation()
        const goUp = e.code === 'ArrowUp'
        const nowMs = (video.currentTime || 0) * 1000
        const EPS = 20 // ms tolerance so we don't re-land on the marker we're on
        const flags = activeVersionMarkersRef.current // already sorted asc
        const duration = Number.isFinite(video.duration) ? video.duration : undefined
        let targetSec: number
        if (goUp) {
          const prev = [...flags].reverse().find((m) => m.timestampMs < nowMs - EPS)
          targetSec = prev ? prev.timestampMs / 1000 : 0
        } else {
          const next = flags.find((m) => m.timestampMs > nowMs + EPS)
          targetSec = next ? next.timestampMs / 1000 : duration ?? nowMs / 1000
        }
        targetSec =
          duration != null ? Math.max(0, Math.min(duration, targetSec)) : Math.max(0, targetSec)
        video.currentTime = targetSec
        currentTimeRef.current = targetSec
        window.dispatchEvent(
          new CustomEvent('videoTimeUpdated', {
            detail: { time: targetSec, videoId: selectedVideoIdRef.current },
          }),
        )
        return
      }

      // ArrowLeft / ArrowRight: step one frame (1.0.7+). Same
      // behaviour as Ctrl+J / Ctrl+L but without the modifier so it
      // matches Frame.io / DaVinci Resolve muscle memory. We skip the
      // shortcut when the user is typing in an input / textarea /
      // contenteditable so it doesn't fight with caret movement —
      // EXCEPT in range-edit mode, where ←/→ is intentionally
      // hijacked to move the yellow OUT handle.
      //
      // 1.9.1+: Shift + ←/→ jumps 1 second instead of 1 frame.
      // Frame.io / DaVinci convention for fast scrubbing. The
      // range-edit branch uses the same step size so the yellow
      // OUT handle also jumps 1 second at a time when Shift is
      // held — convenient for marking longer selections.
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        // Still block other modifiers — those are browser / OS
        // shortcuts we shouldn't hijack.
        if (e.ctrlKey || e.metaKey || e.altKey) return
        const rangeEditing = rangeEditingRef.current
        const target = e.target as HTMLElement | null
        if (target && !rangeEditing) {
          const tag = target.tagName
          if (
            tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT' ||
            target.isContentEditable
          ) {
            return
          }
        }

        e.preventDefault()
        e.stopPropagation()

        if (!video.paused) {
          video.pause()
        }

        // Fall back to ~30 fps when we don't know the real frame rate
        // yet — gives a sensible "one frame" step on the first key
        // press while the metadata is still loading.
        const fps = selectedVideo?.fps && selectedVideo.fps > 0 ? selectedVideo.fps : 30
        const frameDuration = 1 / fps
        // 1.9.1+: Shift = 1 second jump; no Shift = 1 frame step.
        const stepSize = e.shiftKey ? 1 : frameDuration
        const direction = e.code === 'ArrowLeft' ? -1 : 1

        // 1.9.0+: range-edit branch. Instead of stepping the
        // playhead, we move the YELLOW OUT handle. The IN point is
        // pinned at pendingInTimeRef (captured the moment the user
        // focused the input). The first arrow press in this mode
        // seeds OUT at IN + 1 step. Subsequent presses extend or
        // contract OUT by one step (frame or second depending on
        // Shift), clamped to [IN + 1 frame, duration]. We also
        // scrub the video to OUT so the user sees the exact frame
        // they're marking.
        if (rangeEditing) {
          const inTime = pendingInTimeRef.current ?? video.currentTime
          const currentOut = pendingOutTimeRef.current ?? inTime + stepSize
          // Quantise to whole frames so repeated taps land cleanly
          // even when Shift is held (1 second is rarely a whole
          // number of frames at 23.976/29.97 etc).
          const quantize = (t: number) => Math.round(t * fps) / fps
          const minOut = quantize(inTime + frameDuration)
          const proposedOut = quantize(currentOut + direction * stepSize)
          const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY
          const nextOut = Math.max(minOut, Math.min(duration, proposedOut))
          // Scrub video to the new OUT frame for visual feedback.
          video.currentTime = nextOut
          currentTimeRef.current = nextOut
          window.dispatchEvent(
            new CustomEvent('videoTimeUpdated', {
              detail: { time: nextOut, videoId: selectedVideoIdRef.current },
            }),
          )
          // Push the new range so the yellow handle + chip update.
          window.dispatchEvent(
            new CustomEvent('setCommentRange', {
              detail: {
                inTime,
                outTime: nextOut,
                videoId: selectedVideoIdRef.current,
              },
            }),
          )
          return
        }

        // Normal-mode behaviour.
        const next = video.currentTime + direction * stepSize
        const duration = Number.isFinite(video.duration) ? video.duration : undefined
        video.currentTime = duration
          ? Math.max(0, Math.min(duration, next))
          : Math.max(0, next)
        currentTimeRef.current = video.currentTime
        window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
          detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current }
        }))
        return
      }
    }

    // Use capture phase to intercept events before they reach other elements
    window.addEventListener('keydown', handleKeyboard, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyboard, { capture: true })
    }
  }, [selectedVideo])

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const now = Date.now()
      // Throttle to update max every 200ms instead of 60 times per second
      if (now - lastTimeUpdateRef.current > 200) {
        currentTimeRef.current = videoRef.current.currentTime
        setCurrentTimeState(videoRef.current.currentTime)
        lastTimeUpdateRef.current = now
        // 1.2.0+: broadcast playback ticks so the CommentInput's
        // always-on timestamp chip can reflect the live playhead even
        // when nothing is focused. Same payload shape as the existing
        // seek/skip emissions.
        window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
          detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current }
        }))
      }
    }
  }

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setVideoDuration(videoRef.current.duration)
      setVolume(videoRef.current.volume)
      setIsMuted(videoRef.current.muted)
    }
  }

  const handleTimelineSeek = (timestamp: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = timestamp
      currentTimeRef.current = timestamp
      setCurrentTimeState(timestamp)
    }
  }

  const handlePlayPause = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play()
        setIsPlaying(true)
      } else {
        videoRef.current.pause()
        setIsPlaying(false)
      }
    }
  }

  // 1.9.0+: keep refs in sync with the range-edit module + the
  // pending comment range. The arrow handler below reads these
  // synchronously, so the refs need to update the moment the chip
  // is clicked or the range hook recomputes its in/out times.
  useEffect(() => {
    rangeEditingRef.current = isRangeEditActive()
    const onEdit = (e: Event) => {
      const detail = (e as CustomEvent).detail as { active?: boolean } | undefined
      rangeEditingRef.current = Boolean(detail?.active)
    }
    const onRange = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { inTime?: number | null; outTime?: number | null; videoId?: string }
        | undefined
      if (!detail) return
      // Filter by video so cross-clip events don't poison our refs.
      if (
        detail.videoId &&
        selectedVideoIdRef.current &&
        detail.videoId !== selectedVideoIdRef.current
      ) {
        return
      }
      pendingInTimeRef.current =
        typeof detail.inTime === 'number' ? detail.inTime : null
      pendingOutTimeRef.current =
        typeof detail.outTime === 'number' ? detail.outTime : null
    }
    window.addEventListener('commentRangeEditChanged', onEdit as EventListener)
    window.addEventListener('commentRangeStateChanged', onRange as EventListener)
    return () => {
      window.removeEventListener('commentRangeEditChanged', onEdit as EventListener)
      window.removeEventListener('commentRangeStateChanged', onRange as EventListener)
    }
  }, [])

  // 1.8.2+: Frame.io / YouTube-style Space-to-play/pause. Listens
  // on document so it works whether the user clicked the video
  // first or not. Critical guard: never trigger when the focus is
  // in an editable element — the comment input is right next to
  // the player and stealing Space mid-sentence would be terrible.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Compare overlay is open → it owns Space (play/pause both clips).
      if (showComparisonRef.current) return
      // Ignore when the user is typing somewhere: <input>,
      // <textarea>, <select>, or any element with contentEditable.
      const target = e.target as HTMLElement | null
      const isEditable =
        !!target?.isContentEditable ||
        (target instanceof HTMLElement &&
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (isEditable) return
      // Ignore when a modifier is held — we don't want to hijack
      // the browser's Ctrl/Cmd-Space shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code !== 'Space' && e.key !== ' ') return
      e.preventDefault()
      const video = videoRef.current
      if (!video) return
      if (video.paused) {
        void video.play()
        setIsPlaying(true)
      } else {
        video.pause()
        setIsPlaying(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const handleVolumeChange = (newVolume: number) => {
    if (videoRef.current) {
      videoRef.current.volume = newVolume
      setVolume(newVolume)
      if (newVolume > 0 && isMuted) {
        videoRef.current.muted = false
        setIsMuted(false)
      }
    }
  }

  const handleToggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted
      setIsMuted(videoRef.current.muted)
    }
  }

  const handleToggleFullscreen = () => {
    if (!containerRef.current || !videoRef.current) return

    // Mobile devices (especially iOS) need special handling
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    const video = videoRef.current as any // Type cast for webkit APIs
    
    if (!document.fullscreenElement) {
      // Try native video fullscreen first (better for mobile)
      if (isMobile && video.webkitEnterFullscreen) {
        // iOS Safari
        try {
          video.webkitEnterFullscreen()
          setIsFullscreen(true)
        } catch (error) {
          logError('Failed to enter fullscreen:', error)
        }
      } else if (isMobile && video.requestFullscreen) {
        // Android Chrome
        try {
          video.requestFullscreen()
          setIsFullscreen(true)
        } catch (error) {
          logError('Failed to enter fullscreen:', error)
        }
      } else if (containerRef.current.requestFullscreen) {
        // Desktop browsers
        try {
          containerRef.current.requestFullscreen()
          setIsFullscreen(true)
        } catch (error) {
          logError('Failed to enter fullscreen:', error)
        }
      }
    } else {
      // Exit fullscreen
      try {
        document.exitFullscreen()
        setIsFullscreen(false)
      } catch (error) {
        logError('Failed to exit fullscreen:', error)
      }
    }
  }

  const handleFrameStep = (direction: 'forward' | 'backward') => {
    if (!videoRef.current || !selectedVideo?.fps) return

    if (!videoRef.current.paused) {
      videoRef.current.pause()
      setIsPlaying(false)
    }

    const frameDuration = 1 / selectedVideo.fps
    const newTime = direction === 'forward'
      ? Math.min(videoDuration, videoRef.current.currentTime + frameDuration)
      : Math.max(0, videoRef.current.currentTime - frameDuration)
    
    videoRef.current.currentTime = newTime
    currentTimeRef.current = newTime
    setCurrentTimeState(newTime)
    
    window.dispatchEvent(new CustomEvent('videoTimeUpdated', {
      detail: { time: currentTimeRef.current, videoId: selectedVideoIdRef.current }
    }))
  }

  // Auto-hide controls when not in use (2 seconds is standard for most video players)
  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
    }
    setShowControls(true)
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false)
      }, 2000)
    }
  }, [isPlaying])

  // Start auto-hide timer when video starts playing
  useEffect(() => {
    if (isPlaying) {
      resetControlsTimeout()
    } else {
      // Show controls when paused
      setShowControls(true)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }
  }, [isPlaying, resetControlsTimeout])

  // Track video play/pause events
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handlePlay = () => {
      setIsPlaying(true)
      resetControlsTimeout()
    }
    const handlePause = () => setIsPlaying(false)
    const handleVolumeChangeEvent = () => {
      setVolume(video.volume)
      setIsMuted(video.muted)
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('volumechange', handleVolumeChangeEvent)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('volumechange', handleVolumeChangeEvent)
    }
  }, [resetControlsTimeout])

  // Fullscreen change event (handles both desktop and mobile)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      )
      setIsFullscreen(isCurrentlyFullscreen)
    }

    const video = videoRef.current
    if (video) {
      // iOS Safari fullscreen events
      const handleWebkitBegin = () => setIsFullscreen(true)
      const handleWebkitEnd = () => setIsFullscreen(false)
      
      video.addEventListener('webkitbeginfullscreen', handleWebkitBegin)
      video.addEventListener('webkitendfullscreen', handleWebkitEnd)
      
      // Standard fullscreen events
      document.addEventListener('fullscreenchange', handleFullscreenChange)
      document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
      document.addEventListener('mozfullscreenchange', handleFullscreenChange)
      document.addEventListener('MSFullscreenChange', handleFullscreenChange)
      
      return () => {
        video.removeEventListener('webkitbeginfullscreen', handleWebkitBegin)
        video.removeEventListener('webkitendfullscreen', handleWebkitEnd)
        document.removeEventListener('fullscreenchange', handleFullscreenChange)
        document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
        document.removeEventListener('mozfullscreenchange', handleFullscreenChange)
        document.removeEventListener('MSFullscreenChange', handleFullscreenChange)
      }
    }
  }, [])

  // Show controls on mouse move and touch (only within video player)
  useEffect(() => {
    const container = containerRef.current

    const handleInteraction = () => {
      resetControlsTimeout()
    }

    // Hide controls when mouse leaves video player area
    const handleMouseLeave = () => {
      if (isPlaying) {
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current)
        }
        // Hide controls immediately when mouse leaves during playback
        controlsTimeoutRef.current = setTimeout(() => {
          setShowControls(false)
        }, 500) // Short delay before hiding
      }
    }

    if (container) {
      container.addEventListener('mousemove', handleInteraction)
      container.addEventListener('touchstart', handleInteraction)
      container.addEventListener('mouseleave', handleMouseLeave)
    }

    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleInteraction)
        container.removeEventListener('touchstart', handleInteraction)
        container.removeEventListener('mouseleave', handleMouseLeave)
      }
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying])



  // Expose video state to parent for mobile layout
  useEffect(() => {
    if (onVideoStateChange && selectedVideo) {
      onVideoStateChange({
        selectedVideo,
        selectedVideoIndex,
        isVideoApproved,
        displayVideos,
        displayLabel: isVideoApproved ? t('approvedVersion') : selectedVideo.versionLabel,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVideo?.id, selectedVideoIndex, isVideoApproved])

  // Safety check: if no videos available, show message
  if (!selectedVideo || displayVideos.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        No videos available
      </div>
    )
  }

  // Get display label - if video approved, show "Approved Version"
  const displayLabel = isVideoApproved ? t('approvedVersion') : selectedVideo.versionLabel

  // Handle approval - stores video name in session storage and calls parent callback
  const handleApprove = async () => {
    if (activeVideoName) {
      sessionStorage.setItem('approvedVideoName', activeVideoName)
    }
    if (onApprove) {
      await onApprove()
    }
  }

  return (
    <div className={`flex flex-col ${fillContainer ? 'h-full' : 'space-y-4 max-h-full'}`}>
      {/* Version selector pill row removed (1.0.6+). The top-bar
          ThumbnailReel already has a clean Frame.io-style version
          dropdown with filenames + approved checkmarks, so the
          duplicate row above/below the video added clutter without
          extra information. The "Compare versions" UX moved to the
          version dropdown's secondary menu (TODO). */}

      {/* Video Player Container.
          fillContainer=true is the standard player layout (share + admin
          share). flex-1 + min-h-0 makes this the box that absorbs all
          spare vertical space, so the inner video+controls stack always
          fits the viewport and the control bar never gets clipped. */}
      <div
        ref={containerRef}
        className={`relative w-full flex flex-col ${
          fillContainer ? 'flex-1 min-h-0' : 'flex-shrink min-h-0 lg:order-1'
        } ${isPlaying && !showControls ? 'cursor-none' : ''}`}
      >
        {videoUrl ? (
          <>
            {/*
              Simple letterbox approach:
              - Container fills available space with 16:9 aspect ratio
              - Video uses object-contain to maintain its true aspect ratio
              - Background color matches theme for clean letterboxing
            */}
            {/*
              Fully responsive Frame.io-style stack:
              ┌────────────────────────────────────────────┐
              │  flex-1 min-h-0  → video wrapper           │
              │  (the <video> uses object-contain so it    │
              │   scales while keeping its own aspect      │
              │   ratio; vertical clips letterbox left/    │
              │   right, horizontal clips letterbox top/   │
              │   bottom)                                  │
              ├────────────────────────────────────────────┤
              │  flex-shrink-0   → control bar (timeline,  │
              │                    transport, time, etc.) │
              └────────────────────────────────────────────┘
              The outer container fills its parent. Resizing the
              window (or showing/hiding the comment sidebar)
              shrinks the video proportionally; the control bar
              stays at its natural size and never gets clipped.
            */}
            <div className="rounded-xl overflow-hidden bg-black flex flex-col w-full h-full min-h-0">
              <div
                ref={videoWrapperRef}
                className={`relative group w-full bg-black flex items-center justify-center overflow-hidden
                  aspect-video max-h-[70vh]
                  lg:aspect-auto lg:max-h-none lg:flex-1 lg:min-h-0
                  ${isDrawingMode ? '' : ''}`}
              >
                {(selectedVideo as any)?.mediaType === 'IMAGE' ? (
                  // 1.0.9+: image assets render as a plain <img>. The
                  // video element + timeline + playback controls all
                  // become inert in this branch (videoRef.current is
                  // null), which is fine — there's no media to seek.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={selectedVideo?.id}
                    src={
                      (selectedVideo as any).thumbnailUrl ||
                      (selectedVideo as any).streamUrl ||
                      videoUrl
                    }
                    alt={selectedVideo?.name || 'Image asset'}
                    draggable={false}
                    onContextMenu={
                      !isAdmin ? (e) => e.preventDefault() : undefined
                    }
                    className="w-full h-full object-contain select-none"
                  />
                ) : (
                  <video
                    key={selectedVideo?.id}
                    ref={videoRef}
                    // 1.9.4+ Phase B: when the URL is an HLS
                    // manifest AND the browser can't play HLS
                    // natively (Chrome / Firefox), DON'T set
                    // `src` here — hls.js will attach a
                    // MediaSource via `attachMedia` + load the
                    // manifest internally via `loadSource`. If we
                    // set `src` first, the browser tries to play
                    // the .m3u8 as a regular file and throws
                    // "NotSupportedError: no supported sources"
                    // before hls.js gets a chance. Safari / iOS
                    // do play .m3u8 natively, so we keep `src`
                    // there.
                    src={
                      // 1.9.4+ Phase B (Chrome 148+ fix): when the
                      // URL is an HLS manifest AND MediaSource is
                      // supported, leave `src` undefined so the
                      // hls.js attach effect can wire up MSE
                      // playback. The old logic gated on
                      // `canPlayType('application/vnd.apple.mpegurl')`
                      // — but modern Chrome returns 'maybe' there,
                      // so we used to set src=videoUrl and let
                      // Chrome's native HLS handle it (with its
                      // own visible 480p→1080p ABR ramp). Using
                      // MediaSource availability instead correctly
                      // routes Chrome through hls.js where we can
                      // pin the level. Only iOS Safari (no MSE)
                      // falls back to the native src.
                      videoUrl && videoUrl.includes('.m3u8') &&
                      typeof window !== 'undefined' &&
                      typeof (window as any).MediaSource !== 'undefined'
                        ? undefined
                        : videoUrl
                    }
                    poster={(selectedVideo as any).thumbnailUrl || undefined}
                    className={`w-full h-full object-contain ${isDrawingMode ? 'pointer-events-none' : 'cursor-pointer'}`}
                    // 1.4.x: belt-and-suspenders inline `object-fit:
                    // contain`. Some iOS Safari builds drop the
                    // Tailwind `object-contain` class after a seek on
                    // clips with rotation metadata — the video then
                    // stretches to fill the wrapper instead of
                    // letterboxing. Re-asserting via inline style
                    // survives that quirk because the runtime style
                    // wins over any class-derived rule.
                    style={{ objectFit: 'contain' }}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onContextMenu={!isAdmin ? (e) => e.preventDefault() : undefined}
                    // 1.9.0+: while range-edit mode is active, a
                    // click on the <video> exits the mode and is
                    // consumed (no play/pause toggle). Second click
                    // resumes normal play/pause behaviour.
                    onClick={
                      isDrawingMode
                        ? undefined
                        : () => {
                            if (isRangeEditActive()) {
                              setRangeEditActive(false)
                              return
                            }
                            handlePlayPause()
                          }
                    }
                    crossOrigin="anonymous"
                    playsInline
                    preload="metadata"
                    // @ts-ignore - webkit attributes for iOS
                    webkit-playsinline="true"
                    x-webkit-airplay="allow"
                  />
                )}

                {/* Annotation Overlay (read-only, renders saved drawing annotations during playback) */}
                <AnnotationOverlay
                  comments={activeVersionComments as any[]}
                  currentTime={currentTimeState}
                  videoFps={selectedVideo?.fps || 24}
                  containerRef={videoWrapperRef}
                  videoRef={videoRef}
                  hidden={isDrawingMode}
                  pendingAnnotation={pendingAnnotation}
                />

                {/* Drawing Mode: just the interactive canvas. The toolbar is
                    rendered inline inside CommentInput via the shared
                    AnnotationContext, so the user can pick tools and colours
                    without leaving the comment area. */}
                {isDrawingMode && (
                  <AnnotationCanvas
                    containerRef={videoWrapperRef}
                    videoRef={videoRef}
                    shapes={annotationDrawing.shapes}
                    activeShape={annotationDrawing.activeShape}
                    onStartShape={annotationDrawing.startShape}
                    onUpdateShape={annotationDrawing.updateShape}
                    onFinishShape={annotationDrawing.finishShape}
                  />
                )}

                {/* 1.3.2+: social safe-zone overlay. Renders inside the
                    same positioned wrapper as the <video> so its lines
                    sit exactly on top of what the user sees. */}
                {(selectedVideo as any)?.mediaType !== 'IMAGE' && (
                  <SafeZoneOverlay
                    mode={guidesPreset}
                    videoWidth={(selectedVideo as any)?.width}
                    videoHeight={(selectedVideo as any)?.height}
                    containerRef={videoWrapperRef}
                  />
                )}

                {/* 1.3.2+: Premiere-style rulers + draggable guides. */}
                {(selectedVideo as any)?.mediaType !== 'IMAGE' && (
                  <RulersOverlay
                    enabled={rulersEnabled}
                    videoWidth={(selectedVideo as any)?.width}
                    videoHeight={(selectedVideo as any)?.height}
                    containerRef={videoWrapperRef}
                  />
                )}
              </div>

              {/* Frame.io-style control bar — rendered below the video,
                  not as an overlay. flex-shrink-0 means it keeps its
                  natural size as the viewport shrinks; the video on
                  top absorbs the difference via object-contain.
                  1.0.9+: hidden entirely for image assets — there's
                  no playback to control, no timeline to scrub. */}
              {(selectedVideo as any)?.mediaType !== 'IMAGE' && (
              <div className="bg-black border-t border-white/10 flex-shrink-0">
                <CustomVideoControls
                  videoRef={videoRef as React.RefObject<HTMLVideoElement>}
                  videoDuration={videoDuration}
                  currentTime={currentTimeState}
                  isPlaying={isPlaying}
                  volume={volume}
                  isMuted={isMuted}
                  isFullscreen={isFullscreen}
                  onPlayPause={handlePlayPause}
                  onSeek={handleTimelineSeek}
                  onVolumeChange={handleVolumeChange}
                  onToggleMute={handleToggleMute}
                  onToggleFullscreen={handleToggleFullscreen}
                  onFrameStep={handleFrameStep}
                  comments={activeVersionComments}
                  videoFps={selectedVideo?.fps || 24}
                  videoId={selectedVideo?.id}
                  storyboardUrl={(selectedVideo as any)?.storyboardUrl || null}
                  isAdmin={isAdmin}
                  timestampDisplayMode={timestampDisplayMode}
                  onMarkerClick={onCommentFocus}
                  flagMarkers={activeVersionMarkers as any}
                  onFlagMarkerDelete={deleteMarker}
                  onFlagMarkerUpdate={updateMarker}
                  playbackSpeed={playbackSpeed}
                  onPlaybackSpeedChange={setPlaybackSpeed}
                  resolvedPlaybackQuality={resolvedPlaybackQuality as any}
                  availableQualities={availableQualities as any}
                  pendingQualities={pendingQualities}
                  qualityChoice={qualityChoice}
                  onQualityChoiceChange={handleQualityChoiceChange}
                  guidesPreset={guidesPreset}
                  onGuidesPresetChange={setGuidesPreset}
                  rulersEnabled={rulersEnabled}
                  onRulersEnabledChange={setRulersEnabled}
                  onDownloadStill={handleDownloadStill}
                  shareToken={shareToken}
                />
              </div>
              )}
            </div>
          </>
        ) : (
          /* 3.2.0+: frosted-glass loading slate inside the player frame —
             matches the share page's outer loading card so once the
             player wrapper mounts, the visual stays consistent (no flash
             from glass card → flat black box → real player). */
          <div
            className="w-full h-full aspect-video lg:aspect-auto max-h-[70vh] lg:max-h-none flex items-center justify-center gap-4 text-white rounded-xl ring-1 ring-white/15"
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
            <p className="text-sm font-medium text-white/85">Loading video...</p>
          </div>
        )}
      </div>

      {/* Video Comparison Modal */}
      {showComparison && displayVideos.length >= 2 && (
        <VideoComparison
          videoVersions={displayVideos}
          defaultQuality={defaultQuality as any}
          timestampDisplayMode={timestampDisplayMode}
          onClose={() => setShowComparison(false)}
        />
      )}

      {/*
        Bottom info bar (filename + Approve + Info + Download) was hidden
        in the v1.0.4 redesign — the filename now lives in the top bar
        and Approve/Info will move into the top bar's right-hand section
        in a follow-up. Kept the prop wiring intact so it's a one-liner
        to bring back if needed.
      */}
      {false && (
        <ProjectInfo
          selectedVideo={selectedVideo}
          displayLabel={displayLabel}
          isVideoApproved={isVideoApproved}
          projectId={projectId}
          projectTitle={projectTitle}
          projectDescription={projectDescription}
          clientName={clientName}
          isPasswordProtected={isPasswordProtected}
          watermarkEnabled={watermarkEnabled}
          defaultQuality={defaultQuality as any}
          onApprove={onApprove ? handleApprove : undefined}
          isAdmin={isAdmin}
          clientCanApprove={clientCanApprove}
          isGuest={isGuest}
          hideDownloadButton={hideDownloadButton}
          allowAssetDownload={allowAssetDownload}
          shareToken={shareToken}
          activeVideoName={activeVideoName}
          authenticatedEmail={authenticatedEmail}
          authenticatedName={authenticatedName}
          className="mt-3 lg:order-3"
          usePreviewForApprovedPlayback={usePreviewForApprovedPlayback}
          playbackQuality={resolvedPlaybackQuality as any}
        />
      )}
    </div>
  )
}
