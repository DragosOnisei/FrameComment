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
import { useAnnotation } from '@/contexts/AnnotationContext'
import { secondsToTimecode } from '@/lib/timecode'
import { logError } from '@/lib/logging'

type CommentWithReplies = Comment & {
  replies?: Comment[]
}

interface VideoPlayerProps {
  videos: Video[]
  projectId: string
  projectStatus: ProjectStatus
  defaultQuality?: '720p' | '1080p' | '2160p' // Default quality from settings
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
  const [resolvedPlaybackQuality, setResolvedPlaybackQuality] = useState<'720p' | '1080p' | '2160p'>(defaultQuality)
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

  // Comparison mode state
  const [showComparison, setShowComparison] = useState(false)

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

  // Safety check: ensure selectedVideo exists before accessing properties
  const isVideoApproved = selectedVideo ? (selectedVideo as any).approved === true : false

  // Load video URL with optimization
  useEffect(() => {
    async function loadVideoUrl() {
      try {
        // Safety check: ensure selectedVideo exists
        if (!selectedVideo) {
          return
        }

        // Use token-based URLs from the video object
        // These are generated by the share API with secure tokens
        // Respect the default quality setting from admin
        let url: string | undefined
        let qualityUsed: '720p' | '1080p' | '2160p' = defaultQuality

        if (defaultQuality === '2160p') {
          // Prefer 2160p, fallback to 1080p then 720p
          if ((selectedVideo as any).streamUrl2160p) {
            url = (selectedVideo as any).streamUrl2160p
            qualityUsed = '2160p'
          } else if ((selectedVideo as any).streamUrl1080p) {
            url = (selectedVideo as any).streamUrl1080p
            qualityUsed = '1080p'
          } else if ((selectedVideo as any).streamUrl720p) {
            url = (selectedVideo as any).streamUrl720p
            qualityUsed = '720p'
          }
        } else if (defaultQuality === '1080p') {
          // Prefer 1080p, fallback to 720p
          if ((selectedVideo as any).streamUrl1080p) {
            url = (selectedVideo as any).streamUrl1080p
            qualityUsed = '1080p'
          } else if ((selectedVideo as any).streamUrl720p) {
            url = (selectedVideo as any).streamUrl720p
            qualityUsed = '720p'
          } else if ((selectedVideo as any).streamUrl2160p) {
            url = (selectedVideo as any).streamUrl2160p
            qualityUsed = '2160p'
          }
        } else {
          // Prefer 720p, fallback to 1080p then 2160p
          if ((selectedVideo as any).streamUrl720p) {
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
  }, [selectedVideo, defaultQuality])

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
          // Don't auto-play - mobile browsers block this anyway, let user control playback

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

      // ArrowLeft / ArrowRight: step one frame (1.0.7+). Same
      // behaviour as Ctrl+J / Ctrl+L but without the modifier so it
      // matches Frame.io / DaVinci Resolve muscle memory. We skip the
      // shortcut when the user is typing in an input / textarea /
      // contenteditable so it doesn't fight with caret movement.
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
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

        if (!video.paused) {
          video.pause()
        }

        // Fall back to ~30 fps when we don't know the real frame rate
        // yet — gives a sensible "one frame" step on the first key
        // press while the metadata is still loading.
        const fps = selectedVideo?.fps && selectedVideo.fps > 0 ? selectedVideo.fps : 30
        const frameDuration = 1 / fps
        const direction = e.code === 'ArrowLeft' ? -1 : 1
        const next = video.currentTime + direction * frameDuration
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
                className={`relative group w-full bg-black flex items-center justify-center
                  aspect-[var(--video-ar)] max-h-[70vh]
                  lg:aspect-auto lg:max-h-none lg:flex-1 lg:min-h-0
                  ${isDrawingMode ? '' : ''}`}
                style={{
                  // Mobile-only: lock the wrapper to the video's NATURAL
                  // aspect ratio (e.g. 9/16 for portrait clips). With
                  // object-contain on the inner <video>, this means no
                  // letterboxing and no crop — the player frame matches
                  // the content exactly. `max-h-[70vh]` keeps a tall
                  // vertical clip from monopolising the whole viewport
                  // on small phones, leaving room for the controls and
                  // a peek at the comments below the fold. On lg+ this
                  // CSS variable is overridden by `lg:aspect-auto`.
                  ['--video-ar' as any]:
                    selectedVideo?.width && selectedVideo?.height
                      ? `${selectedVideo.width} / ${selectedVideo.height}`
                      : '16 / 9',
                }}
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
                    src={videoUrl}
                    poster={(selectedVideo as any).thumbnailUrl || undefined}
                    className={`w-full h-full object-contain ${isDrawingMode ? 'pointer-events-none' : 'cursor-pointer'}`}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onContextMenu={!isAdmin ? (e) => e.preventDefault() : undefined}
                    onClick={isDrawingMode ? undefined : handlePlayPause}
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
                  comments={comments as any[]}
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
                  comments={comments}
                  videoFps={selectedVideo?.fps || 24}
                  videoId={selectedVideo?.id}
                  isAdmin={isAdmin}
                  timestampDisplayMode={timestampDisplayMode}
                  onMarkerClick={onCommentFocus}
                  playbackSpeed={playbackSpeed}
                  onPlaybackSpeedChange={setPlaybackSpeed}
                  resolvedPlaybackQuality={resolvedPlaybackQuality}
                />
              </div>
              )}
            </div>
          </>
        ) : (
          <div className="w-full h-full aspect-video lg:aspect-auto max-h-[70vh] lg:max-h-none flex items-center justify-center text-card-foreground bg-black rounded-xl">
            Loading video...
          </div>
        )}
      </div>

      {/* Video Comparison Modal */}
      {showComparison && displayVideos.length >= 2 && (
        <VideoComparison
          videoVersions={displayVideos}
          defaultQuality={defaultQuality}
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
          defaultQuality={defaultQuality}
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
          playbackQuality={resolvedPlaybackQuality}
        />
      )}
    </div>
  )
}
