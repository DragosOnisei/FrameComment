'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Comment } from '@prisma/client'
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Trash2, MapPin } from 'lucide-react'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { getUserColor } from '@/lib/utils'
import { timecodeToSeconds, timecodeToSeekSeconds, secondsToTimecode, formatCommentTimestamp } from '@/lib/timecode'
import { isRangeEditActive } from '@/lib/comment-range-edit'
import { useOptionalAnnotation } from '@/contexts/AnnotationContext'
import { storyboardCellStyle, storyboardFraction, storyboardGridOf } from '@/lib/storyboard-grid'
import PlaybackSpeedMenu from './PlaybackSpeedMenu'
import PlayerSettingsMenu, { type QualityChoice } from './PlayerSettingsMenu'
import { AttachmentPreviewStrip, AudioAttachment } from './CommentAttachments'
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
  /**
   * 7.x: called when a comment's marker has been dragged to a new moment.
   * Absent means the timeline is read-only — the client share passes nothing, so
   * a reviewer cannot move somebody else's note by brushing past it.
   */
  onCommentTimecodeChange?: (
    commentId: string,
    /**
     * 7.3.3: `null` when only the range's END moved — the start is then left
     * exactly as stored rather than rewritten from a percentage.
     */
    timecode: string | null,
    timestampMs: number | null,
    /**
     * 7.3.3: the new END of a range comment, when the gesture moved one.
     * `undefined` means "this comment has no range, leave it alone"; the write
     * path only sends the field when it is present.
     */
    timecodeEnd?: string | null,
  ) => void | Promise<void>
  videoId?: string
  /** 3.8.x: signed URL of the storyboard sprite-sheet (10×10 grid of
   *  frames). When present the timeline shows a Frame.io-style
   *  hover-scrub frame preview — the same sprite the folder/version
   *  thumbnails use. Null on clips without a sprite (older / still
   *  processing) → the timeline falls back to a plain timecode badge. */
  storyboardUrl?: string | null
  /** 6.9.3: sprite geometry for THIS video. Absent = the legacy 10×10. */
  storyboardCols?: number | null
  storyboardRows?: number | null
  /** 6.12.0: the duration the sprite was generated from (`Video.duration`).
   *  The cursor is measured against the PLAYER's duration, which can differ
   *  from the original's — see `storyboardFraction`. */
  storyboardDuration?: number | null
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
  /** 4.1.0+: Premiere-style timeline markers (coloured flags) for the
   *  active version. Distinct from the comment pins above — these are
   *  lightweight navigation bookmarks. Click seeks to the marker; hover
   *  shows the optional note; markers the viewer owns (`mine`) get a
   *  delete affordance. */
  flagMarkers?: Array<{
    id: string
    timestampMs: number
    color: string
    label: string | null
    authorName: string | null
    mine: boolean
  }>
  onFlagMarkerDelete?: (id: string) => void
  onFlagMarkerUpdate?: (id: string, patch: { color?: string; label?: string | null }) => void
}

// 4.1.0+: fixed 4-colour palette for Premiere-style flag markers.
const FLAG_COLOR_MAP: Record<string, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
}
const flagColorClass = (c: string) => FLAG_COLOR_MAP[c] || FLAG_COLOR_MAP.blue
// Text-colour variant for the location-pin icon on the timeline.
const FLAG_TEXT_MAP: Record<string, string> = {
  red: 'text-red-500',
  orange: 'text-orange-500',
  green: 'text-green-500',
  blue: 'text-blue-500',
}
const flagTextClass = (c: string) => FLAG_TEXT_MAP[c] || FLAG_TEXT_MAP.blue

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

/**
 * 6.16.0 — a note carried over from an earlier cut draws grey on the timeline.
 *
 * Author colour is the right default: it tells you at a glance who is talking.
 * But for a pasted note that identity is the LESS useful fact — what you need
 * while scanning a new cut is which pins are fresh feedback and which are
 * leftovers from the last round. Grey answers that without a legend, and it
 * matches the amber tag in the thread: both mean "not written here".
 *
 * Grey, not hidden. The pin still seeks, still opens its popover, and the
 * whole reason the notes were pasted is that somebody intends to work through
 * them.
 */
const PREVIOUS_VERSION_COLOR_KEY = 'border-gray-500'

/** Carried over from another cut — pasted from a version, or from the kebab. */
function isCarriedOverComment(comment: any): boolean {
  return !!(comment?.sourceVersionLabel || comment?.isCopied)
}

function markerColorKey(comment: any, fallback: string): string {
  return isCarriedOverComment(comment) ? PREVIOUS_VERSION_COLOR_KEY : fallback
}

/**
 * "C", not the author's initials.
 *
 * On a pin the initials answer "who said this". For a carried-over note that
 * is the wrong question and a slightly misleading answer — the person did not
 * say it here, on this cut. "C" says what the pin actually is, and pairs with
 * the grey so the two cues agree instead of one of them arguing that this is
 * ordinary feedback from a named reviewer.
 */
function markerInitials(comment: any, fallback: string): string {
  return isCarriedOverComment(comment) ? 'C' : fallback
}
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

// 3.8.x: storyboard sprite-scrub — map a 0…1 timeline fraction to the
// matching sprite cell and shift `background-position`. No video seek, no
// extra request: instant frame preview on hover.
//
// 6.9.3: the geometry moved to lib/storyboard-grid and is now PER VIDEO. It
// used to be hardcoded 10×10 here, which was fine while every sprite was
// 10×10 — and silently wrong the moment they weren't.

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
  /** 6.2.1: everything that ISN'T the voice note — images, PDFs, LUTs.
   *  Without these the popover fell back to "No content" for a comment
   *  whose whole point was the attachment. */
  attachments: Array<{
    id: string
    fileName: string
    fileType: string
    isImage: boolean
  }>
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
  onCommentTimecodeChange,
  videoId = '',
  storyboardUrl = null,
  storyboardCols = null,
  storyboardRows = null,
  storyboardDuration = null,
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
  flagMarkers = [],
  onFlagMarkerDelete,
  onFlagMarkerUpdate,
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
  // 4.1.0+: hovered Premiere-style flag marker (separate from comment pins).
  const [hoveredFlagId, setHoveredFlagId] = useState<string | null>(null)
  // 4.1.0+: which flag marker's edit card (colour + note + delete) is open,
  // plus the in-progress note draft for its inline editor.
  const [openFlagId, setOpenFlagId] = useState<string | null>(null)
  const [flagLabelDraft, setFlagLabelDraft] = useState('')
  const flagEditRef = useRef<HTMLDivElement>(null)

  // Close the flag edit card on outside-click / Escape.
  useEffect(() => {
    if (!openFlagId) return
    const onDown = (e: MouseEvent) => {
      if (flagEditRef.current && !flagEditRef.current.contains(e.target as Node)) {
        setOpenFlagId(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenFlagId(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openFlagId])

  // 4.1.2+: throttled scrub seek. On HLS (the server path), setting
  // `currentTime` on every mousemove aborts the in-flight fragment load
  // and kicks off a new one — so nothing ever paints until the drag stops
  // (the classic "frozen scrub", far worse on a slow server disk). Local
  // MP4 seeks complete fast enough to look instant, which is why it only
  // showed on the server. Throttling the drag seeks lets each one land +
  // paint a frame → a live scrub. The final position is always flushed on
  // release so the playhead ends up exactly where the drag stopped.
  const SCRUB_THROTTLE_MS = 100
  const lastScrubTsRef = useRef(0)
  const pendingScrubRef = useRef<number | null>(null)
  const scrubTrailingRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scrubSeek = useCallback(
    (time: number) => {
      pendingScrubRef.current = time
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsed = now - lastScrubTsRef.current
      if (elapsed >= SCRUB_THROTTLE_MS) {
        lastScrubTsRef.current = now
        pendingScrubRef.current = null
        onSeek(time)
      } else if (scrubTrailingRef.current === null) {
        scrubTrailingRef.current = setTimeout(() => {
          scrubTrailingRef.current = null
          if (pendingScrubRef.current !== null) {
            lastScrubTsRef.current =
              typeof performance !== 'undefined' ? performance.now() : Date.now()
            const t = pendingScrubRef.current
            pendingScrubRef.current = null
            onSeek(t)
          }
        }, SCRUB_THROTTLE_MS - elapsed)
      }
    },
    [onSeek],
  )

  const flushScrub = useCallback(() => {
    if (scrubTrailingRef.current !== null) {
      clearTimeout(scrubTrailingRef.current)
      scrubTrailingRef.current = null
    }
    if (pendingScrubRef.current !== null) {
      const t = pendingScrubRef.current
      pendingScrubRef.current = null
      onSeek(t)
    }
  }, [onSeek])
  // 3.5.x: smooth playhead clock. The `currentTime` prop is throttled
  // to ~200ms in VideoPlayer and the browser's `timeupdate` fires
  // irregularly, which made the progress bar lurch — glide, freeze,
  // glide, every second. We keep a local high-frequency clock driven
  // by requestAnimationFrame off the real <video> element so the fill
  // + playhead advance at the display refresh rate (~60fps). The prop
  // still drives everything else (seeks, frame steps, range capture).
  const [smoothTime, setSmoothTime] = useState(currentTime)
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
      // via `displayedProgress` so it stays at IN. Throttled so HLS
      // actually paints intermediate frames instead of freezing.
      scrubSeek(safeOut)
    }
    const onUp = () => {
      // Apply the final OUT frame the throttle may have skipped.
      flushScrub()
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
  }, [isDraggingOutHandle, videoDuration, scrubSeek, flushScrub, videoFps])
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
        const colorKey = markerColorKey(
          comment,
          getUserColor(effectiveAuthorName, isCommentInternal).border,
        )
        const rawContent = comment.content ?? ''
        const normalizedContent = rawContent.replace(/[<>]/g, ' ')

        // 2.5.1+: pick the first audio attachment off the comment
        // (voice messages are recorded one-at-a-time so realistically
        // there's only ever one). If none, audioAsset stays null.
        const assets: any[] = Array.isArray((comment as any).assets)
          ? (comment as any).assets
          : []
        const isAudioAsset = (a: any) =>
          !!a &&
          (a.category === 'audio' ||
            (typeof a.fileType === 'string' && a.fileType.startsWith('audio/')))
        const audio = assets.find(isAudioAsset)
        // 6.2.1: the rest of the attachments, surfaced on the marker so the
        // timeline popover can show them instead of "No content".
        const otherAssets = assets.filter((a) => a && !isAudioAsset(a))

        return {
          id: comment.id,
          timestamp,
          authorName: effectiveAuthorName,
          initials: markerInitials(comment, initialsFromName(effectiveAuthorName)),
          colorKey,
          // 3.8.x: timeline popover preview — up to 300 chars, with a
        // trailing " [...]" marker when the comment was actually longer
        // so the reader knows there's more in the full thread.
        content:
          normalizedContent.length > 300
            ? `${normalizedContent.slice(0, 300).trimEnd()} [...]`
            : normalizedContent,
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
          attachments: otherAssets.map((a) => ({
            id: String(a.id),
            fileName: String(a.fileName ?? 'file'),
            fileType: String(a.fileType ?? ''),
            isImage:
              a.category === 'image' ||
              (typeof a.fileType === 'string' && a.fileType.startsWith('image/')),
          })),
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
        const colorKey = markerColorKey(
          comment,
          getUserColor(effectiveAuthorName, isCommentInternal).border,
        )

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

    // 6.9.0: touching the timeline during playback pauses.
    // Dragging the playhead back a couple of seconds used to seek and then
    // keep rolling from there, so by the time you looked, the frame you
    // wanted had already gone past. Scrubbing is an act of inspection — it
    // should leave you parked on the frame you chose.
    const video = _videoRef?.current
    if (video && !video.paused) {
      video.pause()
    }

    onSeek(time)
  }, [videoDuration, onSeek, videoId, _videoRef])

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
    scrubSeek(time)
  }, [isDragging, videoDuration, scrubSeek])

  const handleTimelineTouchEnd = useCallback(() => {
    setIsDragging(false)
    lastTouchAtRef.current = Date.now()
    flushScrub()
  }, [flushScrub])

  const handleTimelineMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoDuration) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, x / rect.width))
    const time = percentage * videoDuration

    setHoveredTime(time)

    // 7.1.11: the scrub itself is NOT done here any more — see the
    // document-level effect below. This handler only exists on the timeline
    // element, so it stops firing the moment the pointer leaves it, which is
    // exactly what made the playhead "escape" when the hand drifted a few
    // pixels above or below the bar mid-drag.
  }, [videoDuration])

  const handleTimelineMouseLeave = useCallback(() => {
    setHoveredTime(null)
  }, [])

  /**
   * 7.1.11: once the playhead is grabbed, follow the pointer across the whole
   * document — not just across the timeline element.
   *
   * A horizontal drag is not horizontal. The hand rises or falls a few pixels,
   * the pointer leaves the bar, and the React `onMouseMove` on the element stops
   * firing: the playhead freezes where it was and the drag is silently over
   * while the button is still down. The bar is a few pixels tall, so this
   * happened constantly.
   *
   * Only the X axis is read, so vertical travel is simply ignored — drag as far
   * off the bar as you like and the scrub keeps up. This is the same
   * document-level shape the OUT-handle drag has used since it was written;
   * that one got it right and the main playhead did not.
   *
   * `mouseup` was already global, which is why releasing outside the bar always
   * ended the drag correctly. Only the movement was scoped.
   */
  useEffect(() => {
    if (!isDragging) return

    const onMove = (e: MouseEvent | TouchEvent) => {
      const isTouch = 'touches' in e
      const clientX = isTouch
        ? (e as TouchEvent).touches?.[0]?.clientX
        : (e as MouseEvent).clientX
      if (typeof clientX !== 'number') return
      const rect = timelineRef.current?.getBoundingClientRect()
      if (!rect || !videoDuration) return
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      // Stamped for touch only. The timeline-click guard exists to swallow the
      // synthetic click iOS fires after a touch drag; stamping it on a mouse
      // drag would suppress the user's next honest click on the bar.
      if (isTouch) lastTouchAtRef.current = Date.now()
      scrubSeek(pct * videoDuration)
    }

    const onUp = () => {
      setIsDragging(false)
      // Apply the final drag position (the throttle may have skipped it).
      flushScrub()
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
  }, [isDragging, videoDuration, scrubSeek, flushScrub])

  /**
   * 7.x: drag a comment's marker along the timeline to move the note itself.
   *
   * A note left at the wrong frame — a second late because you were watching
   * rather than typing — could only be fixed by deleting it and writing it
   * again, losing its replies, its drawing and its files. Now you slide the
   * bead.
   *
   * Document-level listeners from the outset, deliberately: this is the same
   * gesture that escaped on the playhead until 7.1.11, for the same reason. The
   * bead is 18px, a drag along it is never level, and a handler bound to the
   * element stops being delivered the moment the pointer drifts off. Only X is
   * read, so vertical travel is ignored entirely.
   *
   * Separating a drag from a click needs TWO flags, not one. `moved` says
   * whether this gesture travelled; `suppressNextClick` survives past mouseup,
   * because the click event fires AFTER it and by then the drag state is gone.
   * With a single ref the guard read null at exactly the moment it mattered and
   * every completed drag also seeked the playhead to where the note used to be.
   */
  const [draggingMarker, setDraggingMarker] = useState<{
    commentId: string
    pct: number
    /**
     * 7.3.3: the range's length in percent, when the note being dragged has
     * one. Carried through the gesture so the yellow bar slides WITH the bead
     * instead of staying behind and rubber-banding on release — a range comment
     * moves as one object, which is what Dragos asked for and also the only
     * reading of the gesture that makes sense: the note applies to a stretch of
     * film, and dragging it picks a different stretch, not a different length.
     */
    spanPct: number | null
  } | null>(null)
  const markerDragRef = useRef<{
    commentId: string
    moved: boolean
    /** Where the bead sat when it was grabbed — captured here rather than read
     *  back at release, so the drag effect never has to close over `markers`
     *  and re-bind its listeners mid-gesture. */
    fromPct: number
    /** 7.3.3: same snapshot discipline for the range length. */
    spanPct: number | null
  } | null>(null)
  const suppressNextMarkerClickRef = useRef(false)
  /**
   * 7.x: where the bead stays between letting go and the data catching up.
   *
   * Dropping it used to clear the drag state at once, so for the few hundred
   * milliseconds the PATCH and the refetch take, the marker rendered from the
   * `comments` prop — which still held the OLD moment. You saw it snap back to
   * where it came from and then jump forward again.
   *
   * `fromPct` is what makes clearing this exact rather than a guess: it records
   * where the note WAS at the moment of the drop, so the held position is
   * released the instant the incoming data stops saying that. Comparing against
   * the dropped position instead would need a tolerance, because the saved
   * timecode is frame-quantised and never lands on the pointer exactly.
   */
  const [pendingMarkerPos, setPendingMarkerPos] = useState<{
    commentId: string
    pct: number
    fromPct: number
    /** 7.3.3: so the yellow bar holds its new place too, not just the bead. */
    spanPct: number | null
  } | null>(null)

  const handleMarkerMouseDown = useCallback(
    (marker: MarkerData, e: React.MouseEvent) => {
      if (!onCommentTimecodeChange || !videoDuration) return
      // Left button only; a right-click belongs to the context menu.
      if (e.button !== 0) return
      /**
       * 7.3.6: a pasted note can be dragged again.
       *
       * 7.3.3 deliberately stopped it, on the argument that a carried-over
       * note's timecode is a record of where the problem sat in the OLD cut and
       * that moving it makes a claim about the new one that nobody made. Dragos
       * asked for that rule and then changed his mind, and using it for a week
       * shows why: carrying notes forward is not archiving them, it is a
       * worklist for the new cut. The edit moved, so the moment each note
       * applies to moved with it, and a pin frozen where the old cut had it
       * points at the wrong frame in every version after the first.
       *
       * Editing the WORDS stays shut, and the two are not the same rule. The
       * text is a record of what was said last round and rewriting it would
       * falsify that. The timecode is just where it applies now.
       */
      e.stopPropagation()
      // 7.3.3: does this note cover a stretch? `rangeBars` is the one place
      // that already knows, and it computes its start from exactly the same
      // `timestampMs`-first arithmetic the bead uses — so the width taken from
      // it cannot drift against the bead by a rounding step.
      const bar = rangeBars.find((b) => b.id === marker.id)
      const spanPct =
        bar && bar.endPosition > bar.startPosition
          ? bar.endPosition - bar.startPosition
          : null
      markerDragRef.current = {
        commentId: marker.id,
        moved: false,
        fromPct: marker.position,
        spanPct,
      }
      // 7.x: put the hover popover away for the duration. It sits directly over
      // the timeline, so while dragging a bead it covers the very stretch you
      // are aiming at — you cannot see where you are about to drop the note.
      setHoveredMarkerId(null)
      setDraggingMarker({ commentId: marker.id, pct: marker.position, spanPct })
    },
    [onCommentTimecodeChange, videoDuration, rangeBars],
  )

  useEffect(() => {
    if (!draggingMarker) return

    const onMove = (e: MouseEvent | TouchEvent) => {
      const isTouch = 'touches' in e
      const clientX = isTouch
        ? (e as TouchEvent).touches?.[0]?.clientX
        : (e as MouseEvent).clientX
      if (typeof clientX !== 'number') return
      const rect = timelineRef.current?.getBoundingClientRect()
      if (!rect || !videoDuration) return
      // 7.3.3: a range is clamped by its FAR end, not just its start. Dragging
      // a two-second note to the last frame would otherwise push its end past
      // the end of the film, and the saved `timecodeEnd` would describe a
      // moment that does not exist. The note stops when its tail reaches the
      // end instead — the gesture runs out of room, which is the truth.
      const span = markerDragRef.current?.spanPct ?? null
      const maxPct = span === null ? 1 : Math.max(0, 1 - span / 100)
      const pct = Math.max(0, Math.min(maxPct, (clientX - rect.left) / rect.width))
      if (markerDragRef.current) markerDragRef.current.moved = true
      setDraggingMarker((cur) =>
        cur ? { ...cur, pct: pct * 100 } : cur,
      )
      // The preview IS the video: scrubbing it shows the frame the note is
      // about to belong to, which is the only preview that answers the
      // question being asked. Throttled by scrubSeek so HLS keeps up.
      scrubSeek(pct * videoDuration)
    }

    const onUp = () => {
      const drag = markerDragRef.current
      const current = draggingMarker
      markerDragRef.current = null
      setDraggingMarker(null)
      flushScrub()
      if (!drag || !drag.moved || !current || !videoDuration) return
      // Outlives this handler on purpose — the click lands next.
      suppressNextMarkerClickRef.current = true
      setPendingMarkerPos({
        commentId: drag.commentId,
        pct: current.pct,
        fromPct: drag.fromPct,
        spanPct: drag.spanPct,
      })
      const seconds = (current.pct / 100) * videoDuration
      const fps = videoFps && videoFps > 0 ? videoFps : 24
      // 7.3.3: the end is rebuilt from the new start plus the width that was
      // captured at grab time, rather than from a stored end shifted by a
      // delta. Same result, but this way the length is arithmetically identical
      // before and after the move — a delta computed from percentages would
      // let the range breathe by a frame every time it was dragged.
      const endTimecode =
        drag.spanPct === null
          ? undefined
          : secondsToTimecode(
              Math.min(
                videoDuration,
                ((current.pct + drag.spanPct) / 100) * videoDuration,
              ),
              fps,
            )
      onCommentTimecodeChange?.(
        drag.commentId,
        secondsToTimecode(seconds, fps),
        Math.round(seconds * 1000),
        endTimecode,
      )
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
  }, [draggingMarker, videoDuration, videoFps, scrubSeek, flushScrub, onCommentTimecodeChange])

  /**
   * Release the held position the moment the refreshed data disagrees with where
   * the note used to be — that is the save arriving. The five-second ceiling is
   * for the case where it never does: a PATCH that failed must not leave the
   * bead permanently claiming a moment the comment is not at.
   */
  useEffect(() => {
    if (!pendingMarkerPos) return
    const live = markers.find((m) => m.id === pendingMarkerPos.commentId)
    if (!live || Math.abs(live.position - pendingMarkerPos.fromPct) > 0.01) {
      setPendingMarkerPos(null)
      return
    }
    const t = setTimeout(() => setPendingMarkerPos(null), 5000)
    return () => clearTimeout(t)
  }, [markers, pendingMarkerPos])

  /**
   * 7.3.3 — editing an existing comment's RANGE on the timeline.
   *
   * Until now a range could only be set while writing the comment: the yellow
   * ball belonged to the composer, sat on the playhead, and once the note was
   * posted its stretch was frozen. Fixing a range that was a beat too short
   * meant deleting the note and writing it again, losing its replies and its
   * drawing — the same trap that moving a note used to be before 7.3.0.
   *
   * WHAT ARMS IT
   *
   * The selected comment, not a mode. `activeCommentId` is already the app's
   * answer to "which note am I looking at" — clicking a bubble sets it, clicking
   * it again clears it, and playing clears it too. So a range becomes editable
   * exactly when its comment is the one in focus, and stops being editable the
   * moment it is not. No new state to get out of step, and no new way to exit
   * that a user would have to learn.
   *
   * Derived rather than stored for the same reason: there is nothing to keep in
   * sync. If the comment is refetched with a different range, the handle is
   * simply somewhere else on the next render.
   *
   * Read-only when `onCommentTimecodeChange` is absent, which is how the client
   * share passes through — a reviewer must not be able to re-time someone
   * else's note by dragging.
   */
  const annotationCtx = useOptionalAnnotation()
  const activeCommentId = annotationCtx?.activeCommentId ?? null
  const activeRange = useMemo(() => {
    if (!activeCommentId || !onCommentTimecodeChange) return null
    const bar = rangeBars.find((b) => b.id === activeCommentId)
    if (!bar || bar.endPosition <= bar.startPosition) return null
    // 7.3.6: a pasted range gets its handle back too. Blocking only the resize
    // while allowing the move would be an odd half-state — you could slide a
    // stretch but not say where it ends — and both refusals came from the one
    // decision that has now been reversed. See handleMarkerMouseDown.
    return {
      commentId: activeCommentId,
      inPct: bar.startPosition,
      outPct: bar.endPosition,
    }
  }, [activeCommentId, rangeBars, onCommentTimecodeChange])

  const [rangeOutDrag, setRangeOutDrag] = useState<{
    commentId: string
    pct: number
  } | null>(null)
  const rangeOutDragRef = useRef<{
    commentId: string
    inPct: number
    fromPct: number
    moved: boolean
  } | null>(null)
  /** The same hold-until-the-save-lands trick the bead uses. */
  const [pendingRangeOut, setPendingRangeOut] = useState<{
    commentId: string
    pct: number
    fromPct: number
  } | null>(null)

  /**
   * Where the yellow handle is drawn.
   *
   * Four cases, in the order they take precedence, because two different
   * gestures can be moving this thing and a stale answer is visible as lag:
   *
   *   1. the handle itself is being dragged      → follow the pointer
   *   2. it was just dropped, save in flight     → hold where it was dropped
   *   3. the BEAD is sliding the whole range     → start + the captured length
   *   4. nothing is happening                    → as stored
   *
   * 7.3.3: case 3 is the one that was missing. The strip already travelled with
   * the bead, but the handle read its position from the STORED range, so it sat
   * at the old end for the whole drag and only caught up on release — the range
   * looked like it was stretching, then snapping. It has to be derived from the
   * same two numbers the strip uses, or the two ends of one object disagree
   * about where that object is.
   */
  const activeOutPct = useMemo(() => {
    if (!activeRange) return null
    const id = activeRange.commentId
    if (rangeOutDrag?.commentId === id) return rangeOutDrag.pct
    if (pendingRangeOut?.commentId === id) return pendingRangeOut.pct
    const held =
      draggingMarker?.commentId === id
        ? draggingMarker
        : pendingMarkerPos?.commentId === id
          ? pendingMarkerPos
          : null
    if (held && held.spanPct !== null) return held.pct + held.spanPct
    return activeRange.outPct
  }, [activeRange, rangeOutDrag, pendingRangeOut, draggingMarker, pendingMarkerPos])

  /**
   * 7.3.3: exactly one yellow ball on the track, always.
   *
   * One boolean decides which, so the two renders cannot both fire or both
   * abstain. The fullscreen term matters: the beads and the range strips are
   * hidden there (6.9.0, because a stray yellow dash with nothing to explain it
   * looked like a glitch), so a range handle would be pointing at something
   * invisible — but the composer's ball is a playback control and must stay.
   * Gating them on the same value is what keeps "hide mine in fullscreen" from
   * silently meaning "hide both".
   */
  const showRangeHandle =
    !isFullscreen && activeRange !== null && activeOutPct !== null

  const handleRangeOutDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!activeRange) return
      e.preventDefault()
      e.stopPropagation()
      // The popover sits over the very stretch being resized.
      setHoveredMarkerId(null)
      rangeOutDragRef.current = {
        commentId: activeRange.commentId,
        inPct: activeRange.inPct,
        fromPct: activeRange.outPct,
        moved: false,
      }
      setRangeOutDrag({ commentId: activeRange.commentId, pct: activeRange.outPct })
    },
    [activeRange],
  )

  useEffect(() => {
    if (!rangeOutDrag) return

    const onMove = (e: MouseEvent | TouchEvent) => {
      const isTouch = 'touches' in e
      const clientX = isTouch
        ? (e as TouchEvent).touches?.[0]?.clientX
        : (e as MouseEvent).clientX
      if (typeof clientX !== 'number') return
      const rect = timelineRef.current?.getBoundingClientRect()
      const grab = rangeOutDragRef.current
      if (!rect || !grab || !videoDuration) return
      // Never before its own start. A range that inverted would describe a
      // negative stretch of film; dragged all the way left it collapses to zero
      // width and stays a range, which is undoable by dragging right again.
      // Clearing the range outright on an accidental overshoot would not be.
      const raw = ((clientX - rect.left) / rect.width) * 100
      const pct = Math.max(grab.inPct, Math.min(100, raw))
      grab.moved = true
      setRangeOutDrag((cur) => (cur ? { ...cur, pct } : cur))
      // The video scrubs to the frame the range now ends ON — same reasoning as
      // the bead drag: the only preview that answers the question being asked.
      scrubSeek((pct / 100) * videoDuration)
    }

    const onUp = () => {
      const grab = rangeOutDragRef.current
      const current = rangeOutDrag
      rangeOutDragRef.current = null
      setRangeOutDrag(null)
      flushScrub()
      if (!grab || !grab.moved || !current || !videoDuration) return
      setPendingRangeOut({
        commentId: grab.commentId,
        pct: current.pct,
        fromPct: grab.fromPct,
      })
      const fps = videoFps && videoFps > 0 ? videoFps : 24
      const endSeconds = Math.min(videoDuration, (current.pct / 100) * videoDuration)
      // `null` start: only the end moved, so the start is not rewritten at all.
      onCommentTimecodeChange?.(
        grab.commentId,
        null,
        null,
        secondsToTimecode(endSeconds, fps),
      )
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
  }, [rangeOutDrag, videoDuration, videoFps, scrubSeek, flushScrub, onCommentTimecodeChange])

  /** Release the held end once the refreshed range disagrees with the old one. */
  useEffect(() => {
    if (!pendingRangeOut) return
    const live = rangeBars.find((b) => b.id === pendingRangeOut.commentId)
    if (!live || Math.abs(live.endPosition - pendingRangeOut.fromPct) > 0.01) {
      setPendingRangeOut(null)
      return
    }
    const t = setTimeout(() => setPendingRangeOut(null), 5000)
    return () => clearTimeout(t)
  }, [rangeBars, pendingRangeOut])

  const handleMarkerClick = useCallback((marker: MarkerData, e: React.MouseEvent) => {
    // 7.x: the click that follows a completed drag is the browser's, not the
    // user's — swallow it, or releasing the bead would seek the video to the
    // note's old moment.
    if (suppressNextMarkerClickRef.current) {
      suppressNextMarkerClickRef.current = false
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    e.preventDefault()
    onSeek(marker.timestamp)
    // 7.3.3: the bead becomes the comment in focus, which is what clicking its
    // card in the list already does. That one piece of state is what draws the
    // drawing, lifts the card, and — since 7.3.3 — puts the yellow handle on
    // the note's range, so a bead click and a card click now arrive at the same
    // place. SET rather than toggle, unlike the card: a marker on the timeline
    // always means "take me to this note", and there is no un-going.
    annotationCtx?.setActiveCommentId(marker.id)
    // Notify parent to scroll to comment
    if (onMarkerClick) {
      onMarkerClick(marker.id)
    }
  }, [onSeek, onMarkerClick, annotationCtx])

  const handleMarkerTouchEnd = useCallback((marker: MarkerData, e: React.TouchEvent) => {
    e.stopPropagation()
    e.preventDefault()
    onSeek(marker.timestamp)
    annotationCtx?.setActiveCommentId(marker.id)
    // Notify parent to scroll to comment
    if (onMarkerClick) {
      onMarkerClick(marker.id)
    }
  }, [onSeek, onMarkerClick, annotationCtx])

  // 1.3.1+: debounce the hover-close. The popover sits ~8 px above
  // the marker — when the mouse traverses that gap on its way from
  // the avatar to the popover, neither element is hovered for a
  // frame or two. Without a delay, `mouseleave` fires immediately
  // and the popover disappears before the mouse reaches it. Holding
  // the close for 220 ms gives the cursor time to land on the
  // popover and re-trigger `mouseenter`, which cancels the timer.
  const hoverCloseTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const handleMarkerMouseEnter = useCallback((markerId: string) => {
    // 7.x: passing over other beads mid-drag must not summon their popovers
    // either — the pointer is travelling, not browsing.
    if (markerDragRef.current) return
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

  // Keep the smooth clock pinned to the prop whenever we're NOT
  // free-running (paused, seeked, frame-stepped, version-switched), so
  // seeks land instantly and there's no drift after a pause.
  useEffect(() => {
    if (!isPlaying) setSmoothTime(currentTime)
  }, [isPlaying, currentTime])

  // While playing, sample the real <video> currentTime every animation
  // frame so the bar advances continuously instead of in 200ms steps.
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = () => {
      const v = _videoRef?.current
      if (v) setSmoothTime(v.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, _videoRef])

  const progress = videoDuration > 0 ? (smoothTime / videoDuration) * 100 : 0
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
                3.5.x: the old 200 ms linear width transition was
                dropped. It existed to interpolate between the throttled
                200 ms time samples, but `displayedProgress` is now
                driven by the rAF `smoothTime` clock (≈60fps), so the
                fill already advances frame-by-frame. Keeping a 200 ms
                transition on top of 60fps updates just smeared/lagged
                the bar — removing it is what makes playback glide. */}
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${displayedProgress}%`,
                backgroundColor: 'hsl(var(--spotlight-tint))',
                boxShadow: '0 0 8px hsl(var(--spotlight-tint) / 0.4)',
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
          {/* 6.9.0: hidden in fullscreen, like the avatars they belong to.
              These bars are positioned to run through the centre of the
              comment avatars in the row below the timeline — and that row is
              hidden in fullscreen. The bars were not, so a stray yellow dash
              hung under the progress bar with nothing to explain it. */}
          {!isFullscreen && rangeBars.map((bar) => {
            /**
             * 7.3.3: while its bead is being dragged — and through the hold
             * after release, until the save comes back — the bar travels with
             * it, keeping its length. Without this the yellow strip stayed at
             * the old moment during the whole gesture and then snapped, which
             * read as the range having been left behind.
             *
             * The same two-step override the bead uses, in the same order, so
             * the two can never disagree about where the note is.
             */
            const held =
              draggingMarker?.commentId === bar.id
                ? draggingMarker
                : pendingMarkerPos?.commentId === bar.id
                  ? pendingMarkerPos
                  : null
            const startPosition =
              held && held.spanPct !== null ? held.pct : bar.startPosition
            /**
             * 7.3.3: and when the END is the thing being dragged, the strip
             * grows and shrinks from its fixed start. The two gestures are
             * mutually exclusive — one grabs the bead, the other the yellow
             * handle — so checking the end first is safe and reads in the order
             * the user thinks: where does it end now, else how wide was it.
             */
            const liveOut =
              rangeOutDrag?.commentId === bar.id
                ? rangeOutDrag.pct
                : pendingRangeOut?.commentId === bar.id
                  ? pendingRangeOut.pct
                  : null
            const width =
              liveOut !== null
                ? Math.max(liveOut - startPosition, 0)
                : held && held.spanPct !== null
                  ? held.spanPct
                  : bar.endPosition - bar.startPosition
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
                  left: `${startPosition}%`,
                  width: `${Math.max(width, 0.5)}%`,
                  opacity: 0.9,
                }}
              />
            )
          })}

          {/* 4.1.0+: Premiere-style flag markers. Small coloured tags
              pinned to the top of the track at their timecode. Click
              seeks; hover shows the note + author (and a Delete action
              for markers the viewer owns). stopPropagation on the
              pointer handlers keeps a marker click/press from also
              scrubbing the timeline. */}
          {videoDuration > 0 &&
            flagMarkers.map((m) => {
              const seconds = m.timestampMs / 1000
              const pos = Math.max(0, Math.min(100, (seconds / videoDuration) * 100))
              const isHovered = hoveredFlagId === m.id
              const isOpen = openFlagId === m.id
              const textClass = flagTextClass(m.color)
              return (
                <div
                  key={`flag-${m.id}`}
                  // When the edit card is open we lift the whole marker above
                  // the storyboard scrub preview (z-30). The flag container
                  // establishes its own stacking context, so its z has to
                  // beat the preview's for the card inside to sit on top.
                  className={`absolute top-0 -translate-x-1/2 ${isOpen ? 'z-50' : 'z-20'}`}
                  style={{ left: `${pos}%` }}
                  onMouseEnter={() => setHoveredFlagId(m.id)}
                  onMouseLeave={() =>
                    setHoveredFlagId((cur) => (cur === m.id ? null : cur))
                  }
                >
                  <button
                    type="button"
                    aria-label={m.label ? `Marker: ${m.label}` : 'Marker'}
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      // Click opens the edit card (colour + note + delete).
                      setFlagLabelDraft(m.label || '')
                      setOpenFlagId((cur) => (cur === m.id ? null : m.id))
                    }}
                    className="block cursor-pointer leading-none"
                  >
                    {/* Location-pin marker, tinted by the marker colour. Its
                        tip points down at the exact timecode. */}
                    <MapPin
                      className={`h-5 w-5 ${textClass} drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]`}
                      fill="currentColor"
                      strokeWidth={1.5}
                    />
                  </button>

                  {/* Hover preview (read-only) — hidden while the edit card
                      is open. No actions here anymore. */}
                  {isHovered && !isOpen && (m.label || m.authorName) && (
                    <div
                      className={`pointer-events-none absolute left-1/2 top-10 sm:top-12 mt-1 z-30 w-max min-w-[120px] max-w-[260px] -translate-x-1/2 rounded-lg px-2.5 py-1.5 text-xs text-white ring-1 ring-black/30 shadow-2xl ${flagColorClass(m.color)}`}
                    >
                      {m.label ? (
                        <div className="line-clamp-3 whitespace-pre-wrap break-words font-medium">
                          {m.label}
                        </div>
                      ) : (
                        <div className="italic text-white/80">Marker</div>
                      )}
                      {m.authorName && (
                        <div className="mt-0.5 text-white/80">{m.authorName}</div>
                      )}
                    </div>
                  )}

                  {/* Edit card (on click) — same glass look as the comment
                      cards: avatar + author, inline note edit, colour
                      swatches + delete. Read-only for markers you don't own. */}
                  {isOpen && (
                    <div
                      ref={flagEditRef}
                      onMouseDown={(e) => e.stopPropagation()}
                      onMouseMove={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-full left-1/2 mb-2 z-50 w-64 -translate-x-1/2 rounded-xl p-3 text-white ring-1 ring-white/10 shadow-[0_18px_44px_-10px_rgba(0,0,0,0.75)]"
                      style={{
                        // More opaque than the timeline glass so white text
                        // stays legible floating over a bright video frame,
                        // while still reading as frosted glass like comments.
                        backgroundColor: 'rgba(13, 22, 32, 0.92)',
                        backdropFilter: 'blur(24px) saturate(160%)',
                        WebkitBackdropFilter: 'blur(24px) saturate(160%)',
                      }}
                    >
                      <div className="mb-2 flex items-center gap-2">
                        {m.authorName && <InitialsAvatar name={m.authorName} size="sm" />}
                        <div className="min-w-0 flex-1 truncate text-sm font-medium">
                          {m.authorName || 'Marker'}
                        </div>
                        {m.mine && onFlagMarkerDelete && (
                          <button
                            type="button"
                            title="Delete"
                            aria-label="Delete marker"
                            onClick={() => {
                              onFlagMarkerDelete(m.id)
                              setOpenFlagId(null)
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-white/50 transition-colors hover:bg-white/[0.06] hover:text-red-300"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>

                      {m.mine ? (
                        <input
                          type="text"
                          value={flagLabelDraft}
                          autoFocus
                          onChange={(e) => setFlagLabelDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              onFlagMarkerUpdate?.(m.id, { label: flagLabelDraft.trim() || null })
                              setOpenFlagId(null)
                            }
                          }}
                          onBlur={() =>
                            onFlagMarkerUpdate?.(m.id, { label: flagLabelDraft.trim() || null })
                          }
                          placeholder="Note (optional)"
                          maxLength={200}
                          className="mb-3 w-full rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-sm text-white ring-1 ring-white/10 placeholder:text-white/40 focus:outline-none focus:ring-white/25"
                        />
                      ) : m.label ? (
                        <div className="mb-3 line-clamp-3 whitespace-pre-wrap break-words text-sm text-white/80">
                          {m.label}
                        </div>
                      ) : (
                        <div className="mb-3 text-sm italic text-white/50">No note</div>
                      )}

                      {m.mine && onFlagMarkerUpdate && (
                        <div className="flex items-center gap-2">
                          {(['red', 'orange', 'green', 'blue'] as const).map((c) => {
                            const active = m.color === c
                            return (
                              <button
                                key={c}
                                type="button"
                                aria-label={c}
                                onClick={() => onFlagMarkerUpdate(m.id, { color: c })}
                                className={`h-6 w-6 rounded-full ${flagColorClass(c)} transition-transform hover:scale-110 ${
                                  active
                                    ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0f1b26]'
                                    : 'ring-1 ring-black/30'
                                }`}
                              />
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
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
          {/* 4.7.x: in fullscreen we hide the whole comment-selection UI
              (yellow OUT ball + range fill) for a clean, distraction-free
              review — the timeline keeps only the playhead + scrub. */}
          {videoDuration > 0 && !isFullscreen && (() => {
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
                    of the white ball at rest.
                    7.3.3: except while an existing comment's range is in focus.
                    There is one yellow handle in this design and it means "the
                    end of the range you are working on"; leaving the composer's
                    copy parked on the playhead at the same time would put two
                    identical balls on the track meaning two different things.
                    Deselecting the comment brings it straight back. */}
                {!showRangeHandle && (
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
                    // 3.5.x: dropped the `left 200ms linear` channel —
                    // the playhead now tracks the rAF smoothTime clock,
                    // so a left transition only lags it behind the
                    // white ball during playback. Keep the transform
                    // transition for the hover/drag scale pop.
                    transition: 'transform 150ms ease',
                  }}
                  title="Drag right to mark the comment's end point"
                  aria-label="Drag to set comment out point"
                  data-tutorial="tour-range"
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
                )}
              </>
            )
          })()}

          {/* 7.3.3: the yellow handle for the range of the comment in focus.
              Same ball, same size, same grab affordance as the composer's —
              deliberately, because it does the same job: it is the end of the
              stretch being defined. It just belongs to a note that already
              exists. Dragging it resizes; dragging the note's avatar moves the
              whole range; and the two cannot run at once because each starts
              from its own element. */}
          {showRangeHandle && activeOutPct !== null && (
            <button
              type="button"
              onMouseDown={handleRangeOutDown}
              onTouchStart={handleRangeOutDown}
              className={`
                absolute -top-1 sm:-top-1.5 z-40
                w-3 h-3 sm:w-3.5 sm:h-3.5 rounded-full
                bg-warning ring-2 ring-black/40
                shadow-md cursor-ew-resize
                hover:scale-110 active:scale-100
                touch-none
                ${rangeOutDrag ? 'scale-125 shadow-lg' : ''}
              `}
              style={{
                left: `${activeOutPct}%`,
                transform: 'translateX(-50%)',
                transition: 'transform 150ms ease',
              }}
              title="Drag to change where this comment's range ends"
              aria-label="Drag to change the end of this comment's range"
              /* 7.3.3: read by CommentSection's outside-click listener, which
                 must not treat grabbing this handle as "the user moved on from
                 the comment" — resizing a note is working on it. */
              data-range-handle
            >
              {/* Same invisible phone hit-zone the composer's ball carries, and
                  for the same reason — a 14px target is not a thumb target. */}
              <span
                aria-hidden="true"
                className="
                  sm:hidden absolute
                  -top-5 -left-3 -right-3 bottom-0
                "
              />
            </button>
          )}

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
              // 3.5.x: dropped `left 200ms linear` — see the fill above.
              // The white playhead now rides the rAF smoothTime clock.
              transition: 'opacity 150ms ease',
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
          {hoveredTime !== null && !isDragging && videoDuration > 0 && (() => {
            // Position follows the PLAYER's timeline; the sprite lookup uses
            // the sprite's own timebase. Conflating the two is what made the
            // preview drift towards the end of a clip.
            const leftPct = Math.max(0, Math.min(1, hoveredTime / videoDuration)) * 100
            const spriteFrac = storyboardFraction(hoveredTime, videoDuration, storyboardDuration)
            const tc = formatTimeWithMode(
              hoveredTime,
              videoFps && videoFps > 0 ? videoFps : 24,
              videoDuration,
              timestampDisplayMode,
            )
            // With a storyboard we render a ~160px-wide frame preview and
            // clamp its center so the box never spills past either edge
            // of the timeline (half-width ≈ 84px). Without a sprite we
            // keep the original compact timecode badge.
            return (
              <div
                className="hidden sm:block absolute bottom-full mb-3 pointer-events-none z-30"
                style={{
                  left: storyboardUrl
                    ? `clamp(84px, ${leftPct}%, calc(100% - 84px))`
                    : `${leftPct}%`,
                  transform: 'translateX(-50%)',
                }}
              >
                {storyboardUrl ? (
                  <div className="rounded-lg overflow-hidden ring-1 ring-white/20 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.85)] bg-black">
                    <div
                      className="w-[160px] aspect-video bg-black"
                      style={storyboardCellStyle(storyboardUrl, spriteFrac, storyboardGridOf({ storyboardCols, storyboardRows }))}
                      aria-hidden
                    />
                    <div className="px-2 py-1 text-center text-[11px] font-mono text-white bg-black/85 border-t border-white/10 tabular-nums whitespace-nowrap">
                      {tc}
                    </div>
                  </div>
                ) : (
                  <div className="px-2 py-1 bg-black/90 text-white text-xs font-mono rounded border border-white/20 shadow-lg whitespace-nowrap tabular-nums">
                    {tc}
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </div>

      {/* Avatar Row (Frame.io-style):
          Identity chips for each comment, rendered BELOW the timeline so
          they don't visually fight with the playhead. Each avatar is
          positioned at the same horizontal % as its dot above. Click +
          hover behave like the old in-track chip — seek, scroll to
          comment, and surface the tooltip. */}
      {/* 4.7.x: comment avatars are hidden in fullscreen (distraction-free). */}
      {!isFullscreen && groupedMarkers.length > 0 && (
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
            /**
             * 7.3.3: the live position — dragged, pending, or stored — hoisted
             * out of the style prop because two things need it now: where the
             * bead sits, and which side its count badge hangs off.
             */
            const markerPct =
              draggingMarker?.commentId === primaryMarker.id
                ? draggingMarker.pct
                : pendingMarkerPos?.commentId === primaryMarker.id
                  ? pendingMarkerPos.pct
                  : primaryMarker.position
            /**
             * 7.3.3: the count badge on a stacked bead normally hangs 4px off
             * the bead's RIGHT edge, which puts its right edge 13px past the
             * bead's centre — and the bead's centre sits exactly on the
             * timeline at `markerPct`. Two comments on the last frame therefore
             * pushed that white "2" 13px outside the player, onto the sidebar.
             *
             * Past this point the badge is anchored to the bead's centre
             * instead (`right-1/2`), which is the version that measures clean.
             * Mirroring it to `-left-1` was the obvious move and is NOT enough:
             * the badge is 14px wide, so hanging it 4px left of an 18px bead
             * still lands its right edge 1px past the centre — measured, at
             * every width, not reasoned about. Anchoring at the centre puts the
             * right edge exactly ON the marker, so the worst case is zero
             * overflow while the badge still overlaps the bead's top corner the
             * way it does everywhere else.
             *
             * The 90% threshold can only ever fire EARLY, never late: a badge
             * needs at most 13px of track to its right, and 10% of any timeline
             * wide enough to be usable is more than that. Firing early costs
             * nothing — the badge is still on its bead, just on the other
             * corner.
             *
             * The bead itself still overhangs by half its width at 100%, as it
             * always has; that is the marker pointing at the frame it belongs
             * to, and pulling it inward would make it point at the wrong one.
             */
            const badgeAtCentre = isStacked && markerPct > 90

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
                className={`absolute top-0 pointer-events-auto ${
                  draggingMarker?.commentId === primaryMarker.id ? 'z-[60]' : 'z-50'
                }`}
                style={{
                  // 7.x: while this bead is being dragged its position comes from
                  // the pointer, not from the stored timecode — so it stays under
                  // the finger instead of springing back until the save lands.
                  left: `${markerPct}%`,
                  transform: 'translateX(-50%)',
                }}
                data-comment-popover
              >
                {/* 7.x: where the note is about to land. The video above is
                    already scrubbing to the same frame — that is the real
                    preview — so this only has to answer "which timecode", which
                    a frame cannot. Sits above the bead and ignores the pointer so
                    it can never intercept the drag it is describing. */}
                {draggingMarker?.commentId === primaryMarker.id && (
                  <div className="absolute -top-7 left-1/2 -translate-x-1/2 pointer-events-none whitespace-nowrap rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white ring-1 ring-white/20">
                    {secondsToTimecode(
                      (draggingMarker.pct / 100) * (videoDuration || 0),
                      videoFps && videoFps > 0 ? videoFps : 24,
                    )}
                  </div>
                )}
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
                  onMouseDown={(e) => handleMarkerMouseDown(primaryMarker, e)}
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
                    <span
                      className={`absolute -top-1 ${
                        badgeAtCentre ? 'right-1/2' : '-right-1'
                      } min-w-[14px] h-[14px] px-0.5 bg-white text-black text-[8px] font-bold rounded-full flex items-center justify-center shadow-md ring-1 ring-black/30 z-10`}
                    >
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
                            <p className="pt-2.5 text-sm sm:text-xs text-white/90 leading-relaxed break-words whitespace-pre-wrap">
                              {marker.content}
                            </p>
                          ) : !marker.audioAsset && marker.attachments.length === 0 ? (
                            <p className="pt-2.5 text-sm sm:text-xs text-white/55 italic leading-relaxed">
                              No content
                            </p>
                          ) : null}
                          {/* 6.2.1: attachments are content too — a comment
                              that is just a reference image used to read as
                              "No content" on the timeline. */}
                          {marker.attachments.length > 0 && (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onTouchStart={(e) => e.stopPropagation()}
                            >
                              <AttachmentPreviewStrip
                                attachments={marker.attachments}
                                videoId={videoId}
                                shareToken={shareToken}
                              />
                            </div>
                          )}
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

          {/* 4.1.0+: frame back/forward buttons removed — frame stepping
              stays available via the ←/→ keyboard shortcuts. */}

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
          {formatTimeWithMode(smoothTime, videoFps, videoDuration, timestampDisplayMode)}
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
