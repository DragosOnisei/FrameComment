'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Video } from '@prisma/client'
import { X, ChevronDown, GitCompareArrows } from 'lucide-react'
import VideoComparisonControls from './VideoComparisonControls'
import VideoComparisonSlider from './VideoComparisonSlider'

interface VideoComparisonProps {
  videoVersions: Video[]
  defaultQuality?: '720p' | '1080p' | '2160p'
  defaultVersionA?: number
  defaultVersionB?: number
  timestampDisplayMode?: 'TIMECODE' | 'AUTO'
  onClose: () => void
}

function getVideoUrl(video: Video, quality: '720p' | '1080p' | '2160p'): string {
  if (quality === '2160p') {
    return (video as any).streamUrl2160p || (video as any).streamUrl1080p || (video as any).streamUrl720p || ''
  }
  if (quality === '1080p') {
    return (video as any).streamUrl1080p || (video as any).streamUrl720p || (video as any).streamUrl2160p || ''
  }
  return (video as any).streamUrl720p || (video as any).streamUrl1080p || (video as any).streamUrl2160p || ''
}

export default function VideoComparison({
  videoVersions,
  defaultQuality = '720p',
  defaultVersionA,
  defaultVersionB,
  timestampDisplayMode = 'TIMECODE',
  onClose,
}: VideoComparisonProps) {
  const t = useTranslations('videos')
  // Sort versions by version number ascending so selectors are ordered logically
  const sorted = [...videoVersions].sort((a, b) => a.version - b.version)

  // Default: A = second-to-last (previous), B = last (latest)
  const initialA = defaultVersionA !== undefined
    ? sorted.findIndex(v => v.version === defaultVersionA)
    : Math.max(0, sorted.length - 2)
  const initialB = defaultVersionB !== undefined
    ? sorted.findIndex(v => v.version === defaultVersionB)
    : sorted.length - 1

  const [versionAIndex, setVersionAIndex] = useState(Math.max(0, initialA))
  const [versionBIndex, setVersionBIndex] = useState(Math.max(0, initialB))
  const [mode, setMode] = useState<'side-by-side' | 'slider'>('side-by-side')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [showSelectorA, setShowSelectorA] = useState(false)
  const [showSelectorB, setShowSelectorB] = useState(false)

  const videoRefA = useRef<HTMLVideoElement | null>(null)
  const videoRefB = useRef<HTMLVideoElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const currentTimeRef = useRef(0)
  const videoFpsRef = useRef(24)
  const videoDurationRef = useRef(0)
  const stepFrameRef = useRef<(direction: 'forward' | 'backward') => void>((direction) => {
    const a = videoRefA.current
    const b = videoRefB.current

    if (a && !a.paused) a.pause()
    if (b && !b.paused) b.pause()
    setIsPlaying(false)

    const frameDuration = 1 / videoFpsRef.current
    const current = a?.currentTime ?? currentTimeRef.current
    const newTime = direction === 'forward'
      ? Math.min(videoDurationRef.current, current + frameDuration)
      : Math.max(0, current - frameDuration)

    if (a) a.currentTime = newTime
    if (b) b.currentTime = newTime
    currentTimeRef.current = newTime
    setCurrentTime(newTime)
  })

  const versionA = sorted[versionAIndex]
  const versionB = sorted[versionBIndex]
  const videoUrlA = getVideoUrl(versionA, defaultQuality)
  const videoUrlB = getVideoUrl(versionB, defaultQuality)
  const videoFps = versionA?.fps || versionB?.fps || 24

  useEffect(() => {
    videoFpsRef.current = videoFps
  }, [videoFps])

  useEffect(() => {
    videoDurationRef.current = videoDuration
  }, [videoDuration])

  // --- Synced playback ---
  // No continuous sync — just align B to A on user actions (play/pause/seek).
  // Browsers keep two videos playing at the same rate with negligible drift.

  const handleSeek = (time: number) => {
    const a = videoRefA.current
    const b = videoRefB.current
    if (a) a.currentTime = time
    if (b) b.currentTime = time
    currentTimeRef.current = time
    setCurrentTime(time)
  }

  const handleSpeedChange = useCallback((speed: number) => {
    setPlaybackSpeed(speed)
    if (videoRefA.current) videoRefA.current.playbackRate = speed
    if (videoRefB.current) videoRefB.current.playbackRate = speed
  }, [])

  const togglePlayPause = useCallback(() => {
    const a = videoRefA.current
    const b = videoRefB.current
    if (!a || !b) return

    if (isPlaying) {
      a.pause()
      b.pause()
      setIsPlaying(false)
    } else {
      b.currentTime = a.currentTime
      Promise.all([a.play(), b.play()]).catch(() => {})
      setIsPlaying(true)
    }
  }, [isPlaying])

  const stepFrame = useCallback((direction: 'forward' | 'backward') => {
    stepFrameRef.current(direction)
  }, [])

  // A's timeupdate drives the UI timeline only — no sync logic
  useEffect(() => {
    const a = videoRefA.current
    if (!a) return

    const onTimeUpdate = () => {
      currentTimeRef.current = a.currentTime
      setCurrentTime(a.currentTime)
    }

    const onPlay = () => {
      setIsPlaying(true)
      const b = videoRefB.current
      if (b && b.paused) {
        b.currentTime = a.currentTime
        b.play().catch(() => {})
      }
    }

    const onPause = () => {
      setIsPlaying(false)
      const b = videoRefB.current
      if (b) {
        b.pause()
        b.currentTime = a.currentTime
      }
    }

    const onEnded = () => {
      setIsPlaying(false)
      videoRefB.current?.pause()
    }

    // Use the native timeupdate for sync (fires ~4x/sec, low overhead)
    a.addEventListener('timeupdate', onTimeUpdate)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onEnded)

    return () => {
      a.removeEventListener('timeupdate', onTimeUpdate)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('ended', onEnded)
    }
  }, [videoUrlA])

  // Handle metadata load — set duration, apply speed
  const handleLoadedMetadata = useCallback(() => {
    const a = videoRefA.current
    const b = videoRefB.current
    const dur = a?.duration || b?.duration || 0
    if (dur && dur !== Infinity) {
      setVideoDuration(dur)
    }
    if (a) a.playbackRate = playbackSpeed
    if (b) b.playbackRate = playbackSpeed
  }, [playbackSpeed])

  // Keyboard shortcuts — match the main player exactly (Ctrl+ prefix)
  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      // Escape: close comparison (no Ctrl needed)
      if (e.key === 'Escape') {
        onClose()
        return
      }

      // Ctrl+Space: Play/Pause
      if (e.ctrlKey && !e.metaKey && e.code === 'Space') {
        e.preventDefault()
        e.stopPropagation()
        togglePlayPause()
        return
      }

      // Ctrl+, or Ctrl+<: Decrease speed by 0.25x
      if (e.ctrlKey && !e.metaKey && (e.code === 'Comma' || e.key === '<')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(prev => {
          const next = Math.max(0.25, prev - 0.25)
          if (videoRefA.current) videoRefA.current.playbackRate = next
          if (videoRefB.current) videoRefB.current.playbackRate = next
          return next
        })
        return
      }

      // Ctrl+. or Ctrl+>: Increase speed by 0.25x
      if (e.ctrlKey && !e.metaKey && (e.code === 'Period' || e.key === '>')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(prev => {
          const next = Math.min(2.0, prev + 0.25)
          if (videoRefA.current) videoRefA.current.playbackRate = next
          if (videoRefB.current) videoRefB.current.playbackRate = next
          return next
        })
        return
      }

      // Ctrl+/: Reset speed to 1.0x
      if (e.ctrlKey && !e.metaKey && (e.code === 'Slash' || e.key === '/' || e.key === '?')) {
        e.preventDefault()
        e.stopPropagation()
        setPlaybackSpeed(1.0)
        if (videoRefA.current) videoRefA.current.playbackRate = 1.0
        if (videoRefB.current) videoRefB.current.playbackRate = 1.0
        return
      }

      // Ctrl+J: Go back one frame
      if (e.ctrlKey && !e.metaKey && e.code === 'KeyJ') {
        e.preventDefault()
        e.stopPropagation()
        stepFrameRef.current('backward')
        return
      }

      // Ctrl+L: Go forward one frame
      if (e.ctrlKey && !e.metaKey && e.code === 'KeyL') {
        e.preventDefault()
        e.stopPropagation()
        stepFrameRef.current('forward')
        return
      }
    }

    // Use capture phase like the main player
    window.addEventListener('keydown', handleKeyboard, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyboard, { capture: true })
  }, [onClose, togglePlayPause])

  // Pause on unmount
  useEffect(() => {
    const videoA = videoRefA.current
    const videoB = videoRefB.current

    return () => {
      videoA?.pause()
      videoB?.pause()
    }
  }, [])

  // Reset time and reload videos when versions or mode change
  useEffect(() => {
    const a = videoRefA.current
    const b = videoRefB.current
    if (a) { a.pause(); a.currentTime = 0; a.load() }
    if (b) { b.pause(); b.currentTime = 0; b.load() }
    setCurrentTime(0)
    currentTimeRef.current = 0
    setVideoDuration(0)
    setIsPlaying(false)
  }, [versionAIndex, versionBIndex, mode])

  const stripExt = (n: string) => {
    const dot = n.lastIndexOf('.')
    return dot > 0 ? n.slice(0, dot) : n
  }

  // 3.8.x: per-video header (centered, above each clip) — filename + an
  // inline version dropdown so you can re-pick either side right where
  // you're looking. Styled in the app's glass vocabulary; a small
  // sky/emerald dot keeps the A/B sides identifiable (esp. in slider mode).
  const renderVersionPicker = (side: 'A' | 'B') => {
    const isA = side === 'A'
    const idx = isA ? versionAIndex : versionBIndex
    const otherIdx = isA ? versionBIndex : versionAIndex
    const setIdx = isA ? setVersionAIndex : setVersionBIndex
    const show = isA ? showSelectorA : showSelectorB
    const setShow = isA ? setShowSelectorA : setShowSelectorB
    const closeOther = isA ? setShowSelectorB : setShowSelectorA
    const v = sorted[idx]
    const rawName = (v as any)?.originalFileName || v?.name || ''
    return (
      <div className="flex items-center justify-center gap-2 mb-2 px-2 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${isA ? 'bg-sky-400' : 'bg-emerald-400'}`} />
        <span className="text-xs text-white/70 truncate max-w-[55%]" title={rawName}>
          {stripExt(rawName) || '—'}
        </span>
        <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => { setShow(!show); closeOther(false) }}
            className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1.5 rounded-full text-xs font-semibold uppercase tracking-wider tabular-nums bg-white/[0.08] ring-1 ring-white/15 text-white hover:bg-white/[0.16] hover:ring-white/25 active:scale-95 transition-colors"
            title="Switch version"
          >
            {v?.versionLabel}
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {show && (
            <div
              className="absolute top-full mt-1 left-1/2 -translate-x-1/2 z-50 min-w-[130px] py-1 rounded-lg ring-1 ring-white/15 shadow-2xl"
              style={{
                backgroundColor: 'rgba(22, 37, 51, 0.95)',
                backdropFilter: 'blur(24px) saturate(160%)',
                WebkitBackdropFilter: 'blur(24px) saturate(160%)',
              }}
            >
              {sorted.map((ver, i) => (
                <button
                  key={ver.id}
                  type="button"
                  onClick={() => { setIdx(i); setShow(false) }}
                  disabled={i === otherIdx}
                  className={`w-full px-3 py-1.5 text-left text-xs transition-colors ${
                    i === idx ? 'bg-white/[0.12] font-semibold text-white' : 'text-white/85 hover:bg-white/[0.08]'
                  } ${i === otherIdx ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {ver.versionLabel}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col text-white"
      style={{
        backgroundColor: 'rgba(22, 37, 51, 0.88)',
        backgroundImage:
          'radial-gradient(120% 85% at 50% -10%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 42%, transparent 72%)',
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      }}
    >
      {/* Header — app glass. Version pickers moved above each video, so the
          header stays minimal: title + a glass close button. */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitCompareArrows className="w-4 h-4 text-white/70 shrink-0" />
          <h2 className="text-sm font-semibold text-white truncate">
            {t('compareVersions')}
          </h2>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="h-8 w-8 rounded-full bg-white/[0.08] ring-1 ring-white/15 text-white flex items-center justify-center hover:bg-white/[0.16] hover:ring-white/25 active:scale-95 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Video Area */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 flex flex-col p-2 sm:p-4"
        onClick={() => { setShowSelectorA(false); setShowSelectorB(false) }}
      >
        <div className="flex-1 min-h-0 relative">
          {mode === 'side-by-side' ? (
            /* Side-by-Side Mode */
            <div className="h-full flex flex-col sm:flex-row gap-2">
              {/* Video A */}
              <div className="flex-1 min-h-0 flex flex-col">
                {renderVersionPicker('A')}
                <div className="flex-1 min-h-0 relative rounded-xl overflow-hidden bg-black/30 ring-1 ring-white/10"
                  style={{ aspectRatio: '16 / 9' }}
                >
                  <video
                    ref={videoRefA}
                    key={`a-${versionA?.id}`}
                    src={videoUrlA}
                    poster={(versionA as any)?.thumbnailUrl || undefined}
                    className="w-full h-full object-contain cursor-pointer"
                    crossOrigin="anonymous"
                    playsInline
                    preload="auto"
                    onLoadedMetadata={handleLoadedMetadata}
                    onClick={togglePlayPause}
                  />
                </div>
              </div>

              {/* Video B */}
              <div className="flex-1 min-h-0 flex flex-col">
                {renderVersionPicker('B')}
                <div className="flex-1 min-h-0 relative rounded-xl overflow-hidden bg-black/30 ring-1 ring-white/10"
                  style={{ aspectRatio: '16 / 9' }}
                >
                  <video
                    ref={videoRefB}
                    key={`b-${versionB?.id}`}
                    src={videoUrlB}
                    poster={(versionB as any)?.thumbnailUrl || undefined}
                    className="w-full h-full object-contain cursor-pointer"
                    crossOrigin="anonymous"
                    playsInline
                    preload="auto"
                    onLoadedMetadata={handleLoadedMetadata}
                    onClick={togglePlayPause}
                  />
                </div>
              </div>
            </div>
          ) : (
            /* Slider Mode */
            <div className="h-full flex items-center justify-center">
              <div className="w-full max-h-full" style={{ aspectRatio: '16 / 9' }}>
                <VideoComparisonSlider
                  videoRefA={videoRefA}
                  videoRefB={videoRefB}
                  videoUrlA={videoUrlA}
                  videoUrlB={videoUrlB}
                  labelA={`A: ${versionA?.versionLabel}`}
                  labelB={`B: ${versionB?.versionLabel}`}
                  posterA={(versionA as any)?.thumbnailUrl}
                  posterB={(versionB as any)?.thumbnailUrl}
                  onLoadedMetadata={handleLoadedMetadata}
                />
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex-shrink-0 mt-2">
          <VideoComparisonControls
            videoDuration={videoDuration}
            currentTime={currentTime}
            isPlaying={isPlaying}
            onPlayPause={togglePlayPause}
            onSeek={handleSeek}
            onFrameStep={stepFrame}
            mode={mode}
            onModeChange={setMode}
            playbackSpeed={playbackSpeed}
            onSpeedChange={handleSpeedChange}
            videoFps={videoFps}
            timestampDisplayMode={timestampDisplayMode}
          />
        </div>
      </div>

      {/* Speed indicator */}
      {playbackSpeed !== 1 && (
        <div className="absolute top-16 right-6 bg-black/80 text-white px-3 py-1.5 rounded-md text-sm font-medium pointer-events-none z-30">
          {playbackSpeed.toFixed(2)}x
        </div>
      )}
    </div>
  )
}
