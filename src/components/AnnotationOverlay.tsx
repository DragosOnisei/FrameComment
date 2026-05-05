'use client'

import { useMemo, useState, useEffect, RefObject } from 'react'
import { AnnotationData, Shape } from '@/types/annotations'
import { timecodeToSeconds } from '@/lib/timecode'
import { useOptionalAnnotation } from '@/contexts/AnnotationContext'

interface PendingAnnotation {
  annotations: AnnotationData
  timecode: string
  timecodeEnd?: string | null
}

interface AnnotationOverlayProps {
  comments: Array<{
    id: string
    timecode: string
    timecodeEnd?: string | null
    annotations?: AnnotationData | null
  }>
  currentTime: number
  videoFps: number
  containerRef: RefObject<HTMLDivElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  hidden?: boolean
  pendingAnnotation?: PendingAnnotation | null
}

/**
 * Render an arrow as a single SVG group: a shaft (line that stops short of
 * the tip) plus a triangular head whose tip is exactly at `shape.end`.
 *
 *           p2 (tip)
 *           /\
 *          /  \
 *         /    \
 *  p1 ---+------+----- baseCenter
 *         \    /
 *          \  /
 *           \/
 *
 * Drawing the head as a filled polygon (rather than an SVG <marker>) avoids
 * the subtle rendering glitches we ran into — line caps poking out, marker
 * orientation rounding, etc. The shaft ends at `baseCenter`, well behind
 * the tip, so its end cap is hidden inside the head.
 */
function renderArrow(
  shape: { start: { x: number; y: number }; end: { x: number; y: number }; color: string; strokeWidth: number; id: string },
  renderWidth: number,
  renderHeight: number,
  sw: number,
  shapeOpacity: number,
  key: string
) {
  const x1 = shape.start.x * renderWidth
  const y1 = shape.start.y * renderHeight
  const x2 = shape.end.x * renderWidth
  const y2 = shape.end.y * renderHeight

  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy)

  // Degenerate / zero-length: just draw a tiny line so the user sees feedback.
  if (len < 0.5) {
    return (
      <line
        key={key}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={shape.color}
        strokeWidth={sw}
        strokeLinecap="round"
        opacity={shapeOpacity}
      />
    )
  }

  const ux = dx / len // unit vector along shaft
  const uy = dy / len
  const px = -uy // unit vector perpendicular to shaft (left side)
  const py = ux

  // Arrowhead size scales with stroke width but is also clamped against
  // the line length so a very short arrow doesn't get a giant head.
  const headLen = Math.min(len * 0.5, Math.max(sw * 6, 8))
  const headHalfWidth = headLen * 0.4

  const baseX = x2 - headLen * ux
  const baseY = y2 - headLen * uy
  const leftX = baseX + headHalfWidth * px
  const leftY = baseY + headHalfWidth * py
  const rightX = baseX - headHalfWidth * px
  const rightY = baseY - headHalfWidth * py

  return (
    <g key={key} opacity={shapeOpacity}>
      <line
        x1={x1}
        y1={y1}
        x2={baseX}
        y2={baseY}
        stroke={shape.color}
        strokeWidth={sw}
        strokeLinecap="round"
      />
      <polygon
        points={`${leftX},${leftY} ${x2},${y2} ${rightX},${rightY}`}
        fill={shape.color}
      />
    </g>
  )
}

function renderShape(shape: Shape, renderWidth: number, renderHeight: number, key: string) {
  const sw = shape.strokeWidth * renderWidth
  const shapeOpacity = (shape as any).opacity ?? 1

  if (shape.type === 'freehand') {
    if (shape.points.length < 2) return null
    const points = shape.points
      .map((p) => `${p.x * renderWidth},${p.y * renderHeight}`)
      .join(' ')
    return (
      <polyline
        key={key}
        points={points}
        fill="none"
        stroke={shape.color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={shapeOpacity}
      />
    )
  }

  if (shape.type === 'line') {
    return (
      <line
        key={key}
        x1={shape.start.x * renderWidth}
        y1={shape.start.y * renderHeight}
        x2={shape.end.x * renderWidth}
        y2={shape.end.y * renderHeight}
        stroke={shape.color}
        strokeWidth={sw}
        strokeLinecap="round"
        opacity={shapeOpacity}
      />
    )
  }

  if (shape.type === 'arrow') {
    return renderArrow(shape, renderWidth, renderHeight, sw, shapeOpacity, key)
  }

  if (shape.type === 'rectangle') {
    const x = Math.min(shape.start.x, shape.end.x) * renderWidth
    const y = Math.min(shape.start.y, shape.end.y) * renderHeight
    const w = Math.abs(shape.end.x - shape.start.x) * renderWidth
    const h = Math.abs(shape.end.y - shape.start.y) * renderHeight
    return (
      <rect
        key={key}
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke={shape.color}
        strokeWidth={sw}
        opacity={shapeOpacity}
      />
    )
  }

  return null
}

function getVideoRect(
  video: HTMLVideoElement,
  container: HTMLDivElement
): { offsetX: number; offsetY: number; width: number; height: number } | null {
  const videoWidth = video.videoWidth
  const videoHeight = video.videoHeight
  if (!videoWidth || !videoHeight) return null

  const containerWidth = container.clientWidth
  const containerHeight = container.clientHeight
  if (!containerWidth || !containerHeight) return null

  const containerAspect = containerWidth / containerHeight
  const videoAspect = videoWidth / videoHeight

  let rw: number, rh: number, ox: number, oy: number

  if (videoAspect > containerAspect) {
    rw = containerWidth
    rh = rw / videoAspect
    ox = 0
    oy = (containerHeight - rh) / 2
  } else {
    rh = containerHeight
    rw = rh * videoAspect
    oy = 0
    ox = (containerWidth - rw) / 2
  }

  return { offsetX: ox, offsetY: oy, width: rw, height: rh }
}

export default function AnnotationOverlay({
  comments,
  currentTime,
  videoFps,
  containerRef,
  videoRef,
  hidden = false,
  pendingAnnotation = null,
}: AnnotationOverlayProps) {
  const [rect, setRect] = useState<{ offsetX: number; offsetY: number; width: number; height: number } | null>(null)

  useEffect(() => {
    const recalc = () => {
      const video = videoRef.current
      const container = containerRef.current
      if (!video || !container) return
      const r = getVideoRect(video, container)
      if (r) setRect(r)
    }

    recalc()

    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(recalc)
    observer.observe(container)

    const video = videoRef.current
    if (video) {
      video.addEventListener('loadedmetadata', recalc)
    }

    return () => {
      observer.disconnect()
      if (video) video.removeEventListener('loadedmetadata', recalc)
    }
  }, [videoRef, containerRef])

  const renderWidth = rect?.width || 0
  const renderHeight = rect?.height || 0
  const offsetX = rect?.offsetX || 0
  const offsetY = rect?.offsetY || 0

  // The annotation of a comment is shown while `currentTime` is inside the
  // comment's [timecode, timecodeEnd] window (or one frame around the
  // timecode if no out-point was set). Click in the sidebar already seeks
  // to that point so the user gets to see it; once they hit play, it
  // disappears as the playhead moves on. The pending (just-drawn,
  // not-yet-posted) annotation is always shown — it lives at the current
  // frame by definition.
  const extractShapes = (ann: any): Shape[] | undefined => {
    if (!ann || typeof ann !== 'object') return undefined
    if (Array.isArray(ann.shapes) && ann.shapes.length > 0) return ann.shapes
    if (Array.isArray(ann.keyframes)) {
      const all: Shape[] = []
      for (const kf of ann.keyframes) {
        if (Array.isArray(kf.shapes)) all.push(...kf.shapes)
      }
      if (all.length > 0) return all
    }
    return undefined
  }

  const visibleShapes = useMemo(() => {
    if (!renderWidth || !renderHeight) return []

    const result: Array<{ commentId: string; shapes: Shape[] }> = []

    for (const comment of comments) {
      const shapes = extractShapes((comment as any).annotations)
      if (!shapes) continue

      // Strict time-based visibility: the drawing shows up only while the
      // playhead is at the comment's timecode. Clicking the comment in the
      // sidebar already seeks the video to that point, so the user always
      // gets to see it; once they hit play, it disappears as the playhead
      // moves on.
      const startTime = timecodeToSeconds(comment.timecode, videoFps)
      const frameDuration = 1 / (videoFps || 24)
      const tolerance = frameDuration * 0.5
      const endTime = comment.timecodeEnd
        ? timecodeToSeconds(comment.timecodeEnd, videoFps)
        : startTime + frameDuration

      if (currentTime < startTime - tolerance || currentTime > endTime + tolerance) {
        continue
      }
      result.push({ commentId: comment.id, shapes })
    }

    // Pending (just-drawn, not-yet-posted) annotation. Use a generous 1-second
    // window around the timecode where the user drew it — that way browsing
    // backwards or forwards a frame or two while reviewing the drawing
    // before posting still shows it. Once posted, the comment's stricter
    // window kicks in.
    if (pendingAnnotation) {
      const ann = pendingAnnotation.annotations
      if (Array.isArray(ann.shapes) && ann.shapes.length > 0) {
        const pStart = timecodeToSeconds(pendingAnnotation.timecode, videoFps)
        const pEnd = pendingAnnotation.timecodeEnd
          ? timecodeToSeconds(pendingAnnotation.timecodeEnd, videoFps)
          : pStart
        if (currentTime >= pStart - 1 && currentTime <= pEnd + 1) {
          result.push({ commentId: 'pending', shapes: ann.shapes })
        }
      }
    }

    return result
  }, [comments, currentTime, videoFps, renderWidth, renderHeight, pendingAnnotation])

  if (!renderWidth || !renderHeight || visibleShapes.length === 0 || hidden) return null

  return (
    <svg
      className="absolute pointer-events-none z-10"
      style={{
        left: offsetX,
        top: offsetY,
        width: renderWidth,
        height: renderHeight,
      }}
      viewBox={`0 0 ${renderWidth} ${renderHeight}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {visibleShapes.map(({ commentId, shapes }) =>
        shapes.map((shape, i) =>
          renderShape(shape, renderWidth, renderHeight, `${commentId}-${shape.id}-${i}`)
        )
      )}
    </svg>
  )
}
