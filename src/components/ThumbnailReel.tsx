'use client'

import Image from 'next/image'
import { useRef, useEffect, useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowLeft, CheckCircle2, ChevronDown, Film, Layers, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import ThemeToggle from '@/components/ThemeToggle'
import LanguageToggle from '@/components/LanguageToggle'

interface ThumbnailReelProps {
  videosByName: Record<string, any[]>
  thumbnailsByName: Map<string, string>
  activeVideoName: string
  onVideoSelect: (videoName: string) => void
  onBackToGrid?: () => void
  showBackButton?: boolean
  /** Override label on the back button. When provided, takes precedence
   *  over the default `share.allVideos` translation. Used by folder-share
   *  player to show "Back to folder" instead of "All Videos". */
  backLabel?: string
  // Comment panel controls
  showCommentToggle?: boolean
  isCommentPanelVisible?: boolean
  onToggleCommentPanel?: () => void
  // Language toggle visibility (hidden on admin share page)
  showLanguageToggle?: boolean
  // Optional slot rendered after ThemeToggle (e.g. tutorial help button)
  trailingAction?: React.ReactNode
  /** 1.3.2+: when provided, replaces the standalone ThemeToggle in the
   *  right-hand toolbar with this node. Used by the admin share page to
   *  swap in a consolidated `PlayerTopMenu` (Share / Delete / Copy /
   *  Paste / Switch theme). When omitted the toolbar keeps the original
   *  ThemeToggle so the public share page is unchanged. */
  topRightMenu?: React.ReactNode
  /** Currently-playing video id (one of videosByName[activeVideoName]).
   *  Used to highlight the active version in the dropdown. Optional —
   *  when missing, the first (latest) version is treated as active. */
  activeVideoId?: string
}

export default function ThumbnailReel({
  videosByName,
  thumbnailsByName,
  activeVideoName,
  onVideoSelect,
  onBackToGrid,
  showBackButton = true,
  backLabel,
  showCommentToggle = false,
  isCommentPanelVisible = true,
  onToggleCommentPanel,
  showLanguageToggle = true,
  trailingAction,
  topRightMenu,
  activeVideoId,
}: ThumbnailReelProps) {
  const tShare = useTranslations('share')
  const tComments = useTranslations('comments')
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Start collapsed on first load
  const [isExpanded, setIsExpanded] = useState(false)
  const hasScrolledRef = useRef(false)
  // Version dropdown
  const [versionMenuOpen, setVersionMenuOpen] = useState(false)
  const versionMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!versionMenuOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!versionMenuRef.current) return
      if (!versionMenuRef.current.contains(e.target as Node)) {
        setVersionMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVersionMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [versionMenuOpen])

  const handleToggleExpanded = () => {
    setIsExpanded(!isExpanded)
  }

  // Sort videos: For review (not approved) first, then approved, both alphabetically
  const videoNames = useMemo(() => {
    const names = Object.keys(videosByName)

    // Separate into review and approved
    const forReview: string[] = []
    const approved: string[] = []

    names.forEach(name => {
      const videos = videosByName[name]
      const hasApprovedVideo = videos.some((v: any) => v.approved === true)
      if (hasApprovedVideo) {
        approved.push(name)
      } else {
        forReview.push(name)
      }
    })

    // Sort each group alphabetically
    forReview.sort((a, b) => a.localeCompare(b))
    approved.sort((a, b) => a.localeCompare(b))

    // Return: review first, then approved
    return [...forReview, ...approved]
  }, [videosByName])

  // Used by the expanded thumbnail grid below the bar to highlight the
  // active row. The previous "1/N" counter + prev/next arrows have been
  // dropped from the centre of the bar in favour of the breadcrumb-style
  // filename + version dropdown — see the JSX below.
  const activeIndex = videoNames.indexOf(activeVideoName)

  // Scroll to active thumbnail when expanded
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !activeVideoName || !isExpanded) return

    // Reset scroll flag when expanding
    if (!hasScrolledRef.current) {
      const idx = videoNames.indexOf(activeVideoName)
      if (idx === -1) return

      // Find the active thumbnail element
      const thumbnails = container.querySelectorAll('[data-thumbnail]')
      const activeThumbnail = thumbnails[idx] as HTMLElement
      if (!activeThumbnail) return

      // Scroll to center the active thumbnail
      const containerWidth = container.clientWidth
      const thumbnailLeft = activeThumbnail.offsetLeft
      const thumbnailWidth = activeThumbnail.offsetWidth
      const scrollTo = thumbnailLeft - containerWidth / 2 + thumbnailWidth / 2

      container.scrollTo({ left: scrollTo, behavior: 'smooth' })
      hasScrolledRef.current = true
    }
  }, [activeVideoName, videoNames, isExpanded])

  // Reset scroll flag when collapsing
  useEffect(() => {
    if (!isExpanded) {
      hasScrolledRef.current = false
    }
  }, [isExpanded])

  // Get current video info
  const currentVideos = activeVideoName ? videosByName[activeVideoName] : []
  const hasApprovedCurrent = currentVideos.some((v: any) => v.approved === true)

  // Versions of the active video (already in `videosByName[activeVideoName]`),
  // sorted newest-first so the dropdown reads like a release history.
  const currentVersions = useMemo(() => {
    return [...currentVideos].sort(
      (a: any, b: any) => (b.version ?? 0) - (a.version ?? 0)
    )
  }, [currentVideos])

  // Derive the active version's label for the chip. We try (in order):
  //   1) activeVideoId match → that video's versionLabel
  //   2) latest version's versionLabel (newest first)
  //   3) `v{n}` fallback
  const activeVideo =
    (activeVideoId
      ? currentVersions.find((v: any) => v.id === activeVideoId)
      : null) || currentVersions[0]
  const activeVersionLabel: string =
    activeVideo?.versionLabel ||
    (typeof activeVideo?.version === 'number' ? `v${activeVideo.version}` : 'v1')

  // Display name in the header reflects the SELECTED version's
  // original filename (1.0.6+). After Frame.io-style stacking, every
  // version in a group shares the same `name`, so we can't fall back
  // to it for per-version identity. Strip the extension so the bar
  // reads "Episode 2" not "Episode 2.mp4".
  const stripExt = (filename: string | undefined | null) => {
    if (!filename) return ''
    const dot = filename.lastIndexOf('.')
    return dot > 0 ? filename.slice(0, dot) : filename
  }
  const displayedHeaderName =
    stripExt(activeVideo?.originalFileName) || activeVideoName || ''

  // 1.2.0+: surface the active version's upload timestamp directly
  // under the title so the reviewer can see how long passed between
  // v1, v2, v3… `createdAt` is the row's insertion time on Video,
  // which is when the original file was uploaded.
  const activeUploadedAt: Date | null = activeVideo?.createdAt
    ? (activeVideo.createdAt instanceof Date
        ? activeVideo.createdAt
        : new Date(activeVideo.createdAt as any))
    : null
  const uploadedAtLabel =
    activeUploadedAt && !isNaN(activeUploadedAt.getTime())
      ? formatDateTime(activeUploadedAt)
      : null
  // Compact relative-time tag ("Just now", "5m ago", "2h ago",
  // "3d ago", "1mo ago", "2y ago"). Frame.io-style — keeps the line
  // short even when the timestamp is years old.
  const relativeUploadedLabel = (() => {
    if (!activeUploadedAt || isNaN(activeUploadedAt.getTime())) return null
    const diffMs = Date.now() - activeUploadedAt.getTime()
    if (diffMs < 0) return 'Just now'
    const sec = Math.floor(diffMs / 1000)
    if (sec < 45) return 'Just now'
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min} ${min === 1 ? 'Minute' : 'Minutes'} ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} ${hr === 1 ? 'Hour' : 'Hours'} ago`
    const day = Math.floor(hr / 24)
    if (day < 30) return `${day} ${day === 1 ? 'Day' : 'Days'} ago`
    const mo = Math.floor(day / 30)
    if (mo < 12) return `${mo} ${mo === 1 ? 'Month' : 'Months'} ago`
    const yr = Math.floor(day / 365)
    return `${yr} ${yr === 1 ? 'Year' : 'Years'} ago`
  })()

  return (
    <div className="relative shrink-0 z-20 p-2 sm:p-3">
      {/* Compact Control Bar - Always visible */}
      <div className="bg-card/95 backdrop-blur-sm px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl">
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Left: Back to grid */}
          <div className="flex items-center">
            {showBackButton && onBackToGrid && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBackToGrid}
                className="shrink-0 gap-1.5 px-2 sm:px-3 h-8"
                title={backLabel ?? tShare('backToAllVideos')}
              >
                {/* 1.0.9+: plain "Back" arrow instead of the grid
                    glyph + "All Videos" label, to match the unified
                    Back buttons on the project + folder pages. A
                    `backLabel` override (e.g. folder-share's "Back to
                    folder") still wins when provided. */}
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline text-sm">{backLabel ?? 'Back'}</span>
              </Button>
            )}
          </div>

          {/* Center: filename + version chip with dropdown (Frame.io-style).
              Replaces the older prev/next + "1/N" counter — that paradigm
              didn't communicate WHAT video the user was on, only its
              ordinal. The breadcrumb-style filename is much clearer; for
              switching videos the user goes back to the grid. */}
          <div className="flex-1 flex items-center justify-center min-w-0">
            <div ref={versionMenuRef} className="relative flex items-center gap-2 min-w-0">
              <button
                data-tutorial="video-reel-center"
                onClick={handleToggleExpanded}
                className={cn(
                  "flex items-center gap-2 min-w-0 px-2 py-1 rounded-md transition-all max-w-[40vw] sm:max-w-[50vw]",
                  "hover:bg-muted/80 active:scale-95",
                  isExpanded && "bg-muted/50"
                )}
                title={isExpanded ? 'Hide video thumbnails' : 'Show video thumbnails'}
              >
                <CheckCircle2
                  className={cn(
                    'w-4 h-4 shrink-0',
                    hasApprovedCurrent ? 'text-success' : 'text-muted-foreground/50'
                  )}
                />
                {/*
                  1.2.0+: title + upload-date stack. The date sits
                  directly under the title (centered) with a compact
                  relative-time tag in parentheses, so the reviewer
                  can tell at a glance when this version landed and
                  roughly how long passed since the previous one.
                */}
                <div className="flex flex-col items-center min-w-0 leading-tight">
                  <span
                    className="text-sm text-foreground/90 truncate max-w-full"
                    title={displayedHeaderName}
                  >
                    {displayedHeaderName || '—'}
                  </span>
                  {uploadedAtLabel && (
                    <span
                      className="text-[10px] text-muted-foreground truncate max-w-full"
                      title={`Uploaded ${uploadedAtLabel}`}
                    >
                      {uploadedAtLabel}
                      {relativeUploadedLabel ? ` (${relativeUploadedLabel})` : ''}
                    </span>
                  )}
                </div>
              </button>

              {/* Version chip — clickable when there's more than one version */}
              {currentVersions.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (currentVersions.length > 1) {
                      setVersionMenuOpen((v) => !v)
                    }
                  }}
                  disabled={currentVersions.length < 2}
                  aria-haspopup={currentVersions.length > 1 ? 'menu' : undefined}
                  aria-expanded={versionMenuOpen}
                  className={cn(
                    'inline-flex items-center gap-0.5 shrink-0 h-6 pl-2 pr-1 rounded-full',
                    'text-[11px] font-mono font-medium tabular-nums',
                    'bg-muted/60 text-foreground/80',
                    'transition-colors',
                    currentVersions.length > 1 && 'hover:bg-muted active:scale-95 cursor-pointer',
                    currentVersions.length < 2 && 'cursor-default opacity-70'
                  )}
                  title={
                    currentVersions.length > 1
                      ? 'Switch version'
                      : 'This video has only one version'
                  }
                >
                  <span>{activeVersionLabel}</span>
                  {currentVersions.length > 1 && <ChevronDown className="w-3 h-3" />}
                </button>
              )}

              {versionMenuOpen && currentVersions.length > 1 && (
                <div
                  role="menu"
                  className={cn(
                    'absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50',
                    'min-w-[280px] max-w-[90vw]',
                    'bg-popover text-popover-foreground',
                    'ring-1 ring-border shadow-2xl',
                    'rounded-lg p-1.5',
                    'animate-in fade-in-0 slide-in-from-top-1 duration-150'
                  )}
                >
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Versions
                  </div>
                  {currentVersions.map((video) => {
                    const isActive = activeVideoId
                      ? video.id === activeVideoId
                      : video === currentVersions[0]
                    const isApproved = video.approved === true
                    return (
                      <button
                        key={video.id}
                        role="menuitemradio"
                        aria-checked={isActive}
                        type="button"
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent('selectVideoVersion', {
                              detail: { videoId: video.id },
                            })
                          )
                          setVersionMenuOpen(false)
                        }}
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left',
                          'transition-colors',
                          isActive ? 'bg-primary/15' : 'hover:bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'inline-flex items-center justify-center min-w-[28px] h-5 px-1.5',
                            'text-[10px] font-mono font-bold rounded-full',
                            isActive
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {video.versionLabel || `v${video.version}`}
                        </span>
                        <span className="flex-1 text-sm truncate" title={video.originalFileName || video.name}>
                          {video.originalFileName || video.name}
                        </span>
                        {isApproved && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Toggle buttons */}
          <div className="flex items-center gap-1">

            {/* Comment panel toggle */}
            {showCommentToggle && onToggleCommentPanel && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleCommentPanel}
                className="hidden lg:flex h-8 w-8"
                title={isCommentPanelVisible ? tComments('hideFeedback') : tComments('showFeedback')}
              >
                {isCommentPanelVisible ? (
                  <PanelRightClose className="w-4 h-4" />
                ) : (
                  <PanelRightOpen className="w-4 h-4" />
                )}
              </Button>
            )}

            {/* Language and theme toggles. 1.3.2+: when the host
                provides a `topRightMenu` (admin share page) we render
                that instead of the standalone ThemeToggle — the menu
                already exposes a "Switch theme" entry alongside the
                other admin actions, so two theme controls would be
                redundant. */}
            {showLanguageToggle && <LanguageToggle />}
            {topRightMenu ? topRightMenu : <ThemeToggle />}
            {trailingAction}
          </div>
        </div>
      </div>

      {/* Floating Thumbnail Overlay - Appears below the bar, overlays content */}
      {isExpanded && (
        <div
          className="absolute left-2 right-2 sm:left-3 sm:right-3 top-full z-30 mt-1"
        >
          <div className="bg-background/90 backdrop-blur-md shadow-lg rounded-xl">
            <div className="px-2 py-3 sm:px-4">
              {/* Thumbnails container */}
              <div
                ref={scrollContainerRef}
                className="flex gap-2 sm:gap-3 overflow-x-auto overscroll-x-contain snap-x snap-mandatory justify-center"
                style={{
                  scrollbarWidth: 'none',
                  msOverflowStyle: 'none',
                  WebkitOverflowScrolling: 'touch',
                }}
              >
                {videoNames.map((name) => {
                  const videos = videosByName[name]
                  const hasApprovedVideo = videos.some((v: any) => v.approved === true)
                  const versionCount = videos.length
                  const thumbnailUrl = thumbnailsByName.get(name)
                  const isActive = activeVideoName === name

                  return (
                    <button
                      key={name}
                      data-thumbnail
                      onClick={() => {
                        onVideoSelect(name)
                        setIsExpanded(false) // Close after selection
                      }}
                      className={cn(
                        'shrink-0 rounded-md sm:rounded-lg overflow-hidden snap-start',
                        'bg-muted border-2 transition-all duration-150',
                        'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:ring-offset-background',
                        'w-[80px] sm:w-[110px] md:w-[130px] lg:w-[150px]',
                        isActive
                          ? 'border-primary ring-2 ring-primary/30'
                          : 'border-transparent hover:border-border'
                      )}
                    >
                      {/* Thumbnail */}
                      <div className="aspect-video relative bg-black">
                        {thumbnailUrl ? (
                          <Image
                            src={thumbnailUrl}
                            alt={name}
                            fill
                            sizes="(min-width: 1024px) 150px, (min-width: 640px) 110px, 80px"
                            className="object-contain"
                            draggable={false}
                            unoptimized
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center bg-muted">
                            <Film className="w-5 h-5 sm:w-6 sm:h-6 text-muted-foreground/50" />
                          </div>
                        )}

                        {/* Approved badge */}
                        {hasApprovedVideo && (
                          <div className="absolute top-1 right-1 bg-success text-success-foreground rounded-full p-0.5">
                            <CheckCircle2 className="w-3 h-3" />
                          </div>
                        )}

                        {/* Version count badge */}
                        {versionCount > 1 && (
                          <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5">
                            <Layers className="w-2.5 h-2.5" />
                            <span>{versionCount}</span>
                          </div>
                        )}

                        {/* Active overlay */}
                        {isActive && (
                          <div className="absolute inset-0 bg-primary/10" />
                        )}
                      </div>

                      {/* Name */}
                      <div className="px-1.5 py-1 sm:px-2 sm:py-1.5 bg-card/80">
                        <p
                          className={cn(
                            'text-[10px] sm:text-xs truncate text-center',
                            isActive ? 'text-primary font-medium' : 'text-foreground'
                          )}
                        >
                          {name}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Click outside to close */}
      {isExpanded && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => {
            setIsExpanded(false)
          }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
