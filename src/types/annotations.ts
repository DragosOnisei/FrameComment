export interface Point {
  x: number
  y: number
}

export interface FreehandShape {
  id: string
  type: 'freehand'
  color: string
  strokeWidth: number
  opacity?: number
  points: Point[]
}

/** Straight line from `start` to `end`. Both endpoints are normalized [0..1]. */
export interface LineShape {
  id: string
  type: 'line'
  color: string
  strokeWidth: number
  opacity?: number
  start: Point
  end: Point
}

/** Line with an arrowhead at `end`. Same coordinate semantics as `LineShape`. */
export interface ArrowShape {
  id: string
  type: 'arrow'
  color: string
  strokeWidth: number
  opacity?: number
  start: Point
  end: Point
}

/** Axis-aligned rectangle. `start` and `end` are opposite corners. */
export interface RectangleShape {
  id: string
  type: 'rectangle'
  color: string
  strokeWidth: number
  opacity?: number
  start: Point
  end: Point
}

export type Shape = FreehandShape | LineShape | ArrowShape | RectangleShape

export type DrawingTool = 'freehand' | 'line' | 'arrow' | 'rectangle'

export interface AnnotationData {
  version: 1
  shapes: Shape[]
}

// FrameComment palette — only 3 colors for clarity and consistent meaning:
// red = problem / blocker, orange = note / question, green = approved / good
export const ANNOTATION_COLORS = [
  '#EF4444', // red
  '#F97316', // orange
  '#22C55E', // green
] as const

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]

export const DEFAULT_STROKE_WIDTH = 0.025
export const MIN_STROKE_WIDTH = 0.001
export const MAX_STROKE_WIDTH = 0.05
export const DEFAULT_OPACITY = 1
