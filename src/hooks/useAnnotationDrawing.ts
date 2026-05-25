'use client'

import { useState, useCallback, useRef } from 'react'
import {
  Shape,
  FreehandShape,
  LineShape,
  ArrowShape,
  RectangleShape,
  AnnotationData,
  AnnotationColor,
  ANNOTATION_COLORS,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_OPACITY,
  Point,
  DrawingTool,
} from '@/types/annotations'

/**
 * Ramer-Douglas-Peucker path simplification
 * Reduces freehand point count while preserving shape
 */
function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const lengthSq = dx * dx + dy * dy

  if (lengthSq === 0) {
    const ddx = point.x - lineStart.x
    const ddy = point.y - lineStart.y
    return Math.sqrt(ddx * ddx + ddy * ddy)
  }

  const t = Math.max(0, Math.min(1, ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSq))
  const projX = lineStart.x + t * dx
  const projY = lineStart.y + t * dy
  const ddx = point.x - projX
  const ddy = point.y - projY
  return Math.sqrt(ddx * ddx + ddy * ddy)
}

function simplifyPath(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points

  let maxDist = 0
  let maxIndex = 0

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[points.length - 1])
    if (dist > maxDist) {
      maxDist = dist
      maxIndex = i
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyPath(points.slice(0, maxIndex + 1), epsilon)
    const right = simplifyPath(points.slice(maxIndex), epsilon)
    return [...left.slice(0, -1), ...right]
  }

  return [points[0], points[points.length - 1]]
}

export function useAnnotationDrawing() {
  // FrameComment palette: red is the first colour and the sensible default
  // ("call out a problem"). Order in ANNOTATION_COLORS is red, orange, green.
  const [activeColor, setActiveColor] = useState<AnnotationColor>(ANNOTATION_COLORS[0])
  const [activeTool, setActiveTool] = useState<DrawingTool>('arrow')
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE_WIDTH)
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY)
  const [shapes, setShapes] = useState<Shape[]>([])
  // History entries are full snapshots of `shapes`. Undo pops to undoStack
  // (push current → restore), redo pops back from redoStack.
  const [undoStack, setUndoStack] = useState<Shape[][]>([])
  const [redoStack, setRedoStack] = useState<Shape[][]>([])
  const [activeShape, setActiveShape] = useState<Shape | null>(null)
  const shapeIdCounter = useRef(0)

  // Refs to avoid stale closures in pointer event handlers
  const activeShapeRef = useRef<Shape | null>(null)
  const shapesRef = useRef<Shape[]>([])
  const activeToolRef = useRef<DrawingTool>('arrow')

  const generateShapeId = useCallback(() => {
    shapeIdCounter.current += 1
    return `s${shapeIdCounter.current}`
  }, [])

  const updateActiveTool = useCallback((tool: DrawingTool) => {
    activeToolRef.current = tool
    setActiveTool(tool)
  }, [])

  const startShape = useCallback(
    (point: Point) => {
      const id = generateShapeId()
      const tool = activeToolRef.current
      let newShape: Shape

      // For drag-out shapes (arrow / line / rectangle) we start with a
      // very thin stroke and let `updateShape` thicken it as the user
      // drags. This avoids the "huge arrow on first click" effect.
      const initialStrokeWidth =
        tool === 'arrow' || tool === 'line' || tool === 'rectangle'
          ? 0.003
          : strokeWidth

      if (tool === 'freehand') {
        const fh: FreehandShape = {
          id,
          type: 'freehand',
          color: activeColor,
          strokeWidth,
          opacity,
          points: [point],
        }
        newShape = fh
      } else if (tool === 'line') {
        const ls: LineShape = {
          id,
          type: 'line',
          color: activeColor,
          strokeWidth: initialStrokeWidth,
          opacity,
          start: point,
          end: point,
        }
        newShape = ls
      } else if (tool === 'arrow') {
        const ar: ArrowShape = {
          id,
          type: 'arrow',
          color: activeColor,
          strokeWidth: initialStrokeWidth,
          opacity,
          start: point,
          end: point,
        }
        newShape = ar
      } else {
        const rc: RectangleShape = {
          id,
          type: 'rectangle',
          color: activeColor,
          strokeWidth: initialStrokeWidth,
          opacity,
          start: point,
          end: point,
        }
        newShape = rc
      }

      activeShapeRef.current = newShape
      setActiveShape(newShape)
    },
    [activeColor, strokeWidth, opacity, generateShapeId]
  )

  const updateShape = useCallback(
    (point: Point) => {
      const prev = activeShapeRef.current
      if (!prev) return

      let updated: Shape | null = null

      if (prev.type === 'freehand') {
        updated = { ...prev, points: [...prev.points, point] }
      } else if (prev.type === 'arrow') {
        // 1.3.2+: only arrows scale with drag length — a tiny arrow
        // stays delicate, a long one gets visibly thicker, matching
        // Frame.io. Range narrowed to 0.003..0.008 so even a fully
        // dragged-out arrow stays slim.
        const dx = point.x - prev.start.x
        const dy = point.y - prev.start.y
        const length = Math.sqrt(dx * dx + dy * dy)
        const dynamicWidth = Math.min(0.008, Math.max(0.003, 0.003 + length * 0.010))
        updated = { ...prev, end: point, strokeWidth: dynamicWidth }
      } else if (prev.type === 'line' || prev.type === 'rectangle') {
        // 1.3.2+: lines and rectangles use a constant thin stroke
        // (the initial DEFAULT_STROKE_WIDTH the user picked from the
        // toolbar). No dynamic scaling.
        updated = { ...prev, end: point }
      }

      if (updated) {
        activeShapeRef.current = updated
        setActiveShape(updated)
      }
    },
    []
  )

  const finishShape = useCallback(() => {
    const current = activeShapeRef.current
    if (!current) {
      activeShapeRef.current = null
      setActiveShape(null)
      return
    }

    let isValid = true
    let finalShape: Shape = current

    if (current.type === 'freehand') {
      if (current.points.length < 2) {
        isValid = false
      } else {
        const simplified = simplifyPath(current.points, 0.002)
        finalShape = { ...current, points: simplified }
      }
    } else if (current.type === 'line' || current.type === 'arrow' || current.type === 'rectangle') {
      // Reject zero-size shapes (single-click without drag)
      const dx = current.end.x - current.start.x
      const dy = current.end.y - current.start.y
      if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) {
        isValid = false
      }
    }

    if (isValid) {
      // Capture current shapes BEFORE mutating the ref
      const snapshotForUndo = [...shapesRef.current]
      const newShapes = [...shapesRef.current, finalShape]

      // Update ref immediately for next pointer events
      shapesRef.current = newShapes

      // Batch state updates
      setUndoStack((prev) => [...prev.slice(-49), snapshotForUndo])
      // A new edit invalidates the redo stack
      setRedoStack([])
      setShapes(newShapes)
    }

    activeShapeRef.current = null
    setActiveShape(null)
  }, [])

  const undo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev
      const lastEntry = prev[prev.length - 1]
      // Push current shapes onto redo stack so we can return to them
      setRedoStack((rs) => [...rs.slice(-49), [...shapesRef.current]])
      shapesRef.current = lastEntry
      setShapes(lastEntry)
      return prev.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev
      const lastEntry = prev[prev.length - 1]
      setUndoStack((us) => [...us.slice(-49), [...shapesRef.current]])
      shapesRef.current = lastEntry
      setShapes(lastEntry)
      return prev.slice(0, -1)
    })
  }, [])

  const reset = useCallback(() => {
    setShapes([])
    setUndoStack([])
    setRedoStack([])
    setActiveShape(null)
    activeShapeRef.current = null
    shapesRef.current = []
    shapeIdCounter.current = 0
  }, [])

  const getAnnotationData = useCallback((): AnnotationData | null => {
    if (shapesRef.current.length === 0) return null

    return {
      version: 1,
      shapes: shapesRef.current,
    }
  }, [])

  const hasShapes = shapes.length > 0

  return {
    activeColor,
    setActiveColor,
    activeTool,
    setActiveTool: updateActiveTool,
    strokeWidth,
    setStrokeWidth,
    opacity,
    setOpacity,
    shapes,
    activeShape,
    hasShapes,
    undoStack,
    redoStack,
    startShape,
    updateShape,
    finishShape,
    undo,
    redo,
    reset,
    getAnnotationData,
  }
}
