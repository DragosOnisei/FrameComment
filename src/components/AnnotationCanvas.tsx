'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import { Shape, Point } from '@/types/annotations'

interface AnnotationCanvasProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  videoRef: React.RefObject<HTMLVideoElement | null>
  shapes: Shape[]
  activeShape: Shape | null
  onStartShape: (point: Point) => void
  onUpdateShape: (point: Point) => void
  onFinishShape: () => void
}

function renderShape(shape: Shape, renderWidth: number, renderHeight: number, key: string) {
  const sw = shape.strokeWidth * renderWidth
  const shapeOpacity = shape.opacity ?? 1

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
    const x1 = shape.start.x * renderWidth
    const y1 = shape.start.y * renderHeight
    const x2 = shape.end.x * renderWidth
    const y2 = shape.end.y * renderHeight
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.sqrt(dx * dx + dy * dy)

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

    const ux = dx / len
    const uy = dy / len
    const px = -uy
    const py = ux
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

/**
 * Calculate the rendered video area within an object-contain container.
 * This determines where the actual video pixels are displayed.
 */
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

  let renderWidth: number
  let renderHeight: number
  let offsetX: number
  let offsetY: number

  if (videoAspect > containerAspect) {
    renderWidth = containerWidth
    renderHeight = renderWidth / videoAspect
    offsetX = 0
    offsetY = (containerHeight - renderHeight) / 2
  } else {
    renderHeight = containerHeight
    renderWidth = renderHeight * videoAspect
    offsetY = 0
    offsetX = (containerWidth - renderWidth) / 2
  }

  return { offsetX, offsetY, width: renderWidth, height: renderHeight }
}

export default function AnnotationCanvas({
  containerRef,
  videoRef,
  shapes,
  activeShape,
  onStartShape,
  onUpdateShape,
  onFinishShape,
}: AnnotationCanvasProps) {
  const isDrawing = useRef(false)
  const [rect, setRect] = useState<{ offsetX: number; offsetY: number; width: number; height: number } | null>(null)
  const [fallbackSize, setFallbackSize] = useState<{ width: number; height: number } | null>(null)

  // Calculate video rect on mount and on resize
  useEffect(() => {
    const recalc = () => {
      const video = videoRef.current
      const container = containerRef.current
      if (!container) return

      const nextFallbackSize = {
        width: container.clientWidth,
        height: container.clientHeight,
      }
      setFallbackSize(
        nextFallbackSize.width && nextFallbackSize.height ? nextFallbackSize : null
      )

      if (!video) {
        setRect(null)
        return
      }

      const r = getVideoRect(video, container)
      setRect(r)
    }

    // Initial calc
    recalc()

    // Recalc on resize
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(recalc)
    observer.observe(container)

    // Also listen for video metadata in case it loads after mount
    const video = videoRef.current
    if (video) {
      video.addEventListener('loadedmetadata', recalc)
    }

    return () => {
      observer.disconnect()
      if (video) {
        video.removeEventListener('loadedmetadata', recalc)
      }
    }
  }, [videoRef, containerRef])

  const renderWidth = rect?.width || 0
  const renderHeight = rect?.height || 0
  const offsetX = rect?.offsetX || 0
  const offsetY = rect?.offsetY || 0

  const getPoint = useCallback(
    (clientX: number, clientY: number, svgElement: SVGSVGElement): Point => {
      const svgRect = svgElement.getBoundingClientRect()
      const x = (clientX - svgRect.left) / svgRect.width
      const y = (clientY - svgRect.top) / svgRect.height
      return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
      }
    },
    []
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const svg = e.currentTarget
      svg.setPointerCapture(e.pointerId)
      isDrawing.current = true
      const point = getPoint(e.clientX, e.clientY, svg)
      onStartShape(point)
    },
    [getPoint, onStartShape]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!isDrawing.current) return
      e.preventDefault()
      const point = getPoint(e.clientX, e.clientY, e.currentTarget)
      onUpdateShape(point)
    },
    [getPoint, onUpdateShape]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!isDrawing.current) return
      e.preventDefault()
      isDrawing.current = false
      e.currentTarget.releasePointerCapture(e.pointerId)
      onFinishShape()
    },
    [onFinishShape]
  )

  if (!renderWidth || !renderHeight) {
    // Fallback: cover the full container so user can at least draw
    const w = fallbackSize?.width || 0
    const h = fallbackSize?.height || 0
    if (!w || !h) return null

    return (
      <svg
        className="absolute inset-0 z-20 cursor-crosshair"
        style={{ width: w, height: h, touchAction: 'none' }}
        viewBox={`0 0 ${w} ${h}`}
        xmlns="http://www.w3.org/2000/svg"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Transparent capture rect — keeps the SVG hit-testable without
          dimming the video underneath. */}
      <rect width={w} height={h} fill="transparent" />
        {shapes.map((shape, i) =>
          renderShape(shape, w, h, `existing-${shape.id}-${i}`)
        )}
        {activeShape && renderShape(activeShape, w, h, 'active-drawing')}
      </svg>
    )
  }

  return (
    <svg
      className="absolute z-20 cursor-crosshair"
      style={{
        left: offsetX,
        top: offsetY,
        width: renderWidth,
        height: renderHeight,
        touchAction: 'none',
      }}
      viewBox={`0 0 ${renderWidth} ${renderHeight}`}
      xmlns="http://www.w3.org/2000/svg"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Transparent capture rect — keeps the SVG hit-testable without
          dimming the video underneath. */}
      <rect width={renderWidth} height={renderHeight} fill="transparent" />

      {/* Existing shapes */}
      {shapes.map((shape, i) =>
        renderShape(shape, renderWidth, renderHeight, `existing-${shape.id}-${i}`)
      )}

      {/* Currently drawing shape */}
      {activeShape &&
        renderShape(activeShape, renderWidth, renderHeight, 'active-drawing')}
    </svg>
  )
}
