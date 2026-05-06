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

// Color map for marker backgrounds - IDENTICAL to InitialsAvatar component
const COLOR_MAP: Record<string, { bg: string; ring: string; text: string }> = {
  'border-gray-500': {
    bg: 'bg-gray-500/20 dark:bg-gray-500/30',
    ring: 'ring-gray-500/30',
    text: 'text-gray-700 dark:text-gray-100',
  },
  'border-red-500': {
    bg: 'bg-red-500/20 dark:bg-red-500/30',
    ring: 'ring-red-500/30',
    text: 'text-red-700 dark:text-red-100',
  },
  'border-orange-500': {
    bg: 'bg-orange-500/20 dark:bg-orange-500/30',
    ring: 'ring-orange-500/30',
    text: 'text-orange-700 dark:text-orange-100',
  },
  'border-amber-500': {
    bg: 'bg-amber-500/20 dark:bg-amber-500/30',
    ring: 'ring-amber-500/30',
    text: 'text-amber-800 dark:text-amber-100',
  },
  'border-yellow-400': {
    bg: 'bg-yellow-400/25 dark:bg-yellow-400/30',
    ring: 'ring-yellow-400/30',
    text: 'text-yellow-900 dark:text-yellow-100',
  },
  'border-lime-500': {
    bg: 'bg-lime-500/20 dark:bg-lime-500/30',
    ring: 'ring-lime-500/30',
    text: 'text-lime-800 dark:text-lime-100',
  },
  'border-green-500': {
    bg: 'bg-green-500/20 dark:bg-green-500/30',
    ring: 'ring-green-500/30',
    text: 'text-green-800 dark:text-green-100',
  },
  'border-emerald-500': {
    bg: 'bg-emerald-500/20 dark:bg-emerald-500/30',
    ring: 'ring-emerald-500/30',
    text: 'text-emerald-800 dark:text-emerald-100',
  },
  'border-pink-500': {
    bg: 'bg-pink-500/20 dark:bg-pink-500/30',
    ring: 'ring-pink-500/30',
    text: 'text-pink-800 dark:text-pink-100',
  },
  'border-rose-500': {
    bg: 'bg-rose-500/20 dark:bg-rose-500/30',
    ring: 'ring-rose-500/30',
    text: 'text-rose-800 dark:text-rose-100',
  },
  'border-fuchsia-500': {
    bg: 'bg-fuchsia-500/20 dark:bg-fuchsia-500/30',
    ring: 'ring-fuchsia-500/30',
    text: 'text-fuchsia-800 dark:text-fuchsia-100',
  },
  'border-teal-500': {
    bg: 'bg-teal-500/20 dark:bg-teal-500/30',
    ring: 'ring-teal-500/30',
    text: 'text-teal-800 dark:text-teal-100',
  },
  'border-cyan-500': {
    bg: 'bg-cyan-500/20 dark:bg-cyan-500/30',
    ring: 'ring-cyan-500/30',
    text: 'text-cyan-800 dark:text-cyan-100',
  },
  'border-sky-500': {
    bg: 'bg-sky-500/20 dark:bg-sky-500/30',
    ring: 'ring-sky-500/30',
    text: 'text-sky-800 dark:text-sky-100',
  },
  'border-blue-500': {
    bg: 'bg-blue-500/20 dark:bg-blue-500/30',
    ring: 'ring-blue-500/30',
    text: 'text-blue-800 dark:text-blue-100',
  },
  'border-indigo-500': {
    bg: 'bg-indigo-500/20 dark:bg-indigo-500/30',
    ring: 'ring-indigo-500/30',
    text: 'text-indigo-800 dark:text-indigo-100',
  },
  'border-violet-500': {
    bg: 'bg-violet-500/20 dark:bg-violet-500/30',
    ring: 'ring-violet-500/30',
    text: 'text-violet-800 dark:text-violet-100',
  },
  'border-purple-500': {
    bg: 'bg-purple-500/20 dark:bg-purple-500/30',
    ring: 'ring-purple-500/30',
    text: 'text-purple-800 dark:text-purple-100',
  },
  'border-red-600': {
    bg: 'bg-red-600/20 dark:bg-red-600/30',
    ring: 'ring-red-600/30',
    text: 'text-red-900 dark:text-red-100',
  },
  'border-orange-600': {
    bg: 'bg-orange-600/20 dark:bg-orange-600/30',
    ring: 'ring-orange-600/30',
    text: 'text-orange-900 dark:text-orange-100',
  },
  'border-yellow-500': {
    bg: 'bg-yellow-500/25 dark:bg-yellow-500/30',
    ring: 'ring-yellow-500/30',
    text: 'text-yellow-900 dark:text-yellow-100',
  },
  // Sender palette (darker, earth tones)
  'border-amber-700': {
    bg: 'bg-amber-700/15 dark:bg-amber-700/30',
    ring: 'ring-amber-600/30',
    text: 'text-amber-900 dark:text-amber-50',
  },
  'border-orange-800': {
    bg: 'bg-orange-800/15 dark:bg-orange-800/30',
    ring: 'ring-orange-700/30',
    text: 'text-orange-950 dark:text-orange-50',
  },
  'border-stone-600': {
    bg: 'bg-stone-600/15 dark:bg-stone-600/30',
    ring: 'ring-stone-500/30',
    text: 'text-stone-900 dark:text-stone-50',
  },
  'border-yellow-700': {
    bg: 'bg-yellow-700/15 dark:bg-yellow-700/30',
    ring: 'ring-yellow-600/30',
    text: 'text-yellow-950 dark:text-yellow-50',
  },
  'border-lime-700': {
    bg: 'bg-lime-700/15 dark:bg-lime-700/30',
    ring: 'ring-lime-600/30',
    text: 'text-lime-950 dark:text-lime-50',
  },
  'border-green-700': {
    bg: 'bg-green-700/15 dark:bg-green-700/30',
    ring: 'ring-green-600/30',
    text: 'text-green-950 dark:text-green-50',
  },
  'border-emerald-800': {
    bg: 'bg-emerald-800/15 dark:bg-emerald-800/30',
    ring: 'ring-emerald-700/30',
    text: 'text-emerald-950 dark:text-emerald-50',
  },
  'border-teal-800': {
    bg: 'bg-teal-800/15 dark:bg-teal-800/30',
    ring: 'ring-teal-700/30',
    text: 'text-teal-950 dark:text-teal-50',
  },
  'border-slate-600': {
    bg: 'bg-slate-600/15 dark:bg-slate-600/30',
    ring: 'ring-slate-500/30',
    text: 'text-slate-900 dark:text-slate-50',
  },
  'border-zinc-600': {
    bg: 'bg-zinc-600/15 dark:bg-zinc-600/30',
    ring: 'ring-zinc-500/30',
    text: 'text-zinc-900 dark:text-zinc-50',
  },
  'border-amber-800': {
    bg: 'bg-amber-800/15 dark:bg-amber-800/30',
    ring: 'ring-amber-700/30',
    text: 'text-amber-950 dark:text-amber-50',
  },
  'border-yellow-800': {
    bg: 'bg-yellow-800/15 dark:bg-yellow-800/30',
    ring: 'ring-yellow-700/30',
    text: 'text-yellow-950 dark:text-yellow-50',
  },
  'border-lime-800': {
    bg: 'bg-lime-800/15 dark:bg-lime-800/30',
    ring: 'ring-lime-700/30',
    text: 'text-lime-950 dark:text-lime-50',
  },
  'border-green-800': {
    bg: 'bg-green-800/15 dark:bg-green-800/30',
    ring: 'ring-green-700/30',
    text: 'text-green-950 dark:text-green-50',
  },
  'border-teal-700': {
    bg: 'bg-teal-700/15 dark:bg-teal-700/30',
    ring: 'ring-teal-600/30',
    text: 'text-teal-950 dark:text-teal-50',
  },
  'border-cyan-800': {
    bg: 'bg-cyan-800/15 dark:bg-cyan-800/30',
    ring: 'ring-cyan-700/30',
    text: 'text-cyan-950 dark:text-cyan-50',
  },
  'border-stone-700': {
    bg: 'bg-stone-700/15 dark:bg-stone-700/30',
    ring: 'ring-stone-600/30',
    text: 'text-stone-950 dark:text-stone-50',
  },
  'border-slate-700': {
    bg: 'bg-slate-700/15 dark:bg-slate-700/30',
    ring: 'ring-slate-600/30',
    text: 'text-slate-950 dark:text-slate-50',
  },
  'border-neutral-600': {
    bg: 'bg-neutral-600/15 dark:bg-neutral-600/30',
    ring: 'ring-neutral-500/30',
    text: 'text-neutral-900 dark:text-neutral-50',
  },
  'border-orange-900': {
    bg: 'bg-orange-900/15 dark:bg-orange-900/30',
    ring: 'ring-orange-800/30',
    text: 'text-orange-950 dark:text-orange-50',
  },
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
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return mode === 'TIMECODE' ? '00:00:00:00' : '0:00'
  
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
    
    onSeek(time)
  }, [videoDuration, onSeek])

  const handleTimelineTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration || !isDragging) return
    
    const touch = e.touches[0]
    const rect = timelineRef.current.getBoundingClientRect()
    const x = touch.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration
    
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
                    w-5 h-5 sm:w-6 sm:h-6
                    rounded-full ring-1 ring-inset
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
                              className={`w-5 h-5 rounded-full ring-1 ring-inset flex items-center justify-center text-[8px] font-semibold ${markerColors.bg} ${markerColors.ring} ${markerColors.text}`}
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
