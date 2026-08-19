'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Play, Pause, Columns2, SplitSquareHorizontal, Volume2, VolumeX } from 'lucide-react'
import { secondsToTimecode, formatCommentTimestamp } from '@/lib/timecode'
import PlaybackSpeedMenu from './PlaybackSpeedMenu'

function formatTimeWithMode(
  seconds: number,
  fps: number,
  videoDurationSeconds: number,
  mode: 'TIMECODE' | 'AUTO'
): string {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return mode === 'TIMECODE' ? '00:00' : '0:00'
  const timecode = secondsToTimecode(seconds, fps)
  return formatCommentTimestamp({ timecode, fps, videoDurationSeconds, mode })
}

interface VideoComparisonControlsProps {
  videoDuration: number
  currentTime: number
  isPlaying: boolean
  onPlayPause: () => void
  onSeek: (time: number) => void
  mode: 'side-by-side' | 'slider'
  onModeChange: (mode: 'side-by-side' | 'slider') => void
  playbackSpeed: number
  onSpeedChange: (speed: number) => void
  videoFps: number
  timestampDisplayMode: 'TIMECODE' | 'AUTO'
  /*
   * 6.22.0 — sound controls.
   *
   * Compare mode had none: one of the two clips was always audible, so there was
   * no way to look at two cuts in silence. `isMuted` is the effective state (the
   * parent folds a zero volume into it) so the icon can never disagree with what
   * you hear.
   */
  volume: number
  isMuted: boolean
  onVolumeChange: (volume: number) => void
  onToggleMute: () => void
}

export default function VideoComparisonControls({
  videoDuration,
  currentTime,
  isPlaying,
  onPlayPause,
  onSeek,
  mode,
  onModeChange,
  playbackSpeed,
  onSpeedChange,
  videoFps,
  timestampDisplayMode,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
}: VideoComparisonControlsProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [hoveredTime, setHoveredTime] = useState<number | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const volumeTrackRef = useRef<HTMLDivElement>(null)
  const [draggingVolume, setDraggingVolume] = useState(false)
  // The slider is revealed on hover, with a short grace period on leave so the
  // track does not collapse out from under a cursor travelling towards it.
  const [showVolume, setShowVolume] = useState(false)
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const t = useTranslations('videos')

  const progress = videoDuration > 0 ? (currentTime / videoDuration) * 100 : 0

  /*
   * 6.22.0 — volume slider.
   *
   * A div rather than an <input type="range"> for the same reason the main
   * player's is: the native control cannot be styled consistently across
   * browsers, and this strip sits over video where a stray grey track is very
   * visible. Pointer handling is written out instead, including drag-outside,
   * which is the case a naive onClick implementation gets wrong.
   */
  const volumeFromEvent = useCallback((clientX: number) => {
    const el = volumeTrackRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0) return null
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const handleVolumeMouseEnter = useCallback(() => {
    if (volumeTimeoutRef.current) clearTimeout(volumeTimeoutRef.current)
    setShowVolume(true)
  }, [])

  const handleVolumeMouseLeave = useCallback(() => {
    volumeTimeoutRef.current = setTimeout(() => setShowVolume(false), 500)
  }, [])

  const handleVolumeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const next = volumeFromEvent(e.clientX)
      if (next === null) return
      setDraggingVolume(true)
      onVolumeChange(next)
    },
    [volumeFromEvent, onVolumeChange],
  )

  useEffect(() => {
    if (!draggingVolume) return
    const onMove = (e: MouseEvent) => {
      const next = volumeFromEvent(e.clientX)
      if (next !== null) onVolumeChange(next)
    }
    const onUp = () => setDraggingVolume(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [draggingVolume, volumeFromEvent, onVolumeChange])

  // Keyboard: the slider is focusable, so it must also be operable. Compare
  // mode's own shortcuts are all Ctrl-prefixed, so bare arrows are free here.
  const handleVolumeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault()
        onVolumeChange(Math.min(1, volume + 0.05))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault()
        onVolumeChange(Math.max(0, volume - 0.05))
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        onToggleMute()
      }
    },
    [volume, onVolumeChange, onToggleMute],
  )

  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return
    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    onSeek(percentage * videoDuration)
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
    onSeek(percentage * videoDuration)
  }, [videoDuration, onSeek])

  const handleTimelineTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration || !isDragging) return
    const touch = e.touches[0]
    const rect = timelineRef.current.getBoundingClientRect()
    const x = touch.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    onSeek(percentage * videoDuration)
  }, [isDragging, videoDuration, onSeek])

  const handleTimelineTouchEnd = useCallback(() => {
    setIsDragging(false)
  }, [])

  const handleTimelineMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return
    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    setHoveredTime(percentage * videoDuration)
    if (isDragging) {
      onSeek(percentage * videoDuration)
    }
  }, [isDragging, videoDuration, onSeek])

  const handleTimelineMouseLeave = useCallback(() => {
    setHoveredTime(null)
  }, [])

  useEffect(() => {
    const handleMouseUp = () => {
      if (isDragging) setIsDragging(false)
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [isDragging])

  /*
   * 6.22.0 — two layers, because one cannot match the main player.
   *
   * The player's bar is `rgba(30, 48, 72, 0.40)` painted on a wrapper that is
   * `bg-black`, so what you actually see is that colour composited over black:
   * near-black with the faintest blue. Copying only the translucent value into
   * compare mode produced a visibly bluer bar, because the surface BEHIND it
   * here is the overlay's own `rgba(22, 37, 51, 0.88)` plus an accent radial —
   * the tint was bleeding through, exactly as designed, into the one place it
   * should not.
   *
   * So the black is stated locally: an opaque outer shell with the translucent
   * bar inside it, which is the player's structure rather than an approximation
   * of its output. No backdrop-filter either — there is nothing left to see
   * through, and blurring under an opaque fill is pure GPU cost.
   */
  return (
    <div className="rounded-xl ring-1 ring-white/10 overflow-hidden bg-black">
      <div
        className="p-2 sm:p-3"
        style={{ backgroundColor: 'rgba(30, 48, 72, 0.40)' }}
      >
      {/* Timeline */}
      <div className="mb-2 sm:mb-3 px-1">
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
          {/* 6.22.0: 3px at rest, thickening on hover, exactly as the main
              player. A permanently fat bar is the single biggest reason the two
              timelines did not look like the same control. */}
          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-[3px] group-hover:h-1.5 sm:group-hover:h-2 bg-white/20 rounded-full overflow-hidden transition-[height] duration-150">
            <div className="absolute inset-0 bg-white/30" />
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${progress}%`,
                backgroundColor: 'hsl(var(--spotlight-tint))',
                boxShadow: '0 0 8px hsl(var(--spotlight-tint) / 0.4)',
              }}
            />
          </div>

          {/* Playhead — the same Frame.io-style thin vertical tick the main
              player uses, growing with the track on hover. The old white disc
              with an accent ring belonged to an earlier design and was the other
              half of why the two timelines read as different controls. */}
          <div
            className="absolute top-1/2 -translate-y-1/2 pointer-events-none z-20"
            style={{ left: `${progress}%` }}
          >
            <div className="w-[2px] h-[3px] group-hover:h-1.5 sm:group-hover:h-2 bg-white -translate-x-1/2 transition-[height] duration-150" />
          </div>

          {/* Hover Time Indicator */}
          {hoveredTime !== null && !isDragging && (
            <div
              className="hidden sm:block absolute bottom-full mb-3 px-2 py-1 bg-black/90 text-white text-xs font-mono rounded border border-white/20 shadow-lg whitespace-nowrap tabular-nums pointer-events-none z-30"
              style={{
                left: `${(hoveredTime / videoDuration) * 100}%`,
                transform: 'translateX(-50%)',
              }}
            >
              {formatTimeWithMode(hoveredTime, videoFps, videoDuration, timestampDisplayMode)}
            </div>
          )}
        </div>
      </div>

      {/*
        6.22.0 — the main player's three-part row: LEFT play / speed / volume,
        CENTER the time, RIGHT the compare-only controls.
        Frame back/forward are gone, as they went from the normal player in
        4.1.0 — stepping lives on Ctrl+J / Ctrl+L, which compare mode already
        binds, and two extra buttons here only made the two bars look unrelated.
      */}
      <div className="flex items-center gap-1 sm:gap-2 px-1">
        {/* LEFT GROUP */}
        <div className="flex items-center gap-0.5 sm:gap-1 flex-1 min-w-0">
          <button
            onClick={onPlayPause}
            className="p-2 hover:bg-white/[0.10] active:bg-white/[0.18] rounded-md transition-colors touch-manipulation text-white/85 hover:text-white"
            aria-label={isPlaying ? t('decreaseSpeed') : t('playPause')}
            title={(isPlaying ? t('decreaseSpeed') : t('playPause')) + ' (Ctrl+Space)'}
          >
            {isPlaying ? (
              <Pause className="w-5 h-5 text-white fill-white" />
            ) : (
              <Play className="w-5 h-5 text-white fill-white" />
            )}
          </button>

          <PlaybackSpeedMenu
            value={playbackSpeed}
            onChange={onSpeedChange}
            options={[0.75, 1, 1.25, 1.5, 2]}
            className="ml-0.5 sm:ml-1"
          />

          {/*
            6.22.0: volume, on the left and behaving exactly like the main
            player's — icon always visible, slider sliding out on hover. Copying
            the recipe rather than inventing a second one matters more here than
            anywhere else in the app: compare mode is the one screen a user
            arrives at straight from the normal player, so a different-looking
            volume control reads as a different product. Hidden slider on mobile;
            tapping the icon mutes.
          */}
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
              {isMuted ? (
                <VolumeX className="w-4 h-4 text-white" />
              ) : (
                <Volume2 className="w-4 h-4 text-white" />
              )}
            </button>
            {/* The OUTER wrapper owns the pointer handler and gives a taller
                (h-5) hit area — the 3px track alone is unhittable, and at
                volume = 1 half the thumb sits outside its bounds. */}
            <div
              onMouseDown={handleVolumeMouseDown}
              onKeyDown={handleVolumeKeyDown}
              className={`hidden sm:flex items-center h-5 cursor-pointer transition-[width,opacity,margin] duration-200 ease-out ${
                showVolume
                  ? 'w-20 opacity-100 pointer-events-auto ml-1'
                  : 'w-0 opacity-0 pointer-events-none ml-0'
              }`}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={isMuted ? 0 : volume}
              aria-label={t('volume')}
              tabIndex={showVolume ? 0 : -1}
            >
              <div
                ref={volumeTrackRef}
                className="relative h-[3px] w-full rounded-full bg-white/15"
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
                  style={{
                    width: `${(isMuted ? 0 : volume) * 100}%`,
                    backgroundColor: 'hsl(var(--spotlight-tint))',
                    boxShadow: '0 0 6px hsl(var(--spotlight-tint) / 0.45)',
                    transition: draggingVolume ? 'none' : 'width 200ms linear',
                  }}
                />
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
                    transition: draggingVolume ? 'none' : 'left 200ms linear',
                  }}
                />
              </div>
            </div>
          </div>

        </div>

        {/* CENTER: time — same size, weight and dimmed separator as the player. */}
        <div className="text-white/85 text-xs sm:text-sm font-mono tabular-nums whitespace-nowrap shrink-0">
          {formatTimeWithMode(currentTime, videoFps, videoDuration, timestampDisplayMode)}
          <span className="text-white/40"> / </span>
          {formatTimeWithMode(videoDuration, videoFps, videoDuration, timestampDisplayMode)}
        </div>

        {/* RIGHT GROUP — compare-only. */}
        <div className="flex items-center gap-0.5 sm:gap-1 flex-1 justify-end min-w-0">
          {/* Mode Toggle */}
          <button
            onClick={() => onModeChange(mode === 'side-by-side' ? 'slider' : 'side-by-side')}
            className="p-2 sm:p-2.5 hover:bg-white/10 active:bg-white/20 rounded-lg transition-colors touch-manipulation"
            aria-label={mode === 'side-by-side' ? t('switchToSlider') : t('switchToSideBySide')}
            title={mode === 'side-by-side' ? t('sliderMode') : t('sideBySideMode')}
          >
            {mode === 'side-by-side' ? (
              <SplitSquareHorizontal className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            ) : (
              <Columns2 className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            )}
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}
