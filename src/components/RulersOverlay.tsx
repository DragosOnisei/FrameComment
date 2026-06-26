'use client'

import { useEffect, useState, useRef, useCallback } from 'react'

/**
 * 1.3.2+: Premiere/Photoshop-style rulers with draggable guide lines.
 *
 * - 18 px ruler strip at the top + 18 px at the left of the video frame.
 * - Drag DOWN from the top ruler → spawns a HORIZONTAL guide line.
 * - Drag RIGHT from the left ruler → spawns a VERTICAL guide line.
 * - Double-click on a guide to delete it.
 * - Click an existing guide and drag it back ONTO its ruler to delete
 *   it (matches Photoshop/Premiere muscle memory).
 *
 * Guide positions are stored as fractions (0-1) of the painted video
 * rect so they survive resizes and aspect-ratio changes.
 */

interface Props {
  enabled: boolean
  /** Video intrinsic dimensions — same idea as SafeZoneOverlay: we
   *  need them to figure out the actual painted rect inside the
   *  wrapper (object-contain letterboxes). */
  videoWidth: number | null | undefined
  videoHeight: number | null | undefined
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface PaintedRect {
  left: number
  top: number
  width: number
  height: number
}

const RULER_SIZE = 18 // px

export default function RulersOverlay({
  enabled,
  videoWidth,
  videoHeight,
  containerRef,
}: Props) {
  const [rect, setRect] = useState<PaintedRect | null>(null)
  // Guide positions are stored as fractions of the painted video rect.
  // hGuides[i] = y/height, vGuides[i] = x/width.
  const [hGuides, setHGuides] = useState<number[]>([])
  const [vGuides, setVGuides] = useState<number[]>([])
  // While the user is dragging from a ruler we track the live cursor
  // position so we can preview the not-yet-committed guide.
  type DragState =
    | { kind: 'h-new' | 'v-new'; frac: number }
    | { kind: 'h-move' | 'v-move'; index: number; frac: number }
  const [drag, setDrag] = useState<DragState | null>(null)
  // 3.5.x: mirror the live drag in a ref so the release handler can
  // claim it SYNCHRONOUSLY. On touch devices the browser fires
  // compatibility mouse events (mousedown/mouseup) right after the
  // touch ones, so a single finger release used to fire `onUp` twice
  // and commit TWO guide lines. The first `onUp` now nulls this ref,
  // so the duplicate event finds nothing to commit — regardless of how
  // React batches the state updates.
  const dragRef = useRef<DragState | null>(null)
  const startDrag = useCallback((d: DragState) => {
    dragRef.current = d
    setDrag(d)
  }, [])

  // ---- Painted rect tracking (mirrors SafeZoneOverlay) -----------
  useEffect(() => {
    if (!enabled) return
    if (!videoWidth || !videoHeight) return
    const el = containerRef.current
    if (!el) return
    const compute = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return
      const videoAR = videoWidth / videoHeight
      const wrapperAR = w / h
      let paintedW = w
      let paintedH = h
      let left = 0
      let top = 0
      if (videoAR > wrapperAR) {
        paintedW = w
        paintedH = w / videoAR
        top = (h - paintedH) / 2
      } else {
        paintedH = h
        paintedW = h * videoAR
        left = (w - paintedW) / 2
      }
      setRect({ left, top, width: paintedW, height: paintedH })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    window.addEventListener('resize', compute)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', compute)
    }
  }, [enabled, containerRef, videoWidth, videoHeight])

  // ---- Drag handlers -------------------------------------------------
  const computeFrac = useCallback(
    (clientX: number, clientY: number, kind: 'h' | 'v') => {
      if (!rect) return 0
      const el = containerRef.current
      if (!el) return 0
      const wrapperBox = el.getBoundingClientRect()
      if (kind === 'h') {
        const y = clientY - wrapperBox.top - rect.top
        return Math.max(-0.05, Math.min(1.05, y / rect.height))
      }
      const x = clientX - wrapperBox.left - rect.left
      return Math.max(-0.05, Math.min(1.05, x / rect.width))
    },
    [rect, containerRef],
  )

  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent | TouchEvent) => {
      const t = (e as TouchEvent).touches?.[0]
      const clientX = t ? t.clientX : (e as MouseEvent).clientX
      const clientY = t ? t.clientY : (e as MouseEvent).clientY
      if (typeof clientX !== 'number') return
      const isH = drag.kind === 'h-new' || drag.kind === 'h-move'
      const frac = computeFrac(clientX, clientY, isH ? 'h' : 'v')
      if (dragRef.current) dragRef.current = { ...dragRef.current, frac }
      setDrag((d) => (d ? { ...d, frac } : d))
    }
    const onUp = () => {
      // Claim the drag synchronously: the FIRST release wins and clears
      // the ref, so a duplicated event (the compatibility mouse event
      // that follows touchend) sees null and does nothing → no double
      // guide. The commit happens here (not inside a setDrag updater),
      // which also keeps the state updater pure.
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      // Drag ended OUTSIDE the painted rect → treat as a "drop on
      // ruler" delete (for *-move) or a no-op (for *-new).
      const offGrid = d.frac < 0 || d.frac > 1
      if (d.kind === 'h-new') {
        if (!offGrid) setHGuides((g) => [...g, d.frac])
      } else if (d.kind === 'v-new') {
        if (!offGrid) setVGuides((g) => [...g, d.frac])
      } else if (d.kind === 'h-move') {
        if (offGrid) setHGuides((g) => g.filter((_, i) => i !== d.index))
        else setHGuides((g) => g.map((v, i) => (i === d.index ? d.frac : v)))
      } else if (d.kind === 'v-move') {
        if (offGrid) setVGuides((g) => g.filter((_, i) => i !== d.index))
        else setVGuides((g) => g.map((v, i) => (i === d.index ? d.frac : v)))
      }
      setDrag(null)
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
  }, [drag, computeFrac])

  // Clear all guides when disabled so re-enabling starts fresh.
  useEffect(() => {
    if (!enabled) {
      setHGuides([])
      setVGuides([])
      dragRef.current = null
      setDrag(null)
    }
  }, [enabled])

  if (!enabled || !rect) return null

  // Ticks rendered on the rulers — every 10 % of the painted rect.
  // 3.5.x: start at 10 % (skip the 0 % tick). The 0 % tick sat exactly
  // on the shared top-left ruler corner and showed up as a stray 1px
  // line on the top ruler. The 0 % position is already the ruler's own
  // edge, so dropping that tick loses nothing visually.
  const ticks = Array.from({ length: 10 }, (_, i) => (i + 1) / 10)

  // Preview frac while dragging a "new" guide.
  const previewH =
    drag && drag.kind === 'h-new' && drag.frac >= 0 && drag.frac <= 1
      ? drag.frac
      : null
  const previewV =
    drag && drag.kind === 'v-new' && drag.frac >= 0 && drag.frac <= 1
      ? drag.frac
      : null

  // While dragging an existing guide we render it at its live frac
  // (or omit it entirely if the user has dragged it OFF the grid).
  const renderHGuides = hGuides.map((frac, i) => {
    if (drag && drag.kind === 'h-move' && drag.index === i) {
      if (drag.frac < 0 || drag.frac > 1) return null
      return { frac: drag.frac, i }
    }
    return { frac, i }
  })
  const renderVGuides = vGuides.map((frac, i) => {
    if (drag && drag.kind === 'v-move' && drag.index === i) {
      if (drag.frac < 0 || drag.frac > 1) return null
      return { frac: drag.frac, i }
    }
    return { frac, i }
  })

  return (
    // 1.3.2+: wrapper MUST be pointer-events-none so clicks on the
    // empty middle of the video pass through to the AnnotationCanvas
    // underneath. Without this, users couldn't draw arrows/lines
    // while rulers were on (the wrapper at z-[36] swallowed every
    // click). Each child that needs interaction (ruler strips, guide
    // hit-zones) re-enables pointer events on itself.
    <div className="absolute inset-0 pointer-events-none z-[36]" aria-hidden="true">
      {/* LEFT ruler — rendered FIRST so the TOP ruler paints over the
          shared top-left corner. The top ruler has no vertical border,
          so the corner stays clean (no white seam where the two meet). */}
      <div
        className="absolute pointer-events-auto cursor-col-resize select-none"
        style={{
          // 3.5.x: sit ON the video's left edge (not in the pillarbox
          // beside it) so the frosted glass blurs video content instead
          // of rendering as a solid black strip over the letterbox.
          left: rect.left,
          top: rect.top,
          width: RULER_SIZE,
          height: rect.height,
          // 3.5.x: modern frosted glass (matches the app's glass v2.5).
          backgroundColor: 'rgba(11,18,32,0.45)',
          borderRight: '1px solid rgba(255,255,255,0.14)',
          backdropFilter: 'blur(20px) saturate(160%)',
          WebkitBackdropFilter: 'blur(20px) saturate(160%)',
          boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.06)',
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          const frac = computeFrac(e.clientX, e.clientY, 'v')
          startDrag({ kind: 'v-new', frac })
        }}
        onTouchStart={(e) => {
          const t = e.touches[0]
          if (!t) return
          const frac = computeFrac(t.clientX, t.clientY, 'v')
          startDrag({ kind: 'v-new', frac })
        }}
      >
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute right-0 bg-white/60"
            style={{
              top: `${t * 100}%`,
              height: 1,
              width: t === 0 || t === 1 ? RULER_SIZE : RULER_SIZE / 2,
            }}
          />
        ))}
      </div>

      {/* TOP ruler — rendered after the left ruler so it owns the
          top-left corner cleanly. */}
      <div
        className="absolute pointer-events-auto cursor-row-resize select-none"
        style={{
          left: rect.left,
          // 3.5.x: sit ON the video's top edge (not in the letterbox
          // above it) so the frosted glass always has video content to
          // blur — otherwise, over a black bar it just renders black.
          top: rect.top,
          width: rect.width,
          height: RULER_SIZE,
          // 3.5.x: modern frosted glass (matches the app's glass v2.5).
          backgroundColor: 'rgba(11,18,32,0.45)',
          borderBottom: '1px solid rgba(255,255,255,0.14)',
          backdropFilter: 'blur(20px) saturate(160%)',
          WebkitBackdropFilter: 'blur(20px) saturate(160%)',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          const frac = computeFrac(e.clientX, e.clientY, 'h')
          startDrag({ kind: 'h-new', frac })
        }}
        onTouchStart={(e) => {
          const t = e.touches[0]
          if (!t) return
          const frac = computeFrac(t.clientX, t.clientY, 'h')
          startDrag({ kind: 'h-new', frac })
        }}
      >
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute bottom-0 bg-white/60"
            style={{
              left: `${t * 100}%`,
              width: 1,
              height: t === 0 || t === 1 ? RULER_SIZE : RULER_SIZE / 2,
            }}
          />
        ))}
      </div>

      {/* Horizontal guides */}
      {renderHGuides.map((g) =>
        g ? (
          <div
            key={`h-${g.i}`}
            className="absolute pointer-events-auto cursor-row-resize"
            style={{
              left: rect.left,
              top: rect.top + g.frac * rect.height - 4,
              width: rect.width,
              height: 9, // 9-px tall hit-zone, 1-px visible line
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              startDrag({ kind: 'h-move', index: g.i, frac: g.frac })
            }}
            onTouchStart={(e) => {
              e.stopPropagation()
              startDrag({ kind: 'h-move', index: g.i, frac: g.frac })
            }}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setHGuides((arr) => arr.filter((_, idx) => idx !== g.i))
            }}
          >
            <div
              className="absolute left-0 right-0 top-1/2 -translate-y-1/2"
              style={{
                height: 1,
                backgroundColor: 'rgba(120, 200, 255, 0.95)',
                boxShadow: '0 0 4px rgba(120, 200, 255, 0.6)',
              }}
            />
          </div>
        ) : null,
      )}
      {/* Vertical guides */}
      {renderVGuides.map((g) =>
        g ? (
          <div
            key={`v-${g.i}`}
            className="absolute pointer-events-auto cursor-col-resize"
            style={{
              left: rect.left + g.frac * rect.width - 4,
              top: rect.top,
              width: 9,
              height: rect.height,
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              startDrag({ kind: 'v-move', index: g.i, frac: g.frac })
            }}
            onTouchStart={(e) => {
              e.stopPropagation()
              startDrag({ kind: 'v-move', index: g.i, frac: g.frac })
            }}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setVGuides((arr) => arr.filter((_, idx) => idx !== g.i))
            }}
          >
            <div
              className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2"
              style={{
                width: 1,
                backgroundColor: 'rgba(120, 200, 255, 0.95)',
                boxShadow: '0 0 4px rgba(120, 200, 255, 0.6)',
              }}
            />
          </div>
        ) : null,
      )}
      {/* Preview lines while dragging from the rulers */}
      {previewH !== null && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: rect.left,
            top: rect.top + previewH * rect.height,
            width: rect.width,
            height: 1,
            backgroundColor: 'rgba(120, 200, 255, 0.7)',
            boxShadow: '0 0 4px rgba(120, 200, 255, 0.5)',
          }}
        />
      )}
      {previewV !== null && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: rect.left + previewV * rect.width,
            top: rect.top,
            width: 1,
            height: rect.height,
            backgroundColor: 'rgba(120, 200, 255, 0.7)',
            boxShadow: '0 0 4px rgba(120, 200, 255, 0.5)',
          }}
        />
      )}
    </div>
  )
}
