'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward } from 'lucide-react'
import { getUserColor } from '@/lib/utils'
import { timecodeToSeconds, timecodeToSeekSeconds, secondsToTimecode, formatCommentTimestamp } from '@/lib/timecode'
import PlaybackSpeedMenu from './PlaybackSpeedMenu'

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
  resolvedPlaybackQuality?: '720p' | '1080p' | '2160p'
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
}: CustomVideoControlsProps) {
  const t = useTranslations('controls')
  const tComments = useTranslations('comments')
  const [isDragging, setIsDragging] = useState(false)
  const [showVolume, setShowVolume] = useState(false)
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [hoveredTime, setHoveredTime] = useState<number | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const volumeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const touchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

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
      const inT = pendingInRef.current
      // Snap drag to whole frames — quantize to multiples of 1/fps —
      // so you can land on clean cuts as you drag instead of picking
      // some arbitrary millisecond between frames.
      const fps = videoFps && videoFps > 0 ? videoFps : 24
      const quantized = Math.round(time * fps) / fps
      // The out point must stay strictly past in. We use one frame
      // (1/fps) as the floor so the smallest valid range is one frame
      // long — matching the "single-frame selection" semantics the
      // user expects right after clicking the input.
      const minGap = 1 / fps
      const safeOut =
        inT !== null ? Math.max(quantized, inT + minGap) : quantized
      window.dispatchEvent(
        new CustomEvent('setCommentOutPoint', { detail: { time: safeOut } })
      )
      // Scrub the video to the current drag position too, so the user
      // sees the exact frame the OUT will land on as they drag.
      onSeek(safeOut)
    }
    const onUp = () => setIsDraggingOutHandle(false)
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
        const timestamp =
          typeof preciseMs === 'number' && Number.isFinite(preciseMs) && preciseMs >= 0
            ? preciseMs / 1000
            : timecodeToSeekSeconds(comment.timecode!, videoFps)
        const effectiveAuthorName = comment.authorName ||
          ((comment as any).user?.name || (comment as any).user?.email || null)
        // Use isInternal from comment, default to false if not present (client comment)
        const isCommentInternal = (comment as any).isInternal ?? false
        const colorKey = getUserColor(effectiveAuthorName, isCommentInternal).border
        const rawContent = comment.content ?? ''
        const normalizedContent = rawContent.replace(/[<>]/g, ' ')

        return {
          id: comment.id,
          timestamp,
          authorName: effectiveAuthorName,
          initials: initialsFromName(effectiveAuthorName),
          colorKey,
          content: normalizedContent.slice(0, 100),
          // Don't clamp the position — playhead isn't clamped either, so
          // clamping the chip would visibly desync them. We accept that
          // chips at the very edges might be half-cropped; the click
          // target on the visible half remains hover-able.
          position: Math.min(100, Math.max(0, (timestamp / videoDuration) * 100)),
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
        const start = timecodeToSeconds(comment.timecode!, videoFps)
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

  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration

    // 1.1.1+: clicking the timeline just seeks now. Creating a
    // comment range is reserved for the dedicated orange handle —
    // the previous behaviour (any click past the IN point silently
    // set an OUT) made it impossible to seek inside the marked
    // range without accidentally clobbering the comment selection.
    onSeek(time)
  }, [videoDuration, onSeek])

  const handleTimelineMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true)
    handleTimelineClick(e)
  }, [handleTimelineClick])

  const handleTimelineTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return
    setIsDragging(true)

    const touch = e.touches[0]
    const rect = timelineRef.current.getBoundingClientRect()
    const x = touch.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration

    // 1.1.1+: touch on timeline just seeks. Comment-range OUT is
    // set only by dragging the orange handle.
    onSeek(time)
  }, [videoDuration, onSeek])

  const handleTimelineTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration || !isDragging) return

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

  const handleMarkerMouseEnter = useCallback((markerId: string) => {
    setHoveredMarkerId(markerId)
  }, [])

  const handleMarkerMouseLeave = useCallback(() => {
    setHoveredMarkerId(null)
  }, [])

  const handleMarkerTouchStart = useCallback((markerId: string, e: React.TouchEvent) => {
    e.stopPropagation()
    if (touchTimeoutRef.current) {
      clearTimeout(touchTimeoutRef.current)
    }
    setHoveredMarkerId(markerId)
    touchTimeoutRef.current = setTimeout(() => {
      setHoveredMarkerId(null)
    }, 3000)
  }, [])

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

  const progress = videoDuration > 0 ? (currentTime / videoDuration) * 100 : 0

  const getTooltipAlignment = (position: number): string => {
    if (position < 20) return 'left-0'
    if (position > 80) return 'right-0'
    return 'left-1/2 -translate-x-1/2'
  }

  return (
    <div className="bg-black px-2 sm:px-3 py-2">
      {/* Timeline Container */}
      <div className="mb-1.5 sm:mb-2 px-1">
        <div
          ref={timelineRef}
          className="relative h-10 sm:h-12 group cursor-pointer touch-none"
          onMouseDown={handleTimelineMouseDown}
          onClick={handleTimelineClick}
          onMouseMove={handleTimelineMouseMove}
          onMouseLeave={handleTimelineMouseLeave}
          onTouchStart={handleTimelineTouchStart}
          onTouchMove={handleTimelineTouchMove}
          onTouchEnd={handleTimelineTouchEnd}
        >
          {/* Background Track */}
          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 sm:h-2 bg-white/20 rounded-full overflow-hidden">
            {/* Buffered/Loaded (could be enhanced with actual buffer info) */}
            <div className="absolute inset-0 bg-white/30" />
            
            {/* Progress */}
            <div
              className="absolute inset-y-0 left-0 bg-primary transition-all duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Range Bars for comments with timecodeEnd */}
          {rangeBars.map((bar) => {
            const colors = COLOR_MAP[bar.colorKey] || COLOR_MAP['border-gray-500']
            const width = bar.endPosition - bar.startPosition
            return (
              <div
                key={`range-${bar.id}`}
                className={`absolute top-1/2 -translate-y-1/2 h-1.5 sm:h-2 rounded-full pointer-events-none ${colors.bg}`}
                style={{
                  left: `${bar.startPosition}%`,
                  width: `${Math.max(width, 0.5)}%`,
                  opacity: 0.85,
                }}
              />
            )
          })}

          {/* Inline comment dots on the timeline (Frame.io-style):
              tiny solid notches in the user's colour, fully opaque. The
              full author + content tooltip lives on the avatar row below;
              clicking a dot still seeks for users who land on it. */}
          {groupedMarkers.map((group) => {
            const primaryMarker = group[0]
            const colors = COLOR_MAP[primaryMarker.colorKey] || COLOR_MAP['border-gray-500']
            const isHovered = group.some((m) => m.id === hoveredMarkerId)
            return (
              <button
                key={`dot-${primaryMarker.id}`}
                type="button"
                onClick={(e) => handleMarkerClick(primaryMarker, e)}
                onTouchEnd={(e) => handleMarkerTouchEnd(primaryMarker, e)}
                onMouseEnter={() => handleMarkerMouseEnter(primaryMarker.id)}
                onMouseLeave={handleMarkerMouseLeave}
                className={`
                  absolute top-1/2 pointer-events-auto
                  w-1 h-3 sm:h-3.5 rounded-full
                  ${colors.bg} ${colors.ring} ring-1 ring-inset
                  shadow-sm
                  transition-transform duration-150 ease-out
                  hover:scale-y-125
                  ${isHovered ? 'scale-y-125 z-30' : 'z-10'}
                `}
                style={{
                  left: `${primaryMarker.position}%`,
                  transform: 'translateX(-50%) translateY(-50%)',
                }}
                aria-label={`Comment by ${primaryMarker.authorName || tComments('anonymous')} at ${formatTime(primaryMarker.timestamp)}`}
              />
            )
          })}

          {/* Pending in/out range for the comment composer
              (Frame.io-style). Painted only while the user has focused
              the comment input. With OUT unset (single-frame selection)
              we still render a draggable handle at the IN position so
              the user can pull a range when they want one. */}
          {pendingInTime !== null && videoDuration > 0 && (() => {
            const inPct = Math.min(100, Math.max(0, (pendingInTime / videoDuration) * 100))
            const outPct =
              pendingOutTime !== null
                ? Math.min(100, Math.max(0, (pendingOutTime / videoDuration) * 100))
                : null
            // Handle sits at OUT when set, otherwise sits AT IN so the
            // user has something to grab even on a fresh click.
            const handlePct = outPct !== null ? outPct : inPct
            return (
              <>
                {/* Range fill (only when out is set) */}
                {outPct !== null && outPct > inPct && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 h-1.5 sm:h-2 bg-warning/70 rounded-full pointer-events-none z-15"
                    style={{
                      left: `${inPct}%`,
                      width: `${Math.max(outPct - inPct, 0.5)}%`,
                    }}
                  />
                )}
                {/* IN bracket */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-25"
                  style={{ left: `${inPct}%` }}
                  aria-hidden
                >
                  <div className="w-0.5 h-5 sm:h-6 bg-warning shadow-[0_0_4px_rgba(0,0,0,0.5)] -translate-x-1/2" />
                </div>
                {/* OUT bracket */}
                {outPct !== null && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-25"
                    style={{ left: `${outPct}%` }}
                    aria-hidden
                  >
                    <div className="w-0.5 h-5 sm:h-6 bg-warning shadow-[0_0_4px_rgba(0,0,0,0.5)] -translate-x-1/2" />
                  </div>
                )}
                {/* Draggable handle above the timeline. Always rendered
                    when there's a pending IN, even with no OUT yet — it
                    sits on the IN point and the user pulls it right to
                    open up a range. Drags snap to whole frames so you
                    can hit a clean cut. */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDraggingOutHandle(true)
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation()
                    setIsDraggingOutHandle(true)
                  }}
                  className={`
                    absolute -top-1 sm:-top-1.5 z-30
                    w-3 h-3 sm:w-3.5 sm:h-3.5 rounded-full
                    bg-warning ring-2 ring-black/40
                    shadow-md cursor-ew-resize
                    hover:scale-110 active:scale-100
                    transition-transform
                    ${isDraggingOutHandle ? 'scale-125 shadow-lg' : ''}
                  `}
                  style={{
                    left: `${handlePct}%`,
                    transform: 'translateX(-50%)',
                  }}
                  title="Drag right to extend the comment range"
                  aria-label="Drag to set comment out point"
                />
              </>
            )
          })()}

          {/* Playhead */}
          <div
            className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-20"
            style={{ left: `${progress}%` }}
          >
            <div className="w-4 h-4 sm:w-5 sm:h-5 bg-white rounded-full shadow-lg border-2 border-primary -translate-x-1/2 group-hover:scale-110 transition-transform" />
          </div>

          {/* Hover Time Indicator */}
          {hoveredTime !== null && !isDragging && (
            <div
              className="absolute bottom-full mb-2 px-2 py-1 bg-black/90 text-white text-xs font-mono rounded border border-white/20 shadow-lg whitespace-nowrap pointer-events-none"
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
        <div className="relative h-6 sm:h-7 mb-1 sm:mb-2 px-1">
          {groupedMarkers.map((group) => {
            const primaryMarker = group[0]
            const colors = COLOR_MAP[primaryMarker.colorKey] || COLOR_MAP['border-gray-500']
            const isHovered = group.some((m) => m.id === hoveredMarkerId)
            const isStacked = group.length > 1

            return (
              <div
                key={`avatar-${primaryMarker.id}`}
                className="absolute top-0 pointer-events-auto"
                style={{
                  left: `${primaryMarker.position}%`,
                  transform: 'translateX(-50%)',
                }}
              >
                <button
                  type="button"
                  onClick={(e) => handleMarkerClick(primaryMarker, e)}
                  onTouchEnd={(e) => handleMarkerTouchEnd(primaryMarker, e)}
                  onMouseEnter={() => handleMarkerMouseEnter(primaryMarker.id)}
                  onMouseLeave={handleMarkerMouseLeave}
                  onTouchStart={(e) => handleMarkerTouchStart(primaryMarker.id, e)}
                  className={`
                    relative flex items-center justify-center
                    w-4 h-4 sm:w-[18px] sm:h-[18px]
                    rounded-full ring-1
                    font-semibold select-none
                    transition-all duration-150 ease-out
                    hover:scale-110
                    active:scale-95
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-white
                    ${colors.bg} ${colors.ring} ${colors.text}
                    ${isHovered ? 'scale-110 shadow-xl z-30' : 'z-10'}
                  `}
                  aria-label={`Comment by ${primaryMarker.authorName || tComments('anonymous')} at ${formatTime(primaryMarker.timestamp)}`}
                >
                  <span className="text-[9px] sm:text-[10px] font-semibold leading-none">
                    {primaryMarker.initials}
                  </span>

                  {isStacked && (
                    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 bg-foreground text-background text-[8px] font-bold rounded-full flex items-center justify-center shadow-md">
                      {group.length}
                    </span>
                  )}
                </button>

                {/* Tooltip */}
                {isHovered && (
                  <div
                    className={`
                      absolute bottom-full mb-2 ${getTooltipAlignment(primaryMarker.position)}
                      bg-black/95 text-white backdrop-blur-sm
                      rounded-lg shadow-2xl
                      p-2 w-[180px] sm:w-[220px] max-w-[calc(100vw-2rem)]
                      z-50
                      animate-in fade-in-0 slide-in-from-bottom-1 duration-150
                    `}
                  >
                    {group.slice(0, 3).map((marker, idx) => {
                      const markerColors = COLOR_MAP[marker.colorKey] || COLOR_MAP['border-gray-500']
                      return (
                        <div
                          key={marker.id}
                          className={`${idx > 0 ? 'mt-2 pt-2 border-t border-white/20' : ''}`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <div
                              className={`w-5 h-5 rounded-full ring-1 flex items-center justify-center text-[8px] font-semibold ${markerColors.bg} ${markerColors.ring} ${markerColors.text}`}
                            >
                              {marker.initials}
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="font-semibold text-[10px] text-white truncate block">
                                {marker.authorName || tComments('anonymous')}
                              </span>
                            </div>
                            <span className="text-[9px] text-white/70 font-mono">
                              {formatTime(marker.timestamp)}
                            </span>
                          </div>
                          <p className="text-[10px] text-white/80 leading-relaxed line-clamp-2 pl-6">
                            {marker.content || 'No content'}
                          </p>
                        </div>
                      )
                    })}
                    {group.length > 3 && (
                      <p className="text-[9px] text-white/60 mt-2 pt-2 border-t border-white/20">
                        {t('moreComments', { count: group.length - 3 })}
                      </p>
                    )}
                  </div>
                )}
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
            className="p-2 hover:bg-white/10 active:bg-white/20 rounded-md transition-colors touch-manipulation"
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
              className="p-2 hover:bg-white/10 active:bg-white/20 rounded-md transition-colors touch-manipulation"
              aria-label={isMuted ? t('unmute') : t('mute')}
              title={isMuted ? t('unmute') : t('mute')}
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-white" />
              ) : (
                <Volume2 className="w-4 h-4 text-white" />
              )}
            </button>
            {showVolume && (
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                className="hidden sm:block h-1 w-20 cursor-pointer accent-primary"
                aria-label="Volume"
              />
            )}
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
          {/* Quality badge — read-only for now; v1.0.4 ships without a
              quality switcher. Value comes from the resolved stream URL
              (720p / 1080p / 2160p). */}
          {resolvedPlaybackQuality && (
            <span
              className="hidden sm:inline-flex items-center px-1.5 h-5 rounded text-[10px] font-bold tracking-wide bg-white/10 text-white/80 ring-1 ring-white/15"
              title={`Streaming ${resolvedPlaybackQuality}`}
            >
              {resolvedPlaybackQuality === '2160p' ? '4K' :
               resolvedPlaybackQuality === '1080p' ? 'HD' : 'SD'}
            </span>
          )}

          <button
            onClick={onToggleFullscreen}
            className="p-2 hover:bg-white/10 active:bg-white/20 rounded-md transition-colors touch-manipulation"
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
