'use client'

import Image from 'next/image'
import { useRef, useEffect, useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Film, Layers, PanelRightClose, PanelRightOpen } from 'lucide-react'
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
  /** 2.2.4+: tokenized versions of the active video group, used by
   *  the version-reel expansion below the title bar. Each entry
   *  carries the per-version `thumbnailUrl` + `storyboardUrl`
   *  (signed `/api/content/<token>` URLs) the reel needs to render
   *  per-version thumbnails and hover-scrub. Optional — when omitted
   *  the reel renders a generic placeholder per version (no
   *  thumbnail, no scrub) but the version-switch UX still works. */
  activeVersionsTokenized?: any[]
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
  activeVersionsTokenized,
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

  // 2.2.4+: Threshold for showing left/right page-scroll arrows
  // inside the expanded version reel. Below this we expect the
  // versions to fit comfortably on screen (or scroll via touch),
  // so arrows would just add visual noise.
  const VERSION_REEL_ARROWS_THRESHOLD = 10

  // 2.2.4+: storyboard sprite-sheet hover-scrub. Same constants
  // VideoCard uses for the grid view (10×10 grid = 100 frames per
  // clip). When the mouse moves over a version thumbnail, we map
  // its X position to a fraction (0…1) and shift the sprite via
  // CSS `background-position`. State is per-versionId so multiple
  // adjacent thumbs can be hovered without trampling each other
  // (eg quick mouse-through).
  const STORY_COLS = 10
  const STORY_ROWS = 10
  const STORY_CELLS = STORY_COLS * STORY_ROWS
  const [hoverScrubByVersionId, setHoverScrubByVersionId] = useState<Map<string, number>>(new Map())

  const setVersionScrub = (versionId: string, fraction: number | null) => {
    setHoverScrubByVersionId((prev) => {
      const next = new Map(prev)
      if (fraction === null) next.delete(versionId)
      else next.set(versionId, fraction)
      return next
    })
  }

  const storyboardStyleFor = (storyboardUrl: string | null | undefined, fraction: number | undefined) => {
    if (!storyboardUrl || fraction === undefined) return undefined
    const idx = Math.max(0, Math.min(STORY_CELLS - 1, Math.floor(fraction * STORY_CELLS)))
    const col = idx % STORY_COLS
    const row = Math.floor(idx / STORY_COLS)
    const xPct = (col / (STORY_COLS - 1)) * 100
    const yPct = (row / (STORY_ROWS - 1)) * 100
    return {
      backgroundImage: `url(${storyboardUrl})`,
      backgroundSize: `${STORY_COLS * 100}% ${STORY_ROWS * 100}%`,
      backgroundPosition: `${xPct}% ${yPct}%`,
      backgroundRepeat: 'no-repeat' as const,
    }
  }

  const scrollVersionReel = (direction: 'left' | 'right') => {
    const container = scrollContainerRef.current
    if (!container) return
    // Page-by-80%-of-container — leaves a visual overlap so the
    // user keeps context across paging clicks.
    const delta = container.clientWidth * 0.8 * (direction === 'left' ? -1 : 1)
    container.scrollBy({ left: delta, behavior: 'smooth' })
  }

  // 2.2.4+: The expanded reel now shows ONLY the versions of the
  // active video instead of every clip in the folder/project.
  // Pre-2.2.4 click-on-title would dump 50+ siblings into the
  // overlay; that's an item picker masquerading as a version
  // picker. The new behaviour:
  //   - 1 version  → title is NOT clickable (cursor-default, no
  //     hover, button is `disabled`)
  //   - 2+ versions → click flips the reel open, showing each
  //     version's thumbnail + label
  //   - 10+ versions → left/right arrow buttons fade in inside
  //     the reel for keyboard-free paging
  //
  // `canExpandVersionReel` is computed from `currentVersions`
  // (declared further down). The handler closes over a getter
  // function so we don't run into a TDZ at function-scope.
  const handleToggleExpanded = () => {
    if ((videosByName[activeVideoName] || []).length < 2) return
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

  // Reset scroll flag when collapsing
  useEffect(() => {
    if (!isExpanded) {
      hasScrolledRef.current = false
    }
  }, [isExpanded])

  // Get current video info
  const currentVideos = activeVideoName ? videosByName[activeVideoName] : []
  const hasApprovedCurrent = currentVideos.some((v: any) => v.approved === true)

  // 2.2.4+: Versions of the active video, sorted ASCENDING so the
  // reel reads left-to-right v1 → v2 → v3 → … This matches a
  // chronological release timeline (oldest on the left, newest on
  // the right) — same direction the user reads. Pre-2.2.4 this
  // was newest-first which felt right for the chip dropdown but
  // backwards for the thumbnail strip.
  //
  // We MERGE by id — start from raw `currentVideos` (so order +
  // complete set is preserved even if tokenization is still in
  // flight) and overlay the tokenized fields (thumbnailUrl,
  // storyboardUrl) from `activeVersionsTokenized` when present.
  const currentVersions = useMemo(() => {
    const tokenizedById = new Map<string, any>()
    if (Array.isArray(activeVersionsTokenized)) {
      for (const v of activeVersionsTokenized) {
        if (v?.id) tokenizedById.set(v.id, v)
      }
    }
    return [...currentVideos]
      .map((v: any) => {
        const t = tokenizedById.get(v.id)
        return t ? { ...v, ...t } : v
      })
      .sort((a: any, b: any) => (a.version ?? 0) - (b.version ?? 0))
  }, [currentVideos, activeVersionsTokenized])

  // 2.2.4+: Scroll to active VERSION (not video name) when the
  // reel is expanded. Index lookups go through `currentVersions`
  // so on large version histories the active version is centered
  // in the viewport.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !isExpanded) return
    if (hasScrolledRef.current) return
    if (currentVersions.length < 2) return

    const versionIdx = currentVersions.findIndex((v: any) =>
      activeVideoId ? v.id === activeVideoId : v === currentVersions[currentVersions.length - 1]
    )
    if (versionIdx < 0) return

    const thumbnails = container.querySelectorAll('[data-thumbnail]')
    const activeThumbnail = thumbnails[versionIdx] as HTMLElement
    if (!activeThumbnail) return

    const containerWidth = container.clientWidth
    const thumbnailLeft = activeThumbnail.offsetLeft
    const thumbnailWidth = activeThumbnail.offsetWidth
    const scrollTo = thumbnailLeft - containerWidth / 2 + thumbnailWidth / 2

    container.scrollTo({ left: scrollTo, behavior: 'smooth' })
    hasScrolledRef.current = true
  }, [activeVideoId, currentVersions, isExpanded])

  // Derive the active version's label for the chip. We try (in order):
  //   1) activeVideoId match → that video's versionLabel
  //   2) latest version's versionLabel (newest first)
  //   3) `v{n}` fallback
  const activeVideo =
    (activeVideoId
      ? currentVersions.find((v: any) => v.id === activeVideoId)
      : null) || currentVersions[currentVersions.length - 1]
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
      {/* 2.5.1+ refresh — bar wrapper is transparent, same as the
          AdminTopBar pattern. Only the individual elements (Back
          pill, version chip, panel toggle, kebab) carry glass
          surfaces; the row itself just structures the layout. */}
      <div className="px-3 py-2 sm:px-4 sm:py-2.5">
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Left: Back to grid */}
          <div className="flex items-center">
            {showBackButton && onBackToGrid && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBackToGrid}
                // 2.5.1+: glass pill matching the rest of the v2.5
                // back buttons (project / folder pages). White text,
                // hairline ring, low-opacity bg with hover lift.
                className="shrink-0 gap-1.5 px-2 sm:px-3 h-8 bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 hover:ring-white/20 text-white border-0"
                title={backLabel ?? tShare('backToAllVideos')}
              >
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
                disabled={currentVersions.length < 2}
                className={cn(
                  // 2.5.1+: persistent glass pill — mirrors the
                  // AdminTopBar search button so the center column
                  // reads as the same affordance everywhere in the
                  // app. Rounded-lg + h-9 + `bg-white/[0.06]` ring
                  // by default; bumps to `bg-white/[0.12]` on hover
                  // or when the versions dropdown is open.
                  "flex items-center gap-2 min-w-0 px-3 h-9 rounded-lg transition-all max-w-[40vw] sm:max-w-[50vw]",
                  "bg-white/[0.06] ring-1 ring-white/10",
                  currentVersions.length >= 2
                    ? "hover:bg-white/[0.12] hover:ring-white/20 active:scale-95 cursor-pointer"
                    : "cursor-default",
                  isExpanded && currentVersions.length >= 2 && "bg-white/[0.12] ring-white/20"
                )}
                title={
                  currentVersions.length < 2
                    ? 'This video has only one version'
                    : isExpanded
                      ? 'Hide versions'
                      : 'Show versions'
                }
              >
                {/* 1.7.0+: removed the CheckCircle2 approval glyph
                    that used to sit in front of the filename — the
                    same approval state is already surfaced on the
                    Approve button below the title bar, so a second
                    indicator here just crowded the line. */}
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
                    // 1.7.0+: bigger primary-blue pill so the
                    // active version reads as a clear status
                    // badge instead of a muted secondary chip.
                    // Height jumps to 7, font goes uppercase +
                    // wider tracking + bold, and we use the
                    // theme primary tokens for the fill.
                    'inline-flex items-center gap-1 shrink-0 h-7 pl-2.5 pr-1.5 rounded-full',
                    'text-xs font-semibold uppercase tracking-wider tabular-nums',
                    'bg-primary text-primary-foreground shadow-sm',
                    'transition-colors',
                    currentVersions.length > 1 && 'hover:bg-primary/90 active:scale-95 cursor-pointer',
                    currentVersions.length < 2 && 'cursor-default'
                  )}
                  title={
                    currentVersions.length > 1
                      ? 'Switch version'
                      : 'This video has only one version'
                  }
                >
                  <span>{activeVersionLabel}</span>
                  {currentVersions.length > 1 && <ChevronDown className="w-3.5 h-3.5" />}
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
                      : video === currentVersions[currentVersions.length - 1]
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
                // 2.5.1+: glass icon button matching the kebab next
                // to it so the right cluster reads as a pair.
                className="hidden lg:flex h-8 w-8 bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 hover:ring-white/20 text-white border-0"
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

      {/* 2.2.4+: Floating VERSION reel — shows the active video's
          versions (not other videos in the folder/project). When
          ≥10 versions are present, left/right arrow buttons appear
          inside the panel for paging. */}
      {isExpanded && currentVersions.length >= 2 && (
        <div
          className="absolute left-2 right-2 sm:left-3 sm:right-3 top-full z-30 mt-1"
        >
          {/* 2.5.1+: glass panel matching the rest of the v2.5
              vocabulary — soft white tint over `.spotlight-bg`,
              hairline ring, deep outward shadow so it reads as
              elevated above the player. */}
          <div
            className="rounded-xl bg-white/[0.06] ring-1 ring-white/15 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.7)]"
            style={{
              backdropFilter: 'blur(20px) saturate(140%)',
              WebkitBackdropFilter: 'blur(20px) saturate(140%)',
            }}
          >
            {/* 2.5.1+: vertical padding moved off the outer wrapper
                so the scroll container's implicit overflow-y clip
                (a side effect of `overflow-x-auto`) doesn't cut the
                tiles' drop shadow + brand-blue highlight glow at
                the bottom. The horizontal padding stays on the
                outer so the arrow buttons sit flush with the
                wrapper's edge. */}
            <div className="px-2 sm:px-4 relative">
              {currentVersions.length > VERSION_REEL_ARROWS_THRESHOLD && (
                <button
                  type="button"
                  aria-label="Scroll versions left"
                  onClick={() => scrollVersionReel('left')}
                  className={cn(
                    'absolute left-1 sm:left-2 top-1/2 -translate-y-1/2 z-10',
                    'h-8 w-8 rounded-full bg-white/[0.08] ring-1 ring-white/15 shadow-md text-white',
                    'flex items-center justify-center backdrop-blur-md',
                    'hover:bg-white/[0.14] hover:ring-white/25 transition-colors',
                  )}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}

              <div
                ref={scrollContainerRef}
                className={cn(
                  // 2.5.1+: `py-3` lives here (not on the outer
                  // wrapper) so each tile gets ~12px of breathing
                  // room above + below INSIDE the scroll container's
                  // implicit overflow-y clip — enough for the drop
                  // shadow + brand-blue glow ring to render fully on
                  // every side instead of getting chopped at the
                  // bottom edge.
                  'flex gap-2 sm:gap-3 py-3 overflow-x-auto overscroll-x-contain snap-x snap-mandatory',
                  currentVersions.length > VERSION_REEL_ARROWS_THRESHOLD
                    ? 'px-10 justify-start'
                    : 'justify-center',
                )}
                style={{
                  scrollbarWidth: 'none',
                  msOverflowStyle: 'none',
                  WebkitOverflowScrolling: 'touch',
                }}
              >
                {currentVersions.map((version: any) => {
                  const isActive = activeVideoId
                    ? version.id === activeVideoId
                    : version === currentVersions[currentVersions.length - 1]
                  const versionThumb: string | undefined = version.thumbnailUrl
                  const versionStoryboard: string | undefined = version.storyboardUrl
                  const versionApproved = version.approved === true
                  const versionLabel = version.versionLabel || `v${version.version}`
                  const scrubFraction = hoverScrubByVersionId.get(version.id)
                  const isScrubbing = scrubFraction !== undefined
                  const scrubStyle = storyboardStyleFor(versionStoryboard, scrubFraction)

                  const handleScrub = (e: React.MouseEvent<HTMLButtonElement>) => {
                    if (!versionStoryboard) return
                    const rect = e.currentTarget.getBoundingClientRect()
                    const x = e.clientX - rect.left
                    const fraction = Math.max(0, Math.min(1, x / rect.width))
                    setVersionScrub(version.id, fraction)
                  }

                  return (
                    <button
                      key={version.id}
                      data-thumbnail
                      onClick={() => {
                        // Reuse the same event the version chip
                        // dropdown dispatches — VideoPlayer listens
                        // for it and jumps to the right index.
                        window.dispatchEvent(
                          new CustomEvent('selectVideoVersion', {
                            detail: { videoId: version.id },
                          })
                        )
                        setIsExpanded(false)
                      }}
                      onMouseMove={handleScrub}
                      onMouseLeave={() => setVersionScrub(version.id, null)}
                      className={cn(
                        // 2.5.1+: glass tile — drops `bg-muted` +
                        // `border-2` chrome in favour of the v2.5
                        // `bg-white/[0.04]` + ring pattern. Every
                        // tile gets a soft outward shadow so it
                        // reads as a layer floating ABOVE the
                        // panel — that's how the user told them
                        // apart from the wrapper. Active tile
                        // keeps the brand-blue ring so it stays
                        // the strongest signal in the panel.
                        'shrink-0 rounded-md sm:rounded-lg overflow-hidden snap-start',
                        'bg-white/[0.04] transition-all duration-150',
                        'shadow-[0_6px_18px_-8px_rgba(0,0,0,0.55)]',
                        'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:ring-offset-background',
                        'w-[80px] sm:w-[110px] md:w-[130px] lg:w-[150px]',
                        isActive
                          // 2.5.1+: only a clean white outline ring
                          // marks the active tile — dropped the blue
                          // halo glow so the icon stays neutral and
                          // the highlight reads as a crisp border
                          // rather than a wash of accent colour.
                          ? 'ring-2 ring-white shadow-[0_10px_24px_-8px_rgba(0,0,0,0.65)]'
                          : 'ring-1 ring-white/10 hover:ring-white/20 hover:shadow-[0_10px_24px_-8px_rgba(0,0,0,0.65)]'
                      )}
                      title={version.originalFileName || versionLabel}
                    >
                      <div className="aspect-video relative bg-black overflow-hidden">
                        {versionThumb && (
                          // 2.5.1+: `alt=""` so a broken image
                          // doesn't render the version label on top
                          // of the black thumbnail. The footer
                          // below already shows v1 / v2, and the
                          // tile is keyboard-labelled via `title`.
                          <Image
                            src={versionThumb}
                            alt=""
                            fill
                            sizes="(min-width: 1024px) 150px, (min-width: 640px) 110px, 80px"
                            className={cn(
                              'object-contain transition-opacity duration-75',
                              isScrubbing ? 'opacity-0' : 'opacity-100',
                            )}
                            draggable={false}
                            unoptimized
                          />
                        )}
                        {!versionThumb && !isScrubbing && (
                          <div className="absolute inset-0 flex items-center justify-center bg-muted">
                            <Film className="w-5 h-5 sm:w-6 sm:h-6 text-muted-foreground/50" />
                          </div>
                        )}
                        {/* Storyboard scrub layer — only visible while
                            mouse is over the tile. CSS background-
                            position swaps in the right sprite cell
                            without any image swap or seek. */}
                        {versionStoryboard && (
                          <div
                            className={cn(
                              'absolute inset-0 transition-opacity duration-75',
                              isScrubbing ? 'opacity-100' : 'opacity-0',
                            )}
                            style={scrubStyle}
                            aria-hidden
                          />
                        )}

                        {versionApproved && (
                          <div className="absolute top-1 right-1 bg-success text-success-foreground rounded-full p-0.5">
                            <CheckCircle2 className="w-3 h-3" />
                          </div>
                        )}

                        {/* 2.5.1+: dropped the `bg-primary/10`
                            overlay that used to wash the active
                            cover blue — the ring + the bold footer
                            already make the active state obvious,
                            and the wash dulled the actual
                            thumbnail. */}
                      </div>

                      {/* 2.5.1+: footer with its own distinct
                          surface so the label band reads as a clearly
                          different layer from the video cover above
                          it. Background stays neutral glass on
                          BOTH active and inactive tiles — the
                          brand-blue tint that used to wash the
                          active footer was redundant with the
                          white ring + the blue label text, and it
                          dulled the layered look. */}
                      <div className="px-1.5 py-1.5 sm:px-2 sm:py-2 flex items-center justify-center gap-1 bg-white/[0.08] border-t border-white/10">
                        {/* 2.5.1+: label text stays white for both
                            active and inactive tiles so it always
                            reads cleanly against the glass footer.
                            The white ring around the active tile is
                            what marks it — no need to colour the
                            label too. */}
                        <span
                          className={cn(
                            'text-[10px] sm:text-xs font-mono font-semibold tracking-wider',
                            isActive ? 'text-white' : 'text-white/85'
                          )}
                        >
                          {versionLabel}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>

              {currentVersions.length > VERSION_REEL_ARROWS_THRESHOLD && (
                <button
                  type="button"
                  aria-label="Scroll versions right"
                  onClick={() => scrollVersionReel('right')}
                  className={cn(
                    'absolute right-1 sm:right-2 top-1/2 -translate-y-1/2 z-10',
                    'h-8 w-8 rounded-full bg-background/95 ring-1 ring-border shadow-md',
                    'flex items-center justify-center',
                    'hover:bg-muted transition-colors',
                  )}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
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
