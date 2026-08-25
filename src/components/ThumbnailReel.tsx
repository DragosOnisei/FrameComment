'use client'

import Image from 'next/image'
import { useRef, useEffect, useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Film, GitCompareArrows, Layers, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { videoUploadMeta } from '@/lib/video-upload-meta'
import { useNowMs } from '@/lib/use-now'
import { storyboardCellStyle, storyboardGridOf } from '@/lib/storyboard-grid'
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
  /** 3.2.6+: theme (light/dark) toggle visibility. Defaults to true to
   *  keep existing behaviour everywhere else. The CLIENT share player
   *  passes `false` — clients shouldn't get a light-mode switch (the
   *  public share is dark-only by design). */
  showThemeToggle?: boolean
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
  showThemeToggle = true,
  trailingAction,
  topRightMenu,
  activeVideoId,
  activeVersionsTokenized,
}: ThumbnailReelProps) {
  const tShare = useTranslations('share')
  // 7.1.0: drives the "(22 Hours ago)" tag under the title.
  const nowMs = useNowMs()
  const tComments = useTranslations('comments')
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // 3.2.x: click-and-drag (mouse) horizontal panning of the version
  // reel. `moved` tracks whether the pointer travelled far enough to
  // count as a drag, so a drag doesn't also fire a tile's version-
  // select click. Touch devices already scroll natively.
  const reelDragRef = useRef<{ active: boolean; startX: number; startScroll: number; moved: boolean }>({
    active: false,
    startX: 0,
    startScroll: 0,
    moved: false,
  })
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
  // inside the expanded version reel. At or below this the versions
  // fit comfortably; above it the reel left-aligns and shows arrows
  // for paging.
  // 3.2.x: lowered 10 → 4 so a video with MORE than 4 versions gets a
  // horizontal scroll (arrows + overflow) to reach them all, per the
  // requested "v1, v2, v3 … left-to-right, scroll past 4" behaviour.
  const VERSION_REEL_ARROWS_THRESHOLD = 4

  // 2.2.4+: storyboard sprite-sheet hover-scrub. Same constants
  // VideoCard uses for the grid view (10×10 grid = 100 frames per
  // clip). When the mouse moves over a version thumbnail, we map
  // its X position to a fraction (0…1) and shift the sprite via
  // CSS `background-position`. State is per-versionId so multiple
  // adjacent thumbs can be hovered without trampling each other
  // (eg quick mouse-through).
  const [hoverScrubByVersionId, setHoverScrubByVersionId] = useState<Map<string, number>>(new Map())

  const setVersionScrub = (versionId: string, fraction: number | null) => {
    setHoverScrubByVersionId((prev) => {
      const next = new Map(prev)
      if (fraction === null) next.delete(versionId)
      else next.set(versionId, fraction)
      return next
    })
  }

  // 6.11.0: uses the shared per-video geometry. This was still hardcoded to
  // 10×10 after 6.9.3 made the sprite grid scale with duration — so the
  // version-reel hover-scrub read the wrong cells on any new upload.
  const storyboardStyleFor = (
    storyboardUrl: string | null | undefined,
    fraction: number | undefined,
    version?: { storyboardCols?: number | null; storyboardRows?: number | null },
  ) => {
    if (!storyboardUrl || fraction === undefined) return undefined
    return storyboardCellStyle(storyboardUrl, fraction, storyboardGridOf(version))
  }

  const scrollVersionReel = (direction: 'left' | 'right') => {
    const container = scrollContainerRef.current
    if (!container) return
    // Page-by-80%-of-container — leaves a visual overlap so the
    // user keeps context across paging clicks.
    const delta = container.clientWidth * 0.8 * (direction === 'left' ? -1 : 1)
    container.scrollBy({ left: delta, behavior: 'smooth' })
  }

  // 3.2.x: drag-to-scroll the version reel with the mouse. We attach
  // move/up listeners to the window on mousedown so the drag keeps
  // tracking even when the cursor leaves the strip or passes over a
  // tile, and remove them on release.
  const handleReelMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return // left button only
    const el = scrollContainerRef.current
    if (!el) return
    reelDragRef.current = {
      active: true,
      startX: e.clientX,
      startScroll: el.scrollLeft,
      moved: false,
    }
    // 3.2.x: turn OFF scroll-snap while dragging. With
    // `snap-mandatory` left on, the browser keeps yanking the strip
    // back to the nearest tile mid-drag, which feels sticky/jumpy.
    // Disabling it lets the reel follow the pointer 1:1 and smoothly;
    // we restore snap on release so it settles neatly on a tile.
    el.style.scrollSnapType = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!reelDragRef.current.active) return
      const dx = ev.clientX - reelDragRef.current.startX
      if (Math.abs(dx) > 4) reelDragRef.current.moved = true
      el.scrollLeft = reelDragRef.current.startScroll - dx
    }
    const onUp = () => {
      reelDragRef.current.active = false
      // Restore the class-based `snap-x snap-mandatory` so the strip
      // settles on the nearest tile after the drag ends.
      el.style.scrollSnapType = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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

  // 6.11.0: plain alphabetical. The list used to put "for review" before
  // "approved", which meant approving a clip moved it — the order shifted
  // under you as a side effect of an unrelated action.
  const videoNames = useMemo(
    () => Object.keys(videosByName).sort((a, b) => a.localeCompare(b)),
    [videosByName],
  )

  // Used by the expanded thumbnail grid below the bar to highlight the
  // active row. The previous "1/N" counter + prev/next arrows have been
  // dropped from the centre of the bar in favour of the breadcrumb-style
  // filename + version dropdown — see the JSX below.
  const activeIndex = videoNames.indexOf(activeVideoName)
  // 6.3.0: step between the videos of THIS folder without going back to the
  // grid.
  //
  // 6.9.0: no more wrap-around. Looping from the last clip back to the first
  // made the arrows lie about where you are — pressing "next" on the last
  // video silently restarted the folder. Each arrow now only exists when
  // there is somewhere to go, so the ends of the list are visible.
  const canStepVideos = videoNames.length > 1 && activeIndex >= 0
  const canStepPrev = canStepVideos && activeIndex > 0
  const canStepNext = canStepVideos && activeIndex < videoNames.length - 1
  const stepVideo = (delta: 1 | -1) => {
    if (!canStepVideos) return
    const next = activeIndex + delta
    if (next < 0 || next >= videoNames.length) return
    const name = videoNames[next]
    if (name && name !== activeVideoName) onVideoSelect(name)
  }

  // Reset scroll flag when collapsing
  useEffect(() => {
    if (!isExpanded) {
      hasScrolledRef.current = false
    }
  }, [isExpanded])

  // Get current video info
  const currentVideos = activeVideoName ? videosByName[activeVideoName] : []

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

  // 4.2.4+: the header shows the video's NAME — the same value the grid
  // card shows and the one "Rename" edits — NOT the uploaded file's
  // original filename.
  //
  // History: 1.0.6+ used `originalFileName` here for "per-version
  // identity". But in this app every version of a stack shares one
  // `name` (see /api/videos/[id]/stack), and versions are already told
  // apart by the Vx chip + upload timestamp below — so there's no need
  // to derive identity from the raw filename. Worse, `originalFileName`
  // is whatever the file was called when the editor exported it: if v3
  // was exported as "Script 1_1.mp4", the header read "Script 1_1" even
  // though the video is named "FFN_3 …", and a Rename (which updates
  // `name`, never `originalFileName`) couldn't fix it. `activeVideoName`
  // is the group key the parent maps videos by, so it always equals the
  // current (renamed) name. Fall back to the row's `name`, then to the
  // stripped filename only if a name is somehow missing.
  const stripExt = (filename: string | undefined | null) => {
    if (!filename) return ''
    const dot = filename.lastIndexOf('.')
    return dot > 0 ? filename.slice(0, dot) : filename
  }
  // 5.13.2: Frame.io-style per-version titles. The LATEST version keeps
  // showing the stack's current NAME (the value the grid card shows and
  // Rename edits — preserving the 4.2.4 rationale above). But when the
  // user flips the chip to an OLDER version, the title switches to that
  // version's ORIGINAL upload name — stacking renames every row to the
  // newest video's name, and the raw filename is the only per-version
  // identity left ("what was this called back then?"). Example: a stack
  // named "…_V4" shows "…_V3" in the title while v3 is selected.
  const latestVersionRow = currentVersions[currentVersions.length - 1]
  const isLatestActive =
    !activeVideo || !latestVersionRow || activeVideo.id === latestVersionRow.id
  const displayedHeaderName = isLatestActive
    ? activeVideoName ||
      (activeVideo?.name as string | undefined) ||
      stripExt(activeVideo?.originalFileName) ||
      ''
    : stripExt(activeVideo?.originalFileName) ||
      activeVideoName ||
      (activeVideo?.name as string | undefined) ||
      ''

  // 1.2.0+: the active version's upload timestamp under the title, so the
  // reviewer can see how long passed between v1, v2, v3…
  //
  // 7.1.0: the derivation lives in src/lib/video-upload-meta.ts because the
  // comparison overlay prints the same line, and two copies of "the same line"
  // is how they stop being the same. The clock comes from useNowMs rather than
  // a Date.now() in render — see that hook for why, and note the side effect:
  // the relative tag now ticks over on its own instead of freezing until some
  // unrelated state change re-rendered the bar.
  const { uploadedAtLabel, uploaderName, relativeUploadedLabel } = videoUploadMeta(
    activeVideo,
    nowMs,
  )

  return (
    // 3.2.x: z-40 (was z-20). `relative` + z-index here creates a
    // stacking context, so the expanded version reel inside is capped
    // at THIS level no matter its own z-index. The comments-panel
    // resize handle sits at z-30 in the page's root context, so at
    // z-20 the whole top bar (and thus the reel) rendered BELOW the
    // handle — a click-drag through the versions over the video/comments
    // divider grabbed the resizer instead. Lifting the bar above z-30
    // lets the reel win the pointer across the full strip.
    <div className="relative shrink-0 z-40 p-2 sm:p-3">
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
              {/* 6.3.0: previous video in this folder. */}
              {canStepPrev && (
                <button
                  type="button"
                  onClick={() => stepVideo(-1)}
                  aria-label="Previous video"
                  title="Previous video"
                  className={cn(
                    'shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg',
                    'bg-white/[0.06] ring-1 ring-white/10 text-foreground/80',
                    'hover:bg-white/[0.12] hover:text-foreground transition-colors',
                  )}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}
              <button
                data-tutorial="video-reel-center"
                type="button"
                className={cn(
                  // 2.5.1+: persistent glass pill — mirrors the
                  // AdminTopBar search button so the center column
                  // reads as the same affordance everywhere in the app.
                  // 3.2.x: informational ONLY now — clicking the
                  // filename no longer toggles the version reel. The
                  // reel opens from the Vx chip to its right instead, so
                  // this pill has no click behaviour and a default
                  // cursor.
                  // 7.1.0: no surface behind the title, matching the compare
                  // overlay — which is where Dragos saw it read better. It also
                  // stops the title claiming to be a control: this element has
                  // had no click behaviour since 3.2.x (the version reel opens
                  // from the Vx chip), yet it wore the same glass pill as every
                  // button beside it. The box metrics stay — h-9 keeps it
                  // aligned with the buttons on either side.
                  "flex items-center gap-2 min-w-0 px-3 h-9 rounded-lg max-w-[40vw] sm:max-w-[50vw]",
                  "cursor-default"
                )}
                title={displayedHeaderName || undefined}
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
                      title={
                        uploaderName
                          ? `Uploaded by ${uploaderName} · ${uploadedAtLabel}`
                          : `Uploaded ${uploadedAtLabel}`
                      }
                    >
                      {uploaderName ? (
                        <>
                          <span className="text-foreground/70">{uploaderName}</span>
                          {' · '}
                        </>
                      ) : null}
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
                    // 3.2.x: clicking the version chip now opens the
                    // THUMBNAIL reel below the bar (v1 → v2 → … left to
                    // right) instead of the old vertical filename
                    // dropdown — that's what users expect when they tap
                    // "Vx". Same toggle the title pill uses.
                    if (currentVersions.length > 1) {
                      handleToggleExpanded()
                    }
                  }}
                  disabled={currentVersions.length < 2}
                  aria-expanded={isExpanded}
                  className={cn(
                    // 1.7.0+: bigger primary-blue pill so the
                    // active version reads as a clear status
                    // badge instead of a muted secondary chip.
                    // Font goes uppercase + wider tracking + bold,
                    // and we use the theme primary tokens for the fill.
                    // 7.0.0: the height now matches the h-9 of the prev/next
                    // video buttons and the title pill this chip sits
                    // between. At h-7 it was the one short element in an
                    // otherwise h-9 row, which read as an accident rather
                    // than a deliberate hierarchy. Padding is per-variant
                    // because the ChevronDown only renders on multi-version
                    // stacks — with a single version the old asymmetric
                    // pl-2.5/pr-1.5 pushed the bare label visibly
                    // off-centre inside the pill.
                    'inline-flex items-center gap-1 shrink-0 h-9 rounded-full',
                    currentVersions.length > 1 ? 'pl-3 pr-2' : 'px-3.5',
                    'text-sm font-semibold uppercase tracking-wider tabular-nums',
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
                  {currentVersions.length > 1 && <ChevronDown className="w-4 h-4" />}
                </button>
              )}

              {/* 6.3.0: next video in this folder. */}
              {canStepNext && (
                <button
                  type="button"
                  onClick={() => stepVideo(1)}
                  aria-label="Next video"
                  title="Next video"
                  className={cn(
                    'shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg',
                    'bg-white/[0.06] ring-1 ring-white/10 text-foreground/80',
                    'hover:bg-white/[0.12] hover:text-foreground transition-colors',
                  )}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}

              {/* 3.8.x: Compare versions — opens the existing side-by-side
                  comparison overlay (VideoPlayer listens for the event).
                  Shown ONLY when there are ≥2 versions AND only on large
                  screens (`hidden lg:inline-flex`) — the two-video layout
                  needs the width and it's a desktop review affordance,
                  matching Frame.io. Placed next to the version chip so it
                  reads as a version-related action. */}
              {currentVersions.length >= 2 && (
                <button
                  type="button"
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent('openVersionComparison'))
                  }
                  className={cn(
                    'hidden lg:inline-flex items-center gap-1.5 shrink-0 h-7 px-2.5 rounded-full',
                    'text-xs font-medium',
                    'bg-white/[0.06] ring-1 ring-white/10 text-white',
                    'hover:bg-white/[0.12] hover:ring-white/20 active:scale-95 transition-colors cursor-pointer'
                  )}
                  title="Compare versions"
                >
                  <GitCompareArrows className="w-3.5 h-3.5" />
                  <span>Compare</span>
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
            {topRightMenu ? topRightMenu : (showThemeToggle && <ThemeToggle />)}
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
          // 3.2.x: z-50 (was z-30) so the expanded version reel sits
          // ABOVE the comments-panel resize handle (also z-30). At the
          // video/comments divider the two overlapped at equal z-index
          // and the later-in-DOM resize handle won the pointer, so a
          // click-drag through the versions there grabbed the resizer
          // instead of scrolling the reel. Raising the reel keeps the
          // drag-to-scroll working across the whole strip.
          className="absolute left-2 right-2 sm:left-3 sm:right-3 top-full z-50 mt-1"
        >
          {/* 6.1.1: SOLID accent panel, no glass. The blurred version was
              see-through, so the video underneath bled into the tiles and the
              strip lost contrast. Now it's an opaque accent-tinted surface
              with the same corner gradient the comments panel uses, so the
              two read as one family and the colour tracks the user's accent
              (`--spotlight-tint`). */}
          <div
            className="rounded-xl ring-1 ring-white/15 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.7)]"
            style={{
              backgroundColor:
                'color-mix(in srgb, hsl(var(--spotlight-tint)) 12%, hsl(var(--background)))',
              backgroundImage:
                'radial-gradient(140% 70% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.08) 40%, transparent 72%)',
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
                    // 6.1.1: solid, like the panel — the blurred pill let the
                    // tiles behind it show through as a smear.
                    'h-8 w-8 rounded-full bg-white/[0.10] ring-1 ring-white/15 shadow-md text-white',
                    'flex items-center justify-center',
                    'hover:bg-white/[0.18] hover:ring-white/25 transition-colors',
                  )}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}

              <div
                ref={scrollContainerRef}
                onMouseDown={handleReelMouseDown}
                className={cn(
                  // 3.2.x: grab cursor + drag-to-scroll. `select-none`
                  // stops text/tile selection while dragging.
                  'cursor-grab active:cursor-grabbing select-none',
                  // 2.5.1+: `py-3` lives here (not on the outer
                  // wrapper) so each tile gets ~12px of breathing
                  // room above + below INSIDE the scroll container's
                  // implicit overflow-y clip — enough for the drop
                  // shadow + brand-blue glow ring to render fully on
                  // every side instead of getting chopped at the
                  // bottom edge.
                  // 3.2.x: center the strip when the versions fit (≤4)
                  // so a couple of tiles sit balanced under the title.
                  // Once there are more than 4 (the reel overflows +
                  // shows arrows) switch to left-aligned so the first
                  // tile isn't clipped and the whole row stays
                  // scrollable left-to-right. Tiles are always sorted
                  // v1 → v2 → v3 … regardless of alignment.
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
                  const versionLabel = version.versionLabel || `v${version.version}`
                  const scrubFraction = hoverScrubByVersionId.get(version.id)
                  const isScrubbing = scrubFraction !== undefined
                  const scrubStyle = storyboardStyleFor(versionStoryboard, scrubFraction, version)

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
                        // 3.2.x: if this click was the tail end of a
                        // drag-to-scroll gesture, swallow it so panning
                        // the reel doesn't accidentally switch version.
                        if (reelDragRef.current.moved) {
                          reelDragRef.current.moved = false
                          return
                        }
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
                    // 6.1.1: match the left arrow (it had drifted to the old
                    // light-theme tokens, which read grey on the accent panel).
                    'h-8 w-8 rounded-full bg-white/[0.10] ring-1 ring-white/15 shadow-md text-white',
                    'flex items-center justify-center',
                    'hover:bg-white/[0.18] hover:ring-white/25 transition-colors',
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
