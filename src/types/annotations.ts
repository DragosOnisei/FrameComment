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

// 1.3.2+: Frame.io-style thin strokes. Default is ~0.004 (≈ 5 px on
// a 1280 px render width) so the pen / line / rectangle tools draw a
// delicate mark instead of the old chunky 2.5 % stroke. Arrows keep
// the dynamic scaling in `updateShape` so they still grow with drag
// length, but their range was tightened to match.
//
// 2.3.0+: user feedback was that 0.004 looked too thin on real
// frames — the rectangle and arrow barely registered against busy
// backgrounds (interior of a car, foliage). Bumped a notch to
// ~0.006 (≈ 7.7 px on 1280 px), still slimmer than the legacy
// chunky stroke but enough to read at a glance. Arrow dynamic
// range below was widened proportionally so short arrows don't
// dip back into "too thin" territory.
export const DEFAULT_STROKE_WIDTH = 0.006
export const MIN_STROKE_WIDTH = 0.001
export const MAX_STROKE_WIDTH = 0.05
export const DEFAULT_OPACITY = 1
