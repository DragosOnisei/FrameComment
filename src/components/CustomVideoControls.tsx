'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward } from 'lucide-react'
import { getUserColor } from '@/lib/utils'
import { timecodeToSeconds, timecodeToSeekSeconds, secondsToTimecode, formatCommentTimestamp } from '@/lib/timecode'
import { isRangeEditActive } from '@/lib/comment-range-edit'
import PlaybackSpeedMenu from './PlaybackSpeedMenu'
import PlayerSettingsMenu, { type QualityChoice } from './PlayerSettingsMenu'
import { AudioAttachment } from './CommentAttachments'
import type { SafeZonePreset } from './SafeZoneOverlay'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

interface CustomVideoControlsProps {
  videoRef: React.RefObject<HTMLVideoElement>
  videoDuration: number
  currentTime: number
  isPlaying: boolean
  volume: number
  isMuted: boolean
  isFullscreen: boolean
  onPlayPause: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onToggleMute: () => void
  onToggleFullscreen: () => void
  onFrameStep: (direction: 'forward' | 'backward') => void
  comments?: CommentWithReplies[]
  videoFps?: number
  videoId?: string
  isAdmin?: boolean
  timestampDisplayMode?: 'TIMECODE' | 'AUTO'
  onMarkerClick?: (commentId: string) => void // Callback when a timeline marker is clicked
  /** Current playback speed (1.0 = normal). Driven from VideoPlayer so the
   *  same value can also feed the keyboard shortcuts. */
  playbackSpeed?: number
  /** Setter for playback speed; when omitted, the speed button is hidden. */
  onPlaybackSpeedChange?: (speed: number) => void
  /** Resolved quality for the current stream — used as a small read-only
   *  badge on the right-hand side of the bar (e.g. HD/4K). */
  resolvedPlaybackQuality?: '720p' | '1080p' | '2160p' | '480p'
  /** 1.3.2+: Settings popup state — Quality / Guides / Rulers /
   *  Download Still. All optional so the player can drop the menu when
   *  the parent doesn't wire it up (e.g. comparison view). */
  availableQualities?: ('2160p' | '1080p' | '720p' | '480p')[]
  /** 1.9.4+ Phase A: progressive tiers not yet finished — surfaced
   *  in the Quality submenu with status badges so users see the
   *  full ladder including what's still cooking. */
  pendingQualities?: Array<{
    tier: '2160p' | '1080p' | '720p' | '480p'
    status: 'processing' | 'queued'
    progress?: number
  }>
  qualityChoice?: QualityChoice
  onQualityChoiceChange?: (q: QualityChoice) => void
  guidesPreset?: SafeZonePreset
  onGuidesPresetChange?: (g: SafeZonePreset) => void
  rulersEnabled?: boolean
  onRulersEnabledChange?: (on: boolean) => void
  onDownloadStill?: () => void
  /** 2.5.1+: forwarded to AudioAttachment in the timeline popover so
   *  voice comments play correctly under both share + admin
   *  contexts. */
  shareToken?: string | null
}

// Frame.io-style timeline marker colours (1.0.7+) — fully opaque
// solid fills with white text and a tiny dark ring so the dots stay
// readable over a bright video frame. Keys mirror `getUserColor`'s
// border classes so the existing lookup still works; only the bg /
// ring / text values were swapped out.
// Each entry is `{ bg, ring, text }` — `bg` is the solid fill, `ring`
// is a thin dark outline (so the dot still reads on a light video
// frame), `text` is always white because the fills are saturated.
const SOLID_RING = 'ring-black/40 dark:ring-black/50'
const SOLID_TEXT = 'text-white'
const solid = (bg: string) => ({ bg, ring: SOLID_RING, text: SOLID_TEXT })
const COLOR_MAP: Record<string, { bg: string; ring: string; text: string }> = {
  // Receiver palette (saturated 500-tier).
  'border-gray-500': solid('bg-gray-500'),
  'border-red-500': solid('bg-red-500'),
  'border-orange-500': solid('bg-orange-500'),
  'border-amber-500': solid('bg-amber-500'),
  'border-yellow-400': solid('bg-yellow-400'),
  'border-lime-500': solid('bg-lime-500'),
  'border-green-500': solid('bg-green-500'),
  'border-emerald-500': solid('bg-emerald-500'),
  'border-pink-500': solid('bg-pink-500'),
  'border-rose-500': solid('bg-rose-500'),
  'border-fuchsia-500': solid('bg-fuchsia-500'),
  'border-teal-500': solid('bg-teal-500'),
  'border-cyan-500': solid('bg-cyan-500'),
  'border-sky-500': solid('bg-sky-500'),
  'border-blue-500': solid('bg-blue-500'),
  'border-indigo-500': solid('bg-indigo-500'),
  'border-violet-500': solid('bg-violet-500'),
  'border-purple-500': solid('bg-purple-500'),
  'border-red-600': solid('bg-red-600'),
  'border-orange-600': solid('bg-orange-600'),
  'border-yellow-500': solid('bg-yellow-500'),
  // Sender palette (darker, 600/700/800 tiers).
  'border-amber-700': solid('bg-amber-700'),
  'border-orange-800': solid('bg-orange-800'),
  'border-stone-600': solid('bg-stone-600'),
  'border-yellow-700': solid('bg-yellow-700'),
  'border-lime-700': solid('bg-lime-700'),
  'border-green-700': solid('bg-green-700'),
  'border-emerald-800': solid('bg-emerald-800'),
  'border-teal-800': solid('bg-teal-800'),
  'border-slate-600': solid('bg-slate-600'),
  'border-zinc-600': solid('bg-zinc-600'),
  'border-amber-800': solid('bg-amber-800'),
  'border-yellow-800': solid('bg-yellow-800'),
  'border-lime-800': solid('bg-lime-800'),
  'border-green-800': solid('bg-green-800'),
  'border-teal-700': solid('bg-teal-700'),
  'border-cyan-800': solid('bg-cyan-800'),
  'border-stone-700': solid('bg-stone-700'),
  'border-slate-700': solid('bg-slate-700'),
  'border-neutral-600': solid('bg-neutral-600'),
  'border-orange-900': solid('bg-orange-900'),
}

function initialsFromName(name: string | null | undefined): string {
  const value = (name || '').trim()
  if (!value) return '?'

  const parts = value.split(/\s+/).filter(Boolean)
  if (parts.length === 1) {
    const word = parts[0]
    return word.slice(0, Math.min(2, word.length)).toUpperCase()
  }

  const first = parts[0][0] || ''
  const last = parts[parts.length - 1][0] || ''
  const initials = `${first}${last}`.trim()
  return initials ? initials.toUpperCase() : '?'
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatTimeWithMode(
  seconds: number,
  fps: number,
  videoDurationSeconds: number,
  mode: 'TIMECODE' | 'AUTO'
): string {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return mode === 'TIMECODE' ? '00:00' : '0:00'
  
  const timecode = secondsToTimecode(seconds, fps)
  return formatCommentTimestamp({
    timecode,
    fps,
    videoDurationSeconds,
    mode,
  })
}

interface MarkerData {
  id: string
  timestamp: number
  authorName: string | null
  initials: string
  colorKey: string
  content: string
  position: number
  /** 2.5.1+: if the comment carries a voice/audio attachment we
   *  surface it on the marker so the timeline popover can render an
   *  inline player. We only need enough info for the AudioAttachment
   *  component to fetch the signed URL — id is the key, the rest is
   *  metadata shown on the chip. */
  audioAsset: {
    id: string
    fileName: string
    fileSize: string
    fileType: string
    category: string | null
    createdAt: string
  } | null
}

interface RangeBarData {
  id: string
  startPosition: number
  endPosition: number
  colorKey: string
}

export default function CustomVideoControls({
  videoRef: _videoRef,
  videoDuration,
  currentTime,
  isPlaying,
  volume,
  isMuted,
  isFullscreen,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onToggleFullscreen,
  onFrameStep,
  comments = [],
  videoFps = 24,
  videoId = '',
  isAdmin: _isAdmin = false,
  timestampDisplayMode = 'TIMECODE',
  onMarkerClick,
  playbackSpeed = 1,
  onPlaybackSpeedChange,
  resolvedPlaybackQuality,
  availableQualities,
  pendingQualities,
  qualityChoice,
  onQualityChoiceChange,
  guidesPreset,
  onGuidesPresetChange,
  rulersEnabled,
  onRulersEnabledChange,
  onDownloadStill,
  shareToken = null,
}: CustomVideoControlsProps) {
  const t = useTranslations('controls')
  const tComments = useTranslations('comments')
  const [isDragging, setIsDragging] = useState(false)
  const [showVolume, setShowVolume] = useState(false)
  // 1.9.1+: custom volume slider state. Native <input type=range>
  // doesn't let us transition the thumb position, so we replace it
  // with a div-based slider that mirrors the timeline pattern.
  const volumeTrackRef = useRef<HTMLDivElement>(null)
  const [isDraggingVolume, setIsDraggingVolume] = useState(false)
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  // 1.3.1+: viewport-width tracker. Used to apply inline-style width
  // on the timeline-comment tooltip on phones because Tailwind's
  // arbitrary-value classes inside template literals can fail to
  // generate at build time. Inline styles always win.
  const [viewportWidth, setViewportWidth] = useState<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1024,
  )
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // 1.3.1+: when multiple comments share the same timestamp the
  // timeline avatar shows them as a stack (badge "+N"). On the popover
  // we used to render all of them concatenated, which made the card
  // tall and noisy. Frame.io shows ONE at a time with a "1 / N"
  // indicator + swipe-to-navigate. We track the index here keyed by
  // the hovered marker so it resets when the user switches stacks.
  const [stackIndex, setStackIndex] = useState(0)
  const swipeStartXRef = useRef<number | null>(null)
  // 1.3.2+: track which way the user is paging through a stacked
  // comment group so we can slide the new card IN from the matching
  // edge — swiping LEFT (next) ⇒ new card flies in from the RIGHT,
  // swiping RIGHT (prev) ⇒ new card flies in from the LEFT. Matches
  // the standard "carousel" gesture vocabulary so the motion confirms
  // what the finger just did.
  const [stackSlideDir, setStackSlideDir] = useState<'next' | 'prev' | null>(
    null,
  )
  // Bumped on every stackIndex change so the animated card re-mounts
  // (React `key`) even when paging back to the same index from the
  // opposite direction — without this, going prev→next on a 2-item
  // stack would skip the second animation because the key didn't
  // change. Kept as state (not ref) so the JSX render is guaranteed
  // to see the bumped value alongside the slide-dir change.
  const [stackAnimSeq, setStackAnimSeq] = useState(0)
  // 1.3.2+: navigate across ALL timeline comments, not just within
  // the current stack. The popover treats every marker on the
  // timeline as one flat chronological list — when a swipe walks
  // past the end of the current stack it jumps to the first
  // comment of the next marker (and vice versa for swipe-back).
  // We also seek the video so the playhead lands on the new
  // comment's timecode and re-anchor the popover via
  // `hoveredMarkerId` so it visually slides to that marker.
  const goToAdjacentComment = useCallback(
    (
      dir: 'next' | 'prev',
      currentGroupIndex: number,
      withinGroupIndex: number,
      groups: MarkerData[][],
    ) => {
      if (groups.length === 0) return
      const safeWithin = Math.max(
        0,
        Math.min(withinGroupIndex, groups[currentGroupIndex].length - 1),
      )
      let nextGroup = currentGroupIndex
      let nextWithin = safeWithin
      if (dir === 'next') {
        if (safeWithin + 1 < groups[currentGroupIndex].length) {
          // Still inside the current stack — advance within it.
          nextWithin = safeWithin + 1
        } else {
          // End of stack — jump to first comment of next group,
          // wrapping back to the first group at the very end so the
          // gesture is non-blocking.
          nextGroup = (currentGroupIndex + 1) % groups.length
          nextWithin = 0
        }
      } else {
        if (safeWithin > 0) {
          nextWithin = safeWithin - 1
        } else {
          // Start of stack — jump to LAST comment of previous group.
          nextGroup =
            (currentGroupIndex - 1 + groups.length) % groups.length
          nextWithin = groups[nextGroup].length - 1
        }
      }
      const nextMarker = groups[nextGroup][nextWithin]
      // Seek the video so the playhead matches what the popover
      // now shows — feels much closer to Frame.io's "scrub through
      // notes" gesture than a silent text change would.
      onSeek(nextMarker.timestamp)
      // Re-anchor the popover. Both setters land in the same React
      // batch as the slide-dir + anim-seq updates below, so the
      // single re-render carries the animation + the new marker
      // together. The hoveredMarkerId reset inside the
      // useEffect([hoveredMarkerId]) would normally clear our
      // stackSlideDir — we sequence the calls so the dir is set
      // AFTER the reset (it lands in the same batch but React's
      // last-write-wins reducer keeps our value).
      setStackSlideDir(dir)
      setStackAnimSeq((s) => s + 1)
      setStackIndex(nextWithin)
      setHoveredMarkerId(nextMarker.id)
    },
    [onSeek],
  )
  // 1.3.2+: the cross-marker swipe nav (`goToAdjacentComment`) also
  // mutates `hoveredMarkerId` to re-anchor the popover. We can NOT
  // reset stack state on every hoveredMarkerId change via a
  // useEffect any more — that would immediately clobber the
  // direction/index that the swipe handler just set in the same
  // batch. Instead we reset explicitly inside the *user-initiated*
  // open paths (mouse enter + touch start on a marker), see
  // `handleMarkerMouseEnter` and `handleMarkerTouchStart` below.
  // The intentional side-effect: a programmatic nav preserves its
  // animation; a fresh hover/tap on a different marker starts at
  // stack-index 0 with no slide.
  const [hoveredTime, setHoveredTime] = useState<number | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const volumeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const touchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // 2.5.1+: live viewport rect of the currently-hovered avatar
  // marker. Drives the portalled popover's fixed coordinates so it
  // sits directly above the avatar even though it renders under
  // document.body. We refresh on hover, scroll, and resize.
  const markerRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!hoveredMarkerId) {
      setPopoverRect(null)
      return
    }
    const compute = () => {
      const el = markerRefs.current.get(hoveredMarkerId)
      if (!el) return
      setPopoverRect(el.getBoundingClientRect())
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [hoveredMarkerId])

  // Pending in/out range for the comment composer. Driven by the
  // useCommentManagement hook via the commentRangeStateChanged window
  // event. When `pendingInTime` is non-null the timeline paints an IN
  // bracket; if a click on the timeline lands AFTER that time, we
  // treat it as setting the OUT point instead of seeking. Plain clicks
  // before/at the in-point still seek as normal.
  const [pendingInTime, setPendingInTime] = useState<number | null>(null)
  const [pendingOutTime, setPendingOutTime] = useState<number | null>(null)
  // True while the user is actively dragging the OUT handle above the
  // timeline. Document-level mousemove/up listeners take over so the
  // drag continues smoothly even if the cursor leaves the timeline rect.
  const [isDraggingOutHandle, setIsDraggingOutHandle] = useState(false)
  // 1.3.2+: snapshot of the playhead's display position (%) taken at
  // the moment the user grabs the OUT handle. Used by
  // `displayedProgress` to keep the white ball glued to IN during the
  // drag even though the underlying video is being scrubbed. Refs
  // (not state) so the value is available synchronously inside the
  // very first onMove without waiting for a React render.
  const frozenPlayheadPctRef = useRef<number | null>(null)
  // 1.3.2+: live position (%) of the yellow OUT handle while the
  // user is dragging. State (not ref) so React re-renders the
  // handle's position smoothly with each touchmove. We also keep
  // the corresponding TIME in a ref so the very-first onMove can
  // dispatch the range without waiting for state.
  const [dragOutPct, setDragOutPct] = useState<number | null>(null)
  const frozenInTimeRef = useRef<number | null>(null)
  // 1.9.0+: range-edit mode mirror (driven by the chip in
  // CommentInput). When active the white playhead handle dims to
  // signal that ←/→ now moves the yellow OUT handle, not the
  // playhead.
  const [rangeEditing, setRangeEditing] = useState(false)
  useEffect(() => {
    setRangeEditing(isRangeEditActive())
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { active?: boolean }
        | undefined
      setRangeEditing(Boolean(detail?.active))
    }
    window.addEventListener('commentRangeEditChanged', onChange as EventListener)
    return () =>
      window.removeEventListener('commentRangeEditChanged', onChange as EventListener)
  }, [])
  useEffect(() => {
    if (!isDraggingOutHandle) return
    const computeTime = (clientX: number) => {
      const rect = timelineRef.current?.getBoundingClientRect()
      if (!rect || !videoDuration) return null
      const x = clientX - rect.left
      const pct = Math.max(0, Math.min(1, x / rect.width))
      return pct * videoDuration
    }
    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX = (e as TouchEvent).touches?.[0]?.clientX ?? (e as MouseEvent).clientX
      if (typeof clientX !== 'number') return
      const time = computeTime(clientX)
      if (time === null) return
      // IN was snapshotted at drag start (frozenInTimeRef) so we don't
      // rely on pendingInTime which only propagates via a React state
      // round-trip. minGap of 1 frame keeps the range from collapsing.
      const inT = frozenInTimeRef.current
      const fps = videoFps && videoFps > 0 ? videoFps : 24
      const quantized = Math.round(time * fps) / fps
      const minGap = 1 / fps
      const safeOut =
        inT !== null ? Math.max(quantized, inT + minGap) : quantized
      // Update the yellow handle's live position so the React render
      // moves it to the finger's position.
      const outPct = videoDuration > 0
        ? Math.min(100, Math.max(0, (safeOut / videoDuration) * 100))
        : 0
      setDragOutPct(outPct)
      // Dispatch BOTH IN and OUT atomically. The hook's setCommentRange
      // listener sets selectedTimestamp + selectedTimecodeEnd in one
      // shot, so the order-of-events race that broke setCommentOutPoint
      // (listener required selectedTimestamp to already be set) goes
      // away entirely.
      window.dispatchEvent(
        new CustomEvent('setCommentRange', {
          detail: {
            inTime: inT,
            outTime: safeOut,
            videoId,
          },
        }),
      )
      // Keep the timeline-click guard "fresh" during the whole drag so
      // iOS's post-release synthetic click can never reach
      // handleTimelineClick → re-seek.
      lastTouchAtRef.current = Date.now()
      // Scrub the underlying video so the user can see the exact frame
      // where OUT will land. The DISPLAYED white playhead is decoupled
      // via `displayedProgress` so it stays at IN.
      onSeek(safeOut)
    }
    const onUp = () => {
      // Stamp at release so the synthetic click iOS fires ~0-300 ms
      // later is suppressed by the timeline-click guard regardless of
      // drag duration.
      lastTouchAtRef.current = Date.now()
      // Clear the per-drag refs/state. The range that was just set
      // (pendingInTime + pendingOutTime, driven by the hook) keeps
      // both balls glued where they should be — see displayedProgress
      // and displayedOutPct.
      frozenPlayheadPctRef.current = null
      frozenInTimeRef.current = null
      setDragOutPct(null)
      setIsDraggingOutHandle(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
    document.addEventListener('touchcancel', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
      document.removeEventListener('touchcancel', onUp)
    }
  }, [isDraggingOutHandle, videoDuration, onSeek, videoFps])
  // Refs so the timeline-click handler doesn't have to re-create on
  // every range update.
  const pendingInRef = useRef<number | null>(null)
  const pendingOutRef = useRef<number | null>(null)
  useEffect(() => {
    pendingInRef.current = pendingInTime
    pendingOutRef.current = pendingOutTime
  }, [pendingInTime, pendingOutTime])
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      // Filter by videoId when provided so a stale event for a
      // different clip doesn't paint the wrong range.
      if (detail.videoId && videoId && detail.videoId !== videoId) return
      setPendingInTime(typeof detail.inTime === 'number' ? detail.inTime : null)
      setPendingOutTime(typeof detail.outTime === 'number' ? detail.outTime : null)
    }
    window.addEventListener('commentRangeStateChanged', onChange as EventListener)
    return () => {
      window.removeEventListener('commentRangeStateChanged', onChange as EventListener)
    }
  }, [videoId])

  // Process comments into markers
  const markers = useMemo((): MarkerData[] => {
    if (!videoDuration || videoDuration <= 0 || !comments.length) return []

    return comments
      .filter((comment) => {
        if (comment.parentId) return false
        if (videoId && comment.videoId !== videoId) return false
        // Allow 00:00:00:00 timecode - it's a valid timestamp at the start
        if (!comment.timecode) {
          return false
        }
        return true
      })
      .map((comment) => {
        // Prefer the precise sub-second capture moment (1.0.3+) so the
        // chip lines up exactly with the playhead after seek. Legacy
        // comments without `timestampMs` fall back to the frame-quantized
        // timecode-derived seconds.
        const preciseMs = (comment as any).timestampMs
        const rawTimestamp =
          typeof preciseMs === 'number' && Number.isFinite(preciseMs) && preciseMs >= 0
            ? preciseMs / 1000
            : timecodeToSeekSeconds(comment.timecode!, videoFps)
        // 1.3.2+: quantize to the nearest frame so the AVATAR position
        // (and the seek target used on click) match where the video
        // element actually parks after a seek. Browsers snap
        // video.currentTime to the closest frame boundary, so a
        // sub-frame timestamp like 4.123s would otherwise produce an
        // avatar at 4.123s but a playhead at 4.0833s (at 24 fps) — the
        // ~1.5 % horizontal gap the user noticed.
        const fps = videoFps && videoFps > 0 ? videoFps : 24
        const timestamp = Math.round(rawTimestamp * fps) / fps
        const effectiveAuthorName = comment.authorName ||
          ((comment as any).user?.name || (comment as any).user?.email || null)
        // Use isInternal from comment, default to false if not present (client comment)
        const isCommentInternal = (comment as any).isInternal ?? false
        const colorKey = getUserColor(effectiveAuthorName, isCommentInternal).border
        const rawContent = comment.content ?? ''
        const normalizedContent = rawContent.replace(/[<>]/g, ' ')

        // 2.5.1+: pick the first audio attachment off the comment
        // (voice messages are recorded one-at-a-time so realistically
        // there's only ever one). If none, audioAsset stays null.
        const assets: any[] = Array.isArray((comment as any).assets)
          ? (comment as any).assets
          : []
        const audio = assets.find(
          (a) =>
            a &&
            (a.category === 'audio' ||
              (typeof a.fileType === 'string' && a.fileType.startsWith('audio/'))),
        )

        return {
          id: comment.id,
          timestamp,
          authorName: effectiveAuthorName,
          initials: initialsFromName(effectiveAuthorName),
          colorKey,
          content: normalizedContent.slice(0, 100),
          position: Math.min(100, Math.max(0, (timestamp / videoDuration) * 100)),
          audioAsset: audio
            ? {
                id: String(audio.id),
                fileName: String(audio.fileName ?? 'voice.webm'),
                fileSize: String(audio.fileSize ?? '0'),
                fileType: String(audio.fileType ?? 'audio/webm'),
                category: audio.category ?? 'audio',
                createdAt: String(audio.createdAt ?? new Date().toISOString()),
              }
            : null,
        }
      })
      .sort((a, b) => a.timestamp - b.timestamp)
  }, [comments, videoDuration, videoFps, videoId])

  // Range bars for comments with timecodeEnd
  const rangeBars = useMemo((): RangeBarData[] => {
    if (!videoDuration || videoDuration <= 0 || !comments.length) return []

    return comments
      .filter((comment) => {
        if (comment.parentId) return false
        if (videoId && comment.videoId !== videoId) return false
        if (!comment.timecode || !(comment as any).timecodeEnd) return false
        return true
      })
      .map((comment) => {
        // 1.9.1+: mirror the EXACT same start-time computation the
        // marker (avatar) uses — prefer the precise `timestampMs`
        // when present, fall back to seek-seconds, then quantize to
        // the nearest frame. Without this, the range bar's left
        // edge can drift a fraction of a percent away from the
        // avatar's center because `timecodeToSeconds` and
        // `timecodeToSeekSeconds` round timecodes differently, and
        // legacy comments only have `timestampMs` set. The visual
        // result was a tiny gap between the avatar and the start
        // of the yellow strip — the user noticed it immediately.
        const fps = videoFps && videoFps > 0 ? videoFps : 24
        const preciseMs = (comment as any).timestampMs
        const rawStart =
          typeof preciseMs === 'number' && Number.isFinite(preciseMs) && preciseMs >= 0
            ? preciseMs / 1000
            : timecodeToSeekSeconds(comment.timecode!, videoFps)
        const start = Math.round(rawStart * fps) / fps
        const end = timecodeToSeconds((comment as any).timecodeEnd!, videoFps)
        const effectiveAuthorName = comment.authorName ||
          ((comment as any).user?.name || (comment as any).user?.email || null)
        const isCommentInternal = (comment as any).isInternal ?? false
        const colorKey = getUserColor(effectiveAuthorName, isCommentInternal).border

        return {
          id: comment.id,
          startPosition: Math.max(0, (start / videoDuration) * 100),
          endPosition: Math.min(100, (end / videoDuration) * 100),
          colorKey,
        }
      })
  }, [comments, videoDuration, videoFps, videoId])

  // Group markers that are close together
  const groupedMarkers = useMemo(() => {
    if (markers.length === 0) return []

    const groups: MarkerData[][] = []
    // Dynamic threshold based on video duration
    // For short videos (<60s): 3% threshold
    // For medium videos (60s-600s): 2% threshold  
    // For long videos (>600s): 1.5% threshold
    const threshold = videoDuration < 60 ? 3 : videoDuration < 600 ? 2 : 1.5

    markers.forEach((marker) => {
      const lastGroup = groups[groups.length - 1]
      if (lastGroup && Math.abs(marker.position - lastGroup[0].position) < threshold) {
        lastGroup.push(marker)
      } else {
        groups.push([marker])
      }
    })

    return groups
  }, [markers, videoDuration])

  // 1.3.2+: suppress the synthetic click that touch devices dispatch
  // after a touchend. On phones the playhead was jumping forward or
  // backward on tap because BOTH the touch handler AND a synthetic
  // click handler fired, each computing a slightly different X
  // coordinate. We mark "just touched" in `onTouchStart` and bail out
  // of the click handler for ~500 ms after that.
  const lastTouchAtRef = useRef<number>(0)

  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return
    // 1.9.0+: in range-edit mode the white playhead is locked —
    // only the yellow OUT handle responds to ←/→. Clicking the
    // timeline track must NOT scrub the video / move the white
    // ball. The yellow handle's own button has stopPropagation
    // on its mousedown, so dragging the yellow handle still works.
    if (isRangeEditActive()) return
    // Skip the synthetic click that fires right after a touch on
    // mobile — the touch handler already seeked to the right spot.
    if (Date.now() - lastTouchAtRef.current < 500) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration

    // 1.3.2+: clicking elsewhere on the timeline ALSO clears any
    // pending comment range — the white + yellow balls will then
    // overlap at the new playhead position, ready for the user to
    // grab the yellow ball again if they want to mark a new range.
    window.dispatchEvent(
      new CustomEvent('setCommentRange', {
        detail: { inTime: null, outTime: null, videoId },
      }),
    )
    onSeek(time)
  }, [videoDuration, onSeek, videoId])

  const handleTimelineMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 1.9.0+: same guard as handleTimelineClick — no scrubbing
    // while range-edit mode is active.
    if (isRangeEditActive()) return
    setIsDragging(true)
    handleTimelineClick(e)
  }, [handleTimelineClick])

  const handleTimelineTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return
    // 1.9.0+: lock the white playhead in range-edit mode.
    if (isRangeEditActive()) return
    setIsDragging(true)
    lastTouchAtRef.current = Date.now()

    const touch = e.touches[0]
    const rect = timelineRef.current.getBoundingClientRect()
    const x = touch.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration

    // Same as click: clear pending range + seek.
    window.dispatchEvent(
      new CustomEvent('setCommentRange', {
        detail: { inTime: null, outTime: null, videoId },
      }),
    )
    onSeek(time)
  }, [videoDuration, onSeek, videoId])

  const handleTimelineTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration || !isDragging) return
    lastTouchAtRef.current = Date.now()

    const touch = e.touches[0]
    const rect = timelineRef.current.getBoundingClientRect()
    const x = touch.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration

    // 1.1.1+: same — drag on the timeline just scrubs the playhead.
    onSeek(time)
  }, [isDragging, videoDuration, onSeek])

  const handleTimelineTouchEnd = useCallback(() => {
    setIsDragging(false)
    lastTouchAtRef.current = Date.now()
  }, [])

  const handleTimelineMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration

    setHoveredTime(time)

    if (isDragging) {
      // 1.1.1+: dragging the playhead on the timeline only scrubs.
      // The comment-range OUT point is set only when the user
      // grabs the dedicated orange handle (see the
      // `isDraggingOutHandle` effect above).
      onSeek(time)
    }
  }, [isDragging, videoDuration, onSeek])

  const handleTimelineMouseLeave = useCallback(() => {
    setHoveredTime(null)
  }, [])

  useEffect(() => {
    const handleMouseUp = () => {
      if (isDragging) {
        setIsDragging(false)
      }
    }

    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [isDragging])

  const handleMarkerClick = useCallback((marker: MarkerData, e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onSeek(marker.timestamp)
    // Notify parent to scroll to comment
    if (onMarkerClick) {
      onMarkerClick(marker.id)
    }
  }, [onSeek, onMarkerClick])

  const handleMarkerTouchEnd = useCallback((marker: MarkerData, e: React.TouchEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onSeek(marker.timestamp)
    // Notify parent to scroll to comment
    if (onMarkerClick) {
      onMarkerClick(marker.id)
    }
  }, [onSeek, onMarkerClick])

  // 1.3.1+: debounce the hover-close. The popover sits ~8 px above
  // the marker — when the mouse traverses that gap on its way from
  // the avatar to the popover, neither element is hovered for a
  // frame or two. Without a delay, `mouseleave` fires immediately
  // and the popover disappears before the mouse reaches it. Holding
  // the close for 220 ms gives the cursor time to land on the
  // popover and re-trigger `mouseenter`, which cancels the timer.
  const hoverCloseTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const handleMarkerMouseEnter = useCallback((markerId: string) => {
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current)
      hoverCloseTimeoutRef.current = null
    }
    // Fresh hover ⇒ reset stack pagination + slide direction so the
    // first card the user sees fades in normally instead of inheriting
    // a stale slide from a previous swipe gesture.
    setStackIndex(0)
    setStackSlideDir(null)
    setHoveredMarkerId(markerId)
  }, [])

  const handleMarkerMouseLeave = useCallback(() => {
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current)
    }
    hoverCloseTimeoutRef.current = setTimeout(() => {
      setHoveredMarkerId(null)
      hoverCloseTimeoutRef.current = null
    }, 220)
  }, [])

  const handleMarkerTouchStart = useCallback((markerId: string, e: React.TouchEvent) => {
    e.stopPropagation()
    // 1.3.1+: no auto-dismiss timeout — the popover stays open until
    // the user explicitly taps somewhere else (handled by the
    // global click-outside listener below).
    if (touchTimeoutRef.current) {
      clearTimeout(touchTimeoutRef.current)
    }
    // Fresh tap ⇒ same reset as the desktop mouse-enter path so the
    // first card the user sees fades in cleanly.
    setStackIndex(0)
    setStackSlideDir(null)
    setHoveredMarkerId(markerId)
  }, [])

  // 1.3.1+: dismiss the timeline-comment popover when the user taps
  // outside it (or any marker that owns one). Without this the
  // popover would have no exit on touch devices once we removed the
  // 3-second auto-close timer. We tag the popover and markers with
  // data-comment-popover so a single document listener can decide
  // whether the touch landed inside our UI.
  useEffect(() => {
    if (!hoveredMarkerId) return
    const onPointerDown = (e: PointerEvent | MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-comment-popover]')) return
      setHoveredMarkerId(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [hoveredMarkerId])

  const handleVolumeMouseEnter = useCallback(() => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current)
    }
    setShowVolume(true)
  }, [])

  const handleVolumeMouseLeave = useCallback(() => {
    volumeTimeoutRef.current = setTimeout(() => {
      setShowVolume(false)
    }, 500)
  }, [])

  // 1.9.1+: custom volume slider — drag/click handlers. Mirrors
  // the timeline pattern: clientX → % → onVolumeChange. Click +
  // drag are unified through the same path so dragging continues
  // smoothly even if the cursor leaves the track rect.
  const computeVolumeFromClientX = useCallback((clientX: number): number | null => {
    const rect = volumeTrackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    const x = clientX - rect.left
    return Math.max(0, Math.min(1, x / rect.width))
  }, [])

  const handleVolumePointerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const v = computeVolumeFromClientX(e.clientX)
    if (v !== null) onVolumeChange(v)
    setIsDraggingVolume(true)
  }, [computeVolumeFromClientX, onVolumeChange])

  useEffect(() => {
    if (!isDraggingVolume) return
    const onMove = (e: MouseEvent) => {
      const v = computeVolumeFromClientX(e.clientX)
      if (v !== null) onVolumeChange(v)
    }
    const onUp = () => setIsDraggingVolume(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDraggingVolume, computeVolumeFromClientX, onVolumeChange])

  const progress = videoDuration > 0 ? (currentTime / videoDuration) * 100 : 0
  // 1.3.2+: range-aware playhead positioning.
  //
  // WHITE BALL (IN marker):
  //  - while dragging the yellow OUT handle: stay at the snapshotted
  //    IN position (frozenPlayheadPctRef)
  //  - if a comment range is set (pendingInTime !== null but no drag):
  //    stay at the IN position
  //  - otherwise: follow the live playhead (`progress`)
  //
  // YELLOW BALL (OUT marker, always visible):
  //  - while dragging: live finger position (dragOutPct)
  //  - if a range is set: at the OUT position (pendingOutTime)
  //  - otherwise: directly on top of the white ball (= `progress`).
  //    This is the "rest" state Frame.io shows when nothing has
  //    been selected yet — a single combined IN/OUT marker.
  const inPctActive = pendingInTime !== null && videoDuration > 0
    ? Math.min(100, Math.max(0, (pendingInTime / videoDuration) * 100))
    : null
  const outPctActive = pendingOutTime !== null && videoDuration > 0
    ? Math.min(100, Math.max(0, (pendingOutTime / videoDuration) * 100))
    : null
  const displayedProgress =
    isDraggingOutHandle && frozenPlayheadPctRef.current !== null
      ? frozenPlayheadPctRef.current
      : inPctActive !== null
        ? inPctActive
        : progress
  const displayedOutPct =
    isDraggingOutHandle && dragOutPct !== null
      ? dragOutPct
      : outPctActive !== null
        ? outPctActive
        : progress

  const getTooltipAlignment = (position: number): string => {
    if (position < 20) return 'left-0'
    if (position > 80) return 'right-0'
    return 'left-1/2 -translate-x-1/2'
  }

  // 1.3.1+: desktop-only variant of `getTooltipAlignment`. Mobile gets
  // a full-width centred tooltip, so we only want the marker-position
  // alignment to kick in at sm:+. Tailwind needs literal class names
  // in the source to JIT-compile them — we list each one explicitly
  // here so they survive the build.
  const getTooltipAlignmentDesktop = (position: number): string => {
    if (position < 20) return 'sm:left-0'
    if (position > 80) return 'sm:right-0'
    return 'sm:left-1/2 sm:-translate-x-1/2'
  }

  return (
    // 2.5.1+: TRUE frosted glass — no in-bar accent radial; the
    // page's `.spotlight-bg-tr` wash (anchored top-right) supplies
    // the blue tint that bleeds through this translucent surface
    // via backdrop-filter. The bar itself stays neutral so it
    // doesn't compete with the page-level light source.
    <div
      className="px-2 sm:px-3 py-2 border-t border-white/10"
      style={{
        backgroundColor: 'rgba(30, 48, 72, 0.40)',
        backdropFilter: 'blur(32px) saturate(170%)',
        WebkitBackdropFilter: 'blur(32px) saturate(170%)',
      }}
    >
      {/* Timeline Container.
          1.9.1+: dropped the `px-1` that used to be here. The
          avatar row below already has `px-1`, but the avatar's
          containing block for `left: X%` is the FULL padding box
          (= row width), while the range-bar's containing block is
          `timelineRef`, which sits INSIDE the px-1 — so its width
          was 8 px less. Same X% ended up at different absolute
          positions, drifting up to 4 px at the timeline edges
          (avatar/range-bar misalignment the user noticed). By
          dropping px-1 here, timelineRef now spans the same width
          as the avatar row's padding box, and X% maps to the
          same absolute X on both. The outer container's
          `px-2 sm:px-3` still provides edge breathing room. */}
      <div className="mb-1.5 sm:mb-2">
        <div
          ref={timelineRef}
          // 1.9.0+: data-timeline-track lets the CommentInput's
          // click-outside detector skip the timeline (clicking the
          // timeline while in range-edit mode shouldn't exit it —
          // the user might be clicking to seek IN/OUT).
          data-timeline-track
          className="relative h-10 sm:h-12 group cursor-pointer touch-none"
          onMouseDown={handleTimelineMouseDown}
          onClick={handleTimelineClick}
          onMouseMove={handleTimelineMouseMove}
          onMouseLeave={handleTimelineMouseLeave}
          onTouchStart={handleTimelineTouchStart}
          onTouchMove={handleTimelineTouchMove}
          onTouchEnd={handleTimelineTouchEnd}
        >
          {/* Background Track.
              1.9.1+: Frame.io-style thin timeline — 3 px at rest,
              thickens to 6/8 px on hover so the bar reads as a
              hairline strip when the user isn't interacting with it
              and grows into a usable target on hover. The parent
              `group` is the tall click-area div above; `group-hover`
              cascades to every sibling, so the buffered fill,
              progress, range bars, pending range fill, and yellow
              handle all thicken in sync. transition-[height] keeps
              the change smooth. */}
          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-[3px] group-hover:h-1.5 sm:group-hover:h-2 bg-white/20 rounded-full overflow-hidden transition-[height] duration-150">
            {/* Buffered/Loaded (could be enhanced with actual buffer info) */}
            <div className="absolute inset-0 bg-white/30" />

            {/* Progress.
                1.9.1+: 200 ms linear transition matches the
                videoTimeUpdated throttle window in VideoPlayer
                (also 200 ms), so the blue fill interpolates
                continuously between samples instead of jumping in
                frame chunks. Linear (not ease) keeps the visual
                speed constant — anything cubic would look like the
                playback was speeding up/slowing down between
                samples. */}
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${displayedProgress}%`,
                backgroundColor: 'hsl(var(--spotlight-tint))',
                boxShadow: '0 0 8px hsl(var(--spotlight-tint) / 0.4)',
                transition: 'width 200ms linear',
              }}
            />
          </div>

          {/* Range Bars for comments with timecodeEnd.
              1.9.1+: positioned at the exact vertical level of the
              avatar centers in the row below, so the yellow strip
              runs THROUGH the avatar circles like a thread through
              beads — Frame.io convention. The avatars sit on top
              (z-50 vs the bar's default z-auto + later DOM order
              of the avatar row means avatars naturally render
              above).

              Y math: outer has py-2 (8 px top pad). timelineRef is
              h-10 / h-12 (40/48 px tall) immediately under that.
              Avatar row sits after with mb-1.5/2 + -mt-4/-18 so its
              top edge lands 38 px / 46 px below outer top
              (= 30/38 px below timelineRef top). Avatar is
              w-4 h-4 / w-[18px] h-[18px] (16/18 px) at top: 0 of
              the row, so its CENTER is at 38/47 px below
              timelineRef top.

              -translate-y-1/2 anchors the bar's center at the
              specified `top`, so the bar stays centred on the
              avatar even as its height transitions on hover. The
              bar will overflow timelineRef's bottom edge by design
              — that's the whole point.

              Uniformly yellow (warning), thin idle + slight
              thicken on group hover for symmetry with the track. */}
          {rangeBars.map((bar) => {
            const width = bar.endPosition - bar.startPosition
            return (
              <div
                key={`range-${bar.id}`}
                // 1.9.1+: stay HAIRLINE thin always — these are
                // comment markers, not part of the playback track,
                // so they shouldn't thicken when the user hovers
                // the timeline. (Earlier draft had group-hover
                // here so they grew with the main track; user
                // flagged it as noise.)
                className="absolute top-[38px] sm:top-[47px] -translate-y-1/2 h-[2px] rounded-full pointer-events-none bg-warning"
                style={{
                  left: `${bar.startPosition}%`,
                  width: `${Math.max(width, 0.5)}%`,
                  opacity: 0.9,
                }}
              />
            )
          })}

          {/* 1.3.2+: the inline dot/notch on the timeline track was
              removed at user request — only the colored avatar in
              the row below the timeline remains. The avatar still
              owns hover + click + touch handlers, so seek-to-comment
              and the hover popover keep working. */}

          {/* 1.3.2+: comment-range UI, fully rebuilt.
              - YELLOW BALL is always rendered, sitting directly on top
                of the WHITE playhead at `displayedOutPct` when there's
                no selection (which equals `progress`).
              - When the user grabs the yellow ball and drags it
                RIGHT, we snapshot IN = current playhead position and
                start dispatching `setCommentRange` events with both
                IN and OUT each frame. The yellow ball follows the
                finger; the white ball stays anchored at IN.
              - On release the range is saved (selectedTimestamp +
                selectedTimecodeEnd). The user can then type their
                comment with annotations; on submit it'll be stored
                with that range and re-displayed whenever the
                playhead crosses into [IN, OUT]. */}
          {videoDuration > 0 && (() => {
            const inPctActive2 = inPctActive
            const outPctActive2 = outPctActive
            // Yellow handle's actual displayed position (drag > saved
            // OUT > resting on white ball).
            const yellowPct = displayedOutPct
            return (
              <>
                {/* Range fill — visible only when a real IN/OUT range
                    has been set, OR while actively dragging. */}
                {((inPctActive2 !== null && outPctActive2 !== null &&
                    outPctActive2 > inPctActive2) ||
                  (isDraggingOutHandle && dragOutPct !== null &&
                    frozenPlayheadPctRef.current !== null &&
                    dragOutPct > frozenPlayheadPctRef.current)) && (
                  <div
                    // 1.9.1+: same thin-by-default + thicken-on-
                    // hover treatment as the background track and
                    // saved range bars. PLUS the 200 ms linear
                    // left/width transition so the live yellow
                    // fill glides during playback / range-edit
                    // arrow steps. Disabled during active drag
                    // (same reasoning as the yellow ball above:
                    // drag wants 1:1 cursor tracking).
                    className="absolute top-1/2 -translate-y-1/2 h-[3px] group-hover:h-1.5 sm:group-hover:h-2 bg-warning/70 rounded-full pointer-events-none z-15"
                    style={{
                      left: `${displayedProgress}%`,
                      width: `${Math.max(yellowPct - displayedProgress, 0.5)}%`,
                      transition: isDraggingOutHandle
                        ? 'height 150ms ease'
                        : 'left 200ms linear, width 200ms linear, height 150ms ease',
                    }}
                  />
                )}
                {/* Draggable YELLOW BALL — always visible, sits on top
                    of the white ball at rest. */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    lastTouchAtRef.current = Date.now()
                    // Snapshot the white ball's current position
                    // (where the playhead is RIGHT NOW) as IN. This
                    // is the moment the user "marks" their starting
                    // frame.
                    const nowProgress = progress
                    frozenPlayheadPctRef.current = nowProgress
                    frozenInTimeRef.current = currentTime
                    setDragOutPct(nowProgress)
                    setIsDraggingOutHandle(true)
                    // Pre-emit the range so the IN is captured even
                    // if the user releases without moving (a "tap"
                    // on the yellow ball with no drag still produces
                    // a single-frame selection at the current time).
                    window.dispatchEvent(
                      new CustomEvent('setCommentRange', {
                        detail: {
                          inTime: currentTime,
                          outTime: currentTime,
                          videoId,
                        },
                      }),
                    )
                  }}
                  onTouchStart={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    lastTouchAtRef.current = Date.now()
                    const nowProgress = progress
                    frozenPlayheadPctRef.current = nowProgress
                    frozenInTimeRef.current = currentTime
                    setDragOutPct(nowProgress)
                    setIsDraggingOutHandle(true)
                    window.dispatchEvent(
                      new CustomEvent('setCommentRange', {
                        detail: {
                          inTime: currentTime,
                          outTime: currentTime,
                          videoId,
                        },
                      }),
                    )
                  }}
                  className={`
                    absolute -top-1 sm:-top-1.5 z-40
                    w-3 h-3 sm:w-3.5 sm:h-3.5 rounded-full
                    bg-warning ring-2 ring-black/40
                    shadow-md cursor-ew-resize
                    hover:scale-110 active:scale-100
                    touch-none
                    ${isDraggingOutHandle ? 'scale-125 shadow-lg' : ''}
                  `}
                  // 1.9.1+: same 200ms linear `left` transition as
                  // the white playhead so the yellow handle glides
                  // smoothly during playback / range-edit arrow
                  // steps instead of jumping in frame chunks.
                  // IMPORTANT: disabled while the user is actively
                  // dragging — drag needs immediate 1:1 finger-
                  // tracking, the transition would feel like lag.
                  // Transform transition kept on a separate channel
                  // for the hover/drag scale effect.
                  style={{
                    left: `${yellowPct}%`,
                    transform: 'translateX(-50%)',
                    transition: isDraggingOutHandle
                      ? 'transform 150ms ease'
                      : 'left 200ms linear, transform 150ms ease',
                  }}
                  title="Drag right to mark the comment's end point"
                  aria-label="Drag to set comment out point"
                >
                  {/* 1.4.x: invisible hit-zone extension for phones —
                      makes the yellow ball easier to grab without
                      changing the ball's visual size or position.
                      Sits as an absolutely positioned overlay INSIDE
                      the button (so taps on it bubble to the button's
                      handlers), extending UPWARD only (so it never
                      overlaps the white playhead just below). Hidden
                      on `sm:+` (desktop), where the cursor doesn't
                      need the extra margin. The negative offsets push
                      the box out of the button's natural bounds; the
                      child `pointer-events: auto` is implicit because
                      the parent button isn't `pointer-events-none`. */}
                  <span
                    aria-hidden="true"
                    className="
                      sm:hidden absolute
                      -top-5 -left-3 -right-3 bottom-0
                    "
                  />
                </button>
              </>
            )
          })()}

          {/* Playhead. Uses `displayedProgress` (not raw `progress`)
              so it stays frozen at the IN position while the user is
              dragging the orange OUT handle — see comment on
              `displayedProgress` for the full rationale.
              1.9.0+: dims (opacity 40 %) while range-edit mode is
              active to signal that ←/→ now drives the yellow OUT
              handle, not the white playhead.
              1.9.1+: white circle replaced with a Frame.io-style
              thin vertical tick — 2 px wide, height matches the
              timeline track (3 px idle, 6/8 px on group hover) so
              the playhead reads as a clean hairline marker instead
              of a chunky disc. -translate-x-1/2 keeps the line
              centred on the playhead's exact X position. */}
          <div
            className={`absolute top-1/2 -translate-y-1/2 pointer-events-none z-20 ${
              rangeEditing ? 'opacity-40' : 'opacity-100'
            }`}
            // 1.9.1+: 200 ms linear transition on `left` so the
            // tick interpolates smoothly between videoTimeUpdated
            // samples (also throttled to 200 ms in VideoPlayer).
            // Without this, the playhead jumped 5-6 frames at a
            // time on shorter clips — visible as a tick that
            // "stutters" instead of tracking the playback head.
            // Opacity transition stays at 150 ms ease so the dim
            // when range-edit toggles still feels punchy.
            style={{
              left: `${displayedProgress}%`,
              transition: 'left 200ms linear, opacity 150ms ease',
            }}
          >
            <div className="w-[2px] h-[3px] group-hover:h-1.5 sm:group-hover:h-2 bg-white -translate-x-1/2 transition-[height] duration-150" />
          </div>

          {/* Hover Time Indicator — desktop only. On phones touch
              events fire mousemove synthetically when grabbing the
              yellow OUT handle, which would paint this badge in odd
              spots near the user's finger. The hover-scrub UX it
              serves doesn't translate to touch anyway, so we just
              hide it below `sm:`. */}
          {hoveredTime !== null && !isDragging && (
            <div
              className="hidden sm:block absolute bottom-full mb-2 px-2 py-1 bg-black/90 text-white text-xs font-mono rounded border border-white/20 shadow-lg whitespace-nowrap pointer-events-none"
              style={{
                left: `${(hoveredTime / videoDuration) * 100}%`,
                transform: 'translateX(-50%)',
              }}
            >
              {formatTime(hoveredTime)}
            </div>
          )}
        </div>
      </div>

      {/* Avatar Row (Frame.io-style):
          Identity chips for each comment, rendered BELOW the timeline so
          they don't visually fight with the playhead. Each avatar is
          positioned at the same horizontal % as its dot above. Click +
          hover behave like the old in-track chip — seek, scroll to
          comment, and surface the tooltip. */}
      {groupedMarkers.length > 0 && (
        // 1.3.2+: pull the avatar row UP with a negative margin so the
        // avatar sits the same distance BELOW the white playhead as
        // the yellow OUT handle sits ABOVE it (~18 px on mobile,
        // ~23 px on desktop). Without this the avatar drifted ~34 px
        // below the playhead because of the timeline div's tall empty
        // bottom half + the container's mb. The numbers were tuned by
        // measuring: yellow-ball center → white-ball center, then
        // mirroring that gap downward.
        <div className="relative h-6 sm:h-7 mb-1 sm:mb-2 px-1 -mt-4 sm:-mt-[18px]">
          {groupedMarkers.map((group, groupIndex) => {
            const primaryMarker = group[0]
            const colors = COLOR_MAP[primaryMarker.colorKey] || COLOR_MAP['border-gray-500']
            const isHovered = group.some((m) => m.id === hoveredMarkerId)
            const isStacked = group.length > 1

            return (
              <div
                key={`avatar-${primaryMarker.id}`}
                // 1.3.1+: lifts the marker AND its hover-popover above
                // the video's annotation overlay (z-10) and interactive
                // canvas (z-20). Without an explicit z here the wrapper
                // sits at z-auto and the annotation overlay paints
                // right on top of our popover even though the popover
                // has its own z-[200] inside.
                // 1.3.2+: bumped to z-50 so the wrapper also sits ABOVE
                // the yellow OUT handle (z-40) on the timeline. Before
                // this the orange/yellow ball at the start of the
                // timeline would visually clip into the popover's
                // top-left avatar.
                className="absolute top-0 pointer-events-auto z-50"
                style={{
                  left: `${primaryMarker.position}%`,
                  transform: 'translateX(-50%)',
                }}
                data-comment-popover
              >
                {/*
                  2.5.1+: glass v2.5 avatar — keep the saturated
                  user-colour identity but layer a soft white-glass
                  sheen on top so the chip reads as a frosted bead
                  rather than a flat dot. The colours.bg solid sits
                  behind, an overlay gradient + inset white highlight
                  on top, crisp white outer ring for the "stroke alb"
                  feel that the rest of the v2.5 system uses.
                  Slightly smaller text (8/9 px) per user request so
                  the bead feels more refined.
                */}
                {/*
                  2.5.1+: glass v2.5 avatar — keep the saturated
                  user-colour identity but layer a soft white-glass
                  sheen on top via an inner clipped wrapper. The
                  stacked-count badge MUST sit on the OUTER button
                  (no overflow clip there) so it can overflow the
                  avatar boundary and stay visible at -top-1 -right-1.
                */}
                <button
                  type="button"
                  ref={(el) => {
                    // 2.5.1+: register the avatar button so the
                    // portalled popover can read its viewport rect
                    // and position itself with `position: fixed`.
                    if (el) markerRefs.current.set(primaryMarker.id, el)
                    else markerRefs.current.delete(primaryMarker.id)
                  }}
                  onClick={(e) => handleMarkerClick(primaryMarker, e)}
                  onTouchEnd={(e) => handleMarkerTouchEnd(primaryMarker, e)}
                  onMouseEnter={() => handleMarkerMouseEnter(primaryMarker.id)}
                  onMouseLeave={handleMarkerMouseLeave}
                  onTouchStart={(e) => handleMarkerTouchStart(primaryMarker.id, e)}
                  className={`
                    relative flex items-center justify-center
                    w-4 h-4 sm:w-[18px] sm:h-[18px]
                    rounded-full
                    font-semibold select-none
                    transition-all duration-150 ease-out
                    hover:scale-110
                    active:scale-95
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-white
                    ${isHovered ? 'scale-110 z-30' : 'z-10'}
                  `}
                  aria-label={`Comment by ${primaryMarker.authorName || tComments('anonymous')} at ${formatTime(primaryMarker.timestamp)}`}
                >
                  {/* Inner glass disc — owns the colour, the rounded
                      clip and the gradient sheen. Badge lives OUTSIDE
                      this wrapper so it isn't clipped. */}
                  <span
                    aria-hidden
                    className={`absolute inset-0 rounded-full overflow-hidden ${colors.bg}`}
                    style={{
                      boxShadow: isHovered
                        ? 'inset 0 0 0 1px rgba(255,255,255,0.95), 0 0 0 2px rgba(0,0,0,0.4), 0 4px 14px rgba(0,0,0,0.45)'
                        : 'inset 0 0 0 1px rgba(255,255,255,0.85), 0 0 0 1px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.4)',
                    }}
                  >
                    {/* Translucent white sheen tilted from the
                        top-left, so the bead reads as a glass dome. */}
                    <span
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        backgroundImage:
                          'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.18) 45%, rgba(255,255,255,0) 75%)',
                        boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.18)',
                      }}
                    />
                  </span>
                  <span
                    className={`relative text-[8px] sm:text-[9px] font-semibold leading-none ${colors.text}`}
                    style={{
                      textShadow: '0 1px 1px rgba(0,0,0,0.35)',
                    }}
                  >
                    {primaryMarker.initials}
                  </span>

                  {isStacked && (
                    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 bg-white text-black text-[8px] font-bold rounded-full flex items-center justify-center shadow-md ring-1 ring-black/30 z-10">
                      {group.length}
                    </span>
                  )}
                </button>

                {/* Tooltip.
                    1.3.1+: on phones (`<sm`) the tooltip turns into a
                    Frame.io-style card that rises ABOVE the avatar row
                    (covering the timeline strip just above it) so it's
                    visible between the video player and the timeline,
                    matching what Frame.io does. Spans the full screen
                    width minus a small gutter, shows the FULL comment
                    body with no line-clamp.
                    On desktop the original compact tooltip above the
                    avatar is kept. */}
                {isHovered && popoverRect && typeof document !== 'undefined' && (() => {
                  // 2.5.1+: PORTAL to document.body. Backdrop-filter
                  // cannot sample <video> pixels when any ancestor
                  // creates a "backdrop root" (transform / filter /
                  // another backdrop-filter / etc.). The avatar
                  // wrapper has `transform: translateX(-50%)` and
                  // the CustomVideoControls bar has its own
                  // backdrop-filter — between them, the popover's
                  // backdrop was sampling an empty parent layer and
                  // the blur looked like plain transparency.
                  // Rendering via createPortal under document.body
                  // takes the popover out of every troublesome
                  // ancestor; position: fixed coords come straight
                  // from the avatar's getBoundingClientRect.
                  const isMobile = viewportWidth < 640
                  const POPOVER_W = isMobile
                    ? Math.min(360, viewportWidth - 80)
                    : 260
                  // Center on the avatar by default; clamp inside
                  // the viewport with an 8 px gutter so a marker at
                  // either edge doesn't push the card off-screen.
                  const avatarCenterX =
                    popoverRect.left + popoverRect.width / 2
                  let left = avatarCenterX - POPOVER_W / 2
                  if (isMobile) {
                    // Mobile: center the card on the viewport so a
                    // marker on the far side of a long video still
                    // shows a centered popover.
                    left = (viewportWidth - POPOVER_W) / 2
                  }
                  left = Math.max(
                    8,
                    Math.min(viewportWidth - POPOVER_W - 8, left),
                  )
                  // Position the popover ABOVE the avatar with a
                  // small gap. Mobile gets more breathing room so
                  // the user's finger doesn't sit under it.
                  const gap = isMobile ? 40 : 12
                  return createPortal(
                  <div
                    data-comment-popover
                    onMouseEnter={() => handleMarkerMouseEnter(primaryMarker.id)}
                    onMouseLeave={handleMarkerMouseLeave}
                    className="fixed z-[200] text-white ring-1 ring-white/15 rounded-2xl shadow-[0_18px_44px_-10px_rgba(0,0,0,0.75)] overflow-hidden p-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
                    style={{
                      left,
                      top: popoverRect.top - gap,
                      transform: 'translateY(-100%)',
                      width: POPOVER_W,
                      // Glass v2.5: 35 % navy base so the blurred
                      // video underneath reads clearly through it,
                      // accent radial in the top-left, then a
                      // strong backdrop blur. With the portal
                      // escaping every backdrop-root, the blur now
                      // actually samples the video pixels.
                      backgroundColor: 'rgba(20, 30, 46, 0.35)',
                      backgroundImage:
                        'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
                      backdropFilter: 'blur(28px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                    }}
                    // 1.3.2+: horizontal swipe navigation across the
                    // ENTIRE timeline (not just the current stack).
                    // The threshold is unchanged at 40 px; the only
                    // difference is that we no longer bail when the
                    // current group has a single comment — that
                    // gesture now jumps to the next / previous marker
                    // on the timeline, the popover re-anchors to it
                    // and the playhead seeks to its timecode.
                    // A short touch with |delta| < 40 px is treated
                    // as a TAP and also advances to the next comment
                    // (most users instinctively tap to "see what's
                    // next" before they think of swiping).
                    onTouchStart={(e) => {
                      swipeStartXRef.current = e.touches[0]?.clientX ?? null
                      // Stamp the touch so the onClick guard below
                      // can suppress the synthetic click iOS fires
                      // after touchend (otherwise the popover would
                      // advance twice on a single tap).
                      lastTouchAtRef.current = Date.now()
                    }}
                    onTouchEnd={(e) => {
                      const start = swipeStartXRef.current
                      swipeStartXRef.current = null
                      if (start == null) return
                      const end = e.changedTouches[0]?.clientX ?? start
                      const delta = end - start
                      const isSwipe = Math.abs(delta) >= 40
                      if (isSwipe) {
                        // Swipe walks across the ENTIRE timeline,
                        // jumping to the next/previous marker when
                        // it leaves the current stack.
                        const dir: 'next' | 'prev' = delta < 0 ? 'next' : 'prev'
                        goToAdjacentComment(
                          dir,
                          groupIndex,
                          stackIndex,
                          groupedMarkers,
                        )
                      } else {
                        // Tap = cycle WITHIN the current stack only,
                        // and only when there's actually more than
                        // one comment to cycle through. Walking onto
                        // a different timeline marker on a stray tap
                        // turned out to feel like a bug — the user
                        // is reading and accidentally jumps to a
                        // totally different point on the timeline.
                        // With a stack of 1 the tap does nothing.
                        if (group.length < 2) return
                        const nextWithin =
                          (stackIndex + 1) % group.length
                        // Reuse the stack-only helper so the
                        // animation + seek (none, same timecode)
                        // stay consistent with the swipe path.
                        setStackSlideDir('next')
                        setStackAnimSeq((s) => s + 1)
                        setStackIndex(nextWithin)
                      }
                    }}
                    // Desktop / non-touch clicks: same rule. Only
                    // cycle within the stack, only if multiple. The
                    // `lastTouchAtRef` guard keeps iOS from also
                    // firing this after the touchend just above.
                    onClick={() => {
                      if (Date.now() - lastTouchAtRef.current < 500) return
                      if (group.length < 2) return
                      const nextWithin = (stackIndex + 1) % group.length
                      setStackSlideDir('next')
                      setStackAnimSeq((s) => s + 1)
                      setStackIndex(nextWithin)
                    }}
                  >
                    {(() => {
                      // 1.3.1+: render ONE comment at a time. The
                      // current index is clamped against the group
                      // size in case the stack shrinks while open.
                      const safeIndex = Math.min(stackIndex, group.length - 1)
                      const marker = group[safeIndex]
                      const markerColors = COLOR_MAP[marker.colorKey] || COLOR_MAP['border-gray-500']
                      // 1.3.2+: pick a directional slide animation when
                      // the user paged from a previous card; on first
                      // open (`stackSlideDir === null`) just let the
                      // parent's fade-in handle the enter. The keyed
                      // remount uses the bump counter so consecutive
                      // taps on the same direction still re-animate.
                      // We use plain CSS keyframes (see globals.css:
                      // .stack-slide-in-{right,left}) instead of
                      // tailwindcss-animate's `slide-in-from-*-N` so
                      // the motion can't be silently dropped by JIT or
                      // an `overflow:hidden`/backdrop-root quirk.
                      const slideClass =
                        stackSlideDir === 'next'
                          ? 'stack-slide-in-right'
                          : stackSlideDir === 'prev'
                            ? 'stack-slide-in-left'
                            : ''
                      return (
                        <div
                          key={`${marker.id}:${stackAnimSeq}`}
                          className={slideClass}
                        >
                          {/* 2.5.1+: header row — avatar (glass dome,
                              same treatment as the timeline marker),
                              author name, stacked counter pill and
                              timestamp chip in glass v2.5 language. */}
                          <div className="flex items-center gap-2 mb-1.5 sm:mb-1">
                            <div
                              className={`relative w-6 h-6 sm:w-5 sm:h-5 rounded-full flex items-center justify-center font-semibold shrink-0 ${markerColors.bg}`}
                              style={{
                                boxShadow:
                                  'inset 0 0 0 1px rgba(255,255,255,0.85), 0 0 0 1px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.45)',
                              }}
                            >
                              <span
                                aria-hidden
                                className="absolute inset-0 rounded-full pointer-events-none"
                                style={{
                                  backgroundImage:
                                    'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.18) 45%, rgba(255,255,255,0) 75%)',
                                }}
                              />
                              <span
                                className={`relative text-[10px] sm:text-[9px] leading-none ${markerColors.text}`}
                                style={{
                                  textShadow: '0 1px 1px rgba(0,0,0,0.4)',
                                }}
                              >
                                {marker.initials}
                              </span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="font-semibold text-xs sm:text-[10px] text-white truncate block">
                                {marker.authorName || tComments('anonymous')}
                              </span>
                            </div>
                            {/* Stacked counter — glass pill.
                                2.5.1+: dropped the yellow timestamp
                                chip on the right per user request.
                                The popover only fires for stacked
                                groups in practice, so the counter
                                alone tells the user where they are. */}
                            {group.length > 1 && (
                              <span className="inline-flex items-center justify-center min-w-[30px] h-[18px] px-1.5 rounded-full bg-white/[0.10] ring-1 ring-white/15 text-white text-[10px] font-semibold tabular-nums shrink-0">
                                {safeIndex + 1}/{group.length}
                              </span>
                            )}
                          </div>
                          {/*
                            2.5.1+: voice comments show an inline
                            glass audio player instead of the
                            generic "No content" fallback. If the
                            comment ALSO has text we render both —
                            text first, then the player below.
                          */}
                          {marker.content ? (
                            <p className="pt-2.5 text-sm sm:text-xs text-white/90 leading-relaxed break-all sm:break-words whitespace-pre-wrap">
                              {marker.content}
                            </p>
                          ) : !marker.audioAsset ? (
                            <p className="pt-2.5 text-sm sm:text-xs text-white/55 italic leading-relaxed">
                              No content
                            </p>
                          ) : null}
                          {marker.audioAsset && (
                            <div
                              className="pt-2.5"
                              // 2.5.1+: stop all interaction events
                              // from bubbling to the popover's
                              // outer click / touch / swipe handlers.
                              // Without this, hitting Play (or
                              // grabbing the scrubber thumb) would
                              // also fire the popover's
                              // tap-to-advance, which unmounts the
                              // audio player mid-interaction and
                              // makes it look like the popover
                              // "disappeared". stopPropagation on
                              // both mousedown/click + touchstart/end
                              // covers desktop + mobile.
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onTouchStart={(e) => e.stopPropagation()}
                              onTouchEnd={(e) => e.stopPropagation()}
                            >
                              <AudioAttachment
                                asset={marker.audioAsset}
                                videoId={videoId}
                                shareToken={shareToken}
                              />
                            </div>
                          )}
                          {group.length > 1 && (
                            <p className="sm:hidden text-[10px] text-white/55 mt-2 text-center">
                              Tap or swipe to see other comments
                            </p>
                          )}
                          {/* 2.5.1+: Prev / Next — glass pills with a
                              soft outward shadow so they read as a
                              layer floating ABOVE the popover surface
                              (per the user's "umbra ca sa fie layer"
                              request). Brand-accent ring on hover so
                              the affordance pops without overpowering. */}
                          {group.length > 1 && (
                            <div className="hidden sm:flex items-center justify-between gap-2 mt-3 pt-3 border-t border-white/10">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  goToAdjacentComment(
                                    'prev',
                                    groupIndex,
                                    stackIndex,
                                    groupedMarkers,
                                  )
                                }}
                                className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.08] ring-1 ring-white/15 text-white hover:bg-white/[0.14] hover:ring-[hsl(var(--spotlight-tint)/0.45)] transition-colors shadow-[0_4px_12px_-4px_rgba(0,0,0,0.55)]"
                                aria-label="Previous comment"
                              >
                                ← Prev
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  goToAdjacentComment(
                                    'next',
                                    groupIndex,
                                    stackIndex,
                                    groupedMarkers,
                                  )
                                }}
                                className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.08] ring-1 ring-white/15 text-white hover:bg-white/[0.14] hover:ring-[hsl(var(--spotlight-tint)/0.45)] transition-colors shadow-[0_4px_12px_-4px_rgba(0,0,0,0.55)]"
                                aria-label="Next comment"
                              >
                                Next →
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>,
                  document.body
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}

      {/* Frame.io-style three-section control bar:
           LEFT  : transport (frame back, play/pause, frame forward),
                   speed selector, volume.
           CENTER: current/total time.
           RIGHT : quality badge, fullscreen.
          The whole bar lives BELOW the video (not as an overlay) and
          stays permanently visible. */}
      <div className="flex items-center gap-1 sm:gap-2 px-1">
        {/* LEFT GROUP */}
        <div className="flex items-center gap-0.5 sm:gap-1 flex-1 min-w-0">
          <button
            onClick={onPlayPause}
            className="p-2 hover:bg-white/[0.10] active:bg-white/[0.18] rounded-md transition-colors touch-manipulation text-white/85 hover:text-white"
            aria-label={isPlaying ? t('pauseVideo') : t('playVideo')}
            title={isPlaying ? `${t('pauseVideo')} (Ctrl+Space)` : `${t('playVideo')} (Ctrl+Space)`}
          >
            {isPlaying ? (
              <Pause className="w-5 h-5 text-white fill-white" />
            ) : (
              <Play className="w-5 h-5 text-white fill-white" />
            )}
          </button>

          <button
            onClick={() => onFrameStep('backward')}
            className="hidden sm:inline-flex p-2 hover:bg-white/10 active:bg-white/20 rounded-md transition-colors touch-manipulation"
            aria-label={t('previousFrame')}
            title={`${t('previousFrame')} (Ctrl+J)`}
          >
            <SkipBack className="w-4 h-4 text-white" />
          </button>

          <button
            onClick={() => onFrameStep('forward')}
            className="hidden sm:inline-flex p-2 hover:bg-white/10 active:bg-white/20 rounded-md transition-colors touch-manipulation"
            aria-label={t('nextFrame')}
            title={`${t('nextFrame')} (Ctrl+L)`}
          >
            <SkipForward className="w-4 h-4 text-white" />
          </button>

          {/* Playback speed selector — hidden when the parent doesn't pass a
              setter (e.g. comparison view) */}
          {onPlaybackSpeedChange && (
            <PlaybackSpeedMenu
              value={playbackSpeed ?? 1}
              onChange={onPlaybackSpeedChange}
              className="ml-0.5 sm:ml-1"
            />
          )}

          {/* Volume: button always; slider expands on hover (or stays open
              while interacted with via keyboard). On mobile the slider is
              hidden — tap the icon to mute/unmute. */}
          <div
            className="relative flex items-center"
            onMouseEnter={handleVolumeMouseEnter}
            onMouseLeave={handleVolumeMouseLeave}
          >
            <button
              onClick={onToggleMute}
              className="p-2 hover:bg-white/[0.10] active:bg-white/[0.18] rounded-md transition-colors touch-manipulation text-white/85 hover:text-white"
              aria-label={isMuted ? t('unmute') : t('mute')}
              title={isMuted ? t('unmute') : t('mute')}
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-white" />
              ) : (
                <Volume2 className="w-4 h-4 text-white" />
              )}
            </button>
            {/* 1.9.1+: custom div-based volume slider. Replaces the
                old native <input type=range> because native sliders
                don't let us transition the thumb position, and the
                user wanted the same smooth glide as the playhead.
                Track + fill + thumb mirror the timeline pattern;
                drag/click handlers route through onVolumeChange so
                the audio updates exactly like before. The wrapper
                fades + slides on showVolume just like the previous
                input did. Hidden on mobile — tap icon mutes. */}
            {/*
              2.5.1+ FIX: the slider was unhittable because the thin
              3 px track is the only mouseDown target — at volume = 1
              half the thumb sits OUTSIDE the track's bounds, and the
              thumb itself had `pointer-events-none`. Now the OUTER
              wrapper owns the click/drag handler and provides a
              taller (h-5) invisible hit area, while the thin track
              + fill + thumb live inside as visual children. Thumb
              still computes its position from the inner track ref so
              the math is unchanged. The wrapper width is what fades
              in/out — the inner ref stays a stable element.
            */}
            <div
              onMouseDown={handleVolumePointerDown}
              className={`hidden sm:flex items-center h-5 cursor-pointer transition-[width,opacity,margin] duration-200 ease-out ${
                showVolume
                  ? 'w-20 opacity-100 pointer-events-auto ml-1'
                  : 'w-0 opacity-0 pointer-events-none ml-0'
              }`}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={isMuted ? 0 : volume}
              aria-label="Volume"
              tabIndex={showVolume ? 0 : -1}
            >
              <div
                ref={volumeTrackRef}
                className="relative h-[3px] w-full rounded-full bg-white/15"
              >
                {/* Accent-tinted fill, follows --spotlight-tint. */}
                <div
                  className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
                  style={{
                    width: `${(isMuted ? 0 : volume) * 100}%`,
                    backgroundColor: 'hsl(var(--spotlight-tint))',
                    boxShadow: '0 0 6px hsl(var(--spotlight-tint) / 0.45)',
                    transition: isDraggingVolume
                      ? 'none'
                      : 'width 200ms linear',
                  }}
                />
                {/*
                  Glass thumb — translucent WHITE-dominant interior
                  + crisp white stroke. Higher base opacity (0.55)
                  than the audio scrubber thumb so it still reads as
                  glass even when the accent fill sits directly
                  behind it; on the audio player the thumb sits on
                  a near-black card so 0.18 was enough.
                */}
                <div
                  className="absolute top-1/2 w-3.5 h-3.5 rounded-full pointer-events-none"
                  style={{
                    left: `${(isMuted ? 0 : volume) * 100}%`,
                    transform: 'translate(-50%, -50%)',
                    backgroundColor: 'rgba(255, 255, 255, 0.55)',
                    border: '1.5px solid rgba(255, 255, 255, 0.98)',
                    backdropFilter: 'blur(6px) saturate(140%)',
                    WebkitBackdropFilter: 'blur(6px) saturate(140%)',
                    boxShadow:
                      '0 0 0 1px hsl(var(--spotlight-tint) / 0.35), 0 2px 8px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
                    transition: isDraggingVolume
                      ? 'none'
                      : 'left 200ms linear',
                  }}
                />
              </div>
            </div>

          </div>
        </div>

        {/* CENTER: time */}
        <div className="text-white/85 text-xs sm:text-sm font-mono tabular-nums whitespace-nowrap shrink-0">
          {formatTimeWithMode(currentTime, videoFps, videoDuration, timestampDisplayMode)}
          <span className="text-white/40"> / </span>
          {formatTimeWithMode(videoDuration, videoFps, videoDuration, timestampDisplayMode)}
        </div>

        {/* RIGHT GROUP */}
        <div className="flex items-center gap-0.5 sm:gap-1 flex-1 justify-end min-w-0">
          {/* 1.3.2+: Settings popup (gear) — replaces the old read-only
              SD/HD/4K quality badge. Now houses Quality switcher, Guides
              (social safe-zones), Rulers (Photoshop-style draggable
              guide lines) and Download Still. Falls back to the old
              read-only badge only when the parent doesn't wire up the
              quality-change callback (e.g. comparison view). */}
          {onQualityChoiceChange &&
           onGuidesPresetChange &&
           onRulersEnabledChange &&
           onDownloadStill ? (
            <PlayerSettingsMenu
              availableQualities={availableQualities || []}
              pendingQualities={pendingQualities}
              quality={qualityChoice || 'auto'}
              onQualityChange={onQualityChoiceChange}
              resolvedQuality={resolvedPlaybackQuality || null}
              guides={guidesPreset || 'off'}
              onGuidesChange={onGuidesPresetChange}
              rulers={!!rulersEnabled}
              onRulersChange={onRulersEnabledChange}
              onDownloadStill={onDownloadStill}
            />
          ) : (
            resolvedPlaybackQuality && (
              <span
                className="hidden sm:inline-flex items-center px-1.5 h-5 rounded text-[10px] font-bold tracking-wide bg-white/10 text-white/80 ring-1 ring-white/15"
                title={`Streaming ${resolvedPlaybackQuality}`}
              >
                {resolvedPlaybackQuality === '2160p' ? '4K' :
                 resolvedPlaybackQuality === '1080p' ? 'HD' : 'SD'}
              </span>
            )
          )}

          <button
            onClick={onToggleFullscreen}
            className="p-2 hover:bg-white/[0.10] active:bg-white/[0.18] rounded-md transition-colors touch-manipulation text-white/85 hover:text-white"
            aria-label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
            title={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
          >
            {isFullscreen ? (
              <Minimize className="w-4 h-4 text-white" />
            ) : (
              <Maximize className="w-4 h-4 text-white" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
