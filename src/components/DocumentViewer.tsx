'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Download, FileText, Loader2, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import DOMPurify from 'isomorphic-dompurify'
import type { DocumentKind } from '@/lib/media-kind'

/**
 * 7.18.0: the in-page viewer for DOCUMENT media (pdf / txt / docx).
 *
 * Takes the player's place when the active item is a document (Dragos,
 * 2026-10-05): no comments — the comments column is not rendered for a
 * document — and three gestures, which is all a reviewer needs to read a
 * script or a brief next to the cut:
 *
 *   - wheel          zoom, towards the centre of the stage (a trackpad pinch
 *                    arrives as a ctrl+wheel and lands here too);
 *   - click and drag pan the page;
 *   - ↑ / ↓          previous / next page (PageUp / PageDown and the two
 *                    buttons do the same); ← / → are left to the version
 *                    reel. Home / End jump to the first / last page,
 *                    + / − / 0 zoom in / out / reset.
 *
 * PDF pages are drawn by pdf.js (pdfjs-dist, loaded on first use so the
 * ~1 MB library never ships to pages that show videos) into a canvas that is
 * re-rendered at the current zoom × devicePixelRatio, so text stays crisp at
 * any magnification; while the wheel is still turning the last render is
 * CSS-scaled and the sharp one follows 120 ms later. The worker pdf.js
 * parses with is served from /vendor/pdf.worker.min.mjs
 * (scripts/copy-pdf-worker.mjs). Text and Word files are laid out by the
 * browser on a white "sheet" — Word through mammoth's HTML, sanitised by
 * DOMPurify like a comment — and zoomed with a CSS transform; for them the
 * arrows step by a screenful, since there is one tall page.
 *
 * The file is fetched from the signed /api/content URL the pages already
 * mint for the original (the only representation a document has).
 */
interface DocumentViewerProps {
  /** Signed URL of the original file (the content route streams it). */
  url: string
  kind: DocumentKind
  name: string
  /** Signed download URL when the project allows downloads; null hides the button. */
  downloadUrl?: string | null
  className?: string
}

/** The fit is the floor for buttons and keys; the wheel may dip below it
 *  briefly through the zoom rubber band and springs back. */
const MIN_ZOOM = 1
const MAX_ZOOM = 6
const RENDER_DEBOUNCE_MS = 120
/** How much empty stage may show past a page edge when panned to the limit. */
const PAN_MARGIN = 48
/** The furthest a rubber-banded drag can stretch past the limit, in px. */
const RUBBER_MAX = 140
/** The snap-back animation, in ms (the wrapper's transform transition). */
const SNAP_MS = 220

type PdfDoc = {
  numPages: number
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number }
    render: (p: Record<string, unknown>) => { promise: Promise<void>; cancel: () => void }
  }>
  destroy: () => Promise<void> | void
}

export default function DocumentViewer({ url, kind, name, downloadUrl, className }: DocumentViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The document's natural size at zoom 1 (PDF points for a PDF; the laid-out
  // sheet for text/word), and the fit-to-stage factor derived from it.
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const pdfRef = useRef<PdfDoc | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  // ---- stage size ----------------------------------------------------------
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitScale =
    baseSize && stageSize.w > 0 && stageSize.h > 0
      ? Math.min((stageSize.w - 32) / baseSize.w, (stageSize.h - 32) / baseSize.h)
      : 1

  // ---- load -----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPage(1)
    setPageCount(1)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setBaseSize(null)
    setText(null)
    setHtml(null)
    const previous = pdfRef.current
    pdfRef.current = null
    if (previous) void Promise.resolve(previous.destroy()).catch(() => {})

    const run = async () => {
      if (kind === 'pdf') {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'
        const doc = (await pdfjs.getDocument({ url, withCredentials: true }).promise) as unknown as PdfDoc
        if (cancelled) {
          void Promise.resolve(doc.destroy()).catch(() => {})
          return
        }
        pdfRef.current = doc
        setPageCount(doc.numPages)
        const first = await doc.getPage(1)
        const vp = first.getViewport({ scale: 1 })
        if (cancelled) return
        setBaseSize({ w: vp.width, h: vp.height })
      } else {
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) throw new Error(`The file could not be loaded (${res.status})`)
        if (kind === 'text') {
          const t = await res.text()
          if (cancelled) return
          setText(t)
        } else {
          const buf = await res.arrayBuffer()
          const mammoth = await import('mammoth')
          const out = await mammoth.convertToHtml({ arrayBuffer: buf })
          if (cancelled) return
          setHtml(DOMPurify.sanitize(out.value, { USE_PROFILES: { html: true } }))
        }
        // A4-ish sheet at 96 dpi; the browser lays the content out inside
        // it and the sheet grows with the text (measured below).
        setBaseSize({ w: 816, h: 1056 })
      }
      if (!cancelled) setLoading(false)
    }
    run().catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : 'The document could not be opened')
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [url, kind])

  // Text / Word: the sheet's real height once laid out drives paging.
  useLayoutEffect(() => {
    if (kind === 'pdf') return
    const el = sheetRef.current
    if (!el || (text === null && html === null)) return
    const h = Math.max(1056, el.scrollHeight)
    setBaseSize((b) => (b && b.h === h ? b : { w: 816, h }))
  }, [kind, text, html])

  // ---- PDF page render (debounced, crisp at the current zoom) --------------
  useEffect(() => {
    if (kind !== 'pdf' || !pdfRef.current || !baseSize || loading) return
    const doc = pdfRef.current
    const canvas = canvasRef.current
    if (!canvas) return
    const handle = window.setTimeout(async () => {
      try {
        renderTaskRef.current?.cancel()
        const pdfPage = await doc.getPage(page)
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        const scale = fitScale * zoom
        const viewport = pdfPage.getViewport({ scale: scale * dpr })
        // Only the bitmap changes here. The canvas's CSS box is always the
        // zoomed sheet (`zoomedW × zoomedH`, below), so between a wheel tick
        // and this sharp render the previous bitmap just stretches into the
        // new box — same place, same centre, briefly soft — and nothing
        // jumps when the crisp one lands.
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const task = pdfPage.render({ canvasContext: ctx, canvas, viewport })
        renderTaskRef.current = task
        await task.promise
      } catch (err) {
        // A cancelled render (zoom moved on) is the normal case; anything
        // else is shown.
        if (!(err instanceof Error && /cancel/i.test(err.message))) {
          setError(err instanceof Error ? err.message : 'The page could not be drawn')
        }
      }
    }, RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [kind, page, zoom, fitScale, baseSize, loading])

  // ---- pan limits + rubber band ---------------------------------------------------
  // The page can be dragged until its far edge sits PAN_MARGIN px inside the
  // stage, and no further: a drag past that meets resistance and snaps back
  // on release (Dragos, 2026-10-05 — before this a page could be pushed out
  // of view entirely). An axis in which the zoomed page fits the stage has
  // no travel at all; the page stays centred there.
  const [snapping, setSnapping] = useState(false)
  const snapTimerRef = useRef<number | null>(null)
  // Limits for a given zoom — the wheel handler asks for the NEXT zoom's
  // limits and clamps the offset in the same update as the zoom itself, so
  // size and position change together, instantly, with no transition.
  const limitsFor = useCallback(
    (z: number) => {
      const w = (baseSize ? baseSize.w * fitScale : 0) * z
      const h = (baseSize ? baseSize.h * fitScale : 0) * z
      return {
        x: Math.max(0, (w - stageSize.w) / 2 + PAN_MARGIN),
        y: Math.max(0, (h - stageSize.h) / 2 + PAN_MARGIN),
      }
    },
    [baseSize, fitScale, stageSize.w, stageSize.h],
  )
  const clampTo = (o: { x: number; y: number }, l: { x: number; y: number }) => ({
    x: Math.min(l.x, Math.max(-l.x, o.x)),
    y: Math.min(l.y, Math.max(-l.y, o.y)),
  })
  const panLimits = useCallback(() => limitsFor(zoom), [limitsFor, zoom])
  const clampOffset = useCallback((o: { x: number; y: number }) => clampTo(o, panLimits()), [panLimits])
  const rubber = (value: number, limit: number) => {
    if (Math.abs(value) <= limit) return value
    const over = Math.abs(value) - limit
    // Diminishing travel past the limit: the first 100 px of overshoot show
    // as ~35 px, and it never gets far — the stretch is a hint, not a place.
    return Math.sign(value) * (limit + RUBBER_MAX * (1 - Math.exp(-over / RUBBER_MAX)) * 0.6)
  }
  const snapBack = useCallback(() => {
    setSnapping(true)
    setOffset((o) => clampOffset(o))
    if (snapTimerRef.current) window.clearTimeout(snapTimerRef.current)
    snapTimerRef.current = window.setTimeout(() => setSnapping(false), SNAP_MS + 20)
  }, [clampOffset])
  // The stage changing size (window resized, panel toggled) can leave the
  // page beyond the limit that now applies — pull it back, instantly. Zoom
  // is NOT handled here: the first version animated this clamp on every
  // wheel tick, and an animated position fighting an instant size change
  // read as judder when zooming out from a corner. The wheel handler clamps
  // for itself, in the same update as the zoom.
  useEffect(() => {
    setOffset((o) => clampTo(o, limitsFor(zoom)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSize.w, stageSize.h])

  // ---- gestures ---------------------------------------------------------------
  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  // Smooth zoom: a wheel tick moves a TARGET, and an animation frame loop
  // eases the displayed zoom towards it (a fifth of the remaining distance
  // per frame, ~60 fps), so a mouse wheel's coarse notches become one
  // continuous glide and a trackpad's fine deltas stay fine (Dragos,
  // 2026-10-05: "să fie smooth"). Each frame scales the offset with the zoom
  // so the point of the page at the stage's centre stays there, then clamps
  // it to that frame's limits — size and position change together, so
  // zooming out from a corner slides the page back without judder. The
  // bitmap is re-rendered only after the glide settles (the render effect's
  // debounce restarts on every frame); until then the old bitmap stretches.
  const zoomRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const targetZoomRef = useRef(1)
  const zoomRafRef = useRef<number | null>(null)
  zoomRef.current = zoom
  offsetRef.current = offset
  const limitsForRef = useRef(limitsFor)
  limitsForRef.current = limitsFor

  const stepZoomAnimation = useCallback(() => {
    const target = targetZoomRef.current
    const cur = zoomRef.current
    let next = cur + (target - cur) * 0.2
    const settled = Math.abs(target - next) < 0.0015
    if (settled) next = target
    const ratio = next / cur
    const o = offsetRef.current
    setOffset(clampTo({ x: o.x * ratio, y: o.y * ratio }, limitsForRef.current(next)))
    setZoom(next)
    zoomRafRef.current = settled ? null : requestAnimationFrame(stepZoomAnimation)
  }, [])

  useEffect(
    () => () => {
      if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current)
    },
    [],
  )

  // Zoom rubber band (Dragos, 2026-10-05: "banding și dacă se face scroll
  // out sub 100%"). The wheel keeps an UNCLAMPED intent; below the fit (1×)
  // only a fraction of it shows, with diminishing returns down to about
  // 0.85×, and once the wheel has been still for a moment the intent is
  // reset and the page eases back to the fit. Buttons and keys do not
  // rubber-band — a click on "−" at 100% simply does nothing.
  const zoomIntentRef = useRef(1)
  const wheelIdleRef = useRef<number | null>(null)
  const targetFromIntent = (intent: number) =>
    // Below the fit the shown zoom follows a saturating curve: the intent can
    // fall to 0.5×, the page never below ~0.83× (measured: four fast notches
    // showed 68% with a 0.6 factor — too deep for a hint — so 0.3).
    intent >= 1 ? Math.min(MAX_ZOOM, intent) : 1 - (1 - 1 / (1 + (1 - intent) * 2.5)) * 0.3
  const startZoomAnimation = useCallback(() => {
    if (zoomRafRef.current === null) zoomRafRef.current = requestAnimationFrame(stepZoomAnimation)
  }, [stepZoomAnimation])

  const zoomAround = useCallback(
    (factor: number, opts: { rubber?: boolean } = {}) => {
      setSnapping(false)
      if (opts.rubber) {
        zoomIntentRef.current = Math.max(0.5, Math.min(MAX_ZOOM, zoomIntentRef.current * factor))
        targetZoomRef.current = targetFromIntent(zoomIntentRef.current)
        if (wheelIdleRef.current) window.clearTimeout(wheelIdleRef.current)
        wheelIdleRef.current = window.setTimeout(() => {
          if (zoomIntentRef.current < 1) {
            zoomIntentRef.current = 1
            targetZoomRef.current = 1
            startZoomAnimation()
          }
        }, 180)
      } else {
        zoomIntentRef.current = clampZoom(Math.max(1, targetZoomRef.current) * factor)
        targetZoomRef.current = zoomIntentRef.current
      }
      startZoomAnimation()
    },
    [startZoomAnimation],
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    // Native listener: React's onWheel is passive and cannot stop the page
    // (or the column behind the viewer) from scrolling under the document.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
      // Towards the centre of the stage, never towards the cursor (Dragos,
      // 2026-10-05: "numai spre centru, atât"). Zooming around the pointer
      // made the page drift wherever the mouse happened to rest; the
      // centre is predictable, and a drag brings any corner into view.
      zoomAround(factor, { rubber: true })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number; id: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, a')) return
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const l = panLimits()
    setOffset({
      x: rubber(d.ox + (e.clientX - d.x), l.x),
      y: rubber(d.oy + (e.clientY - d.y), l.y),
    })
  }
  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    snapBack()
  }

  const goTo = useCallback(
    (n: number) => {
      if (kind === 'pdf') {
        const clamped = Math.min(pageCount, Math.max(1, n))
        if (clamped === page) return
        setPage(clamped)
        // A new page starts fitted and centred (Dragos, 2026-10-05): the
        // zoom and the pan belonged to the page that was being inspected,
        // not to the document.
        if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current)
        zoomRafRef.current = null
        targetZoomRef.current = 1
        zoomIntentRef.current = 1
        setZoom(1)
        setOffset({ x: 0, y: 0 })
      } else {
        // One tall sheet: a "page" is a screenful, within the pan limits.
        const step = stageSize.h * 0.9
        setSnapping(true)
        setOffset((o) => clampOffset({ x: o.x, y: o.y + (n > page ? -step : step) }))
        if (snapTimerRef.current) window.clearTimeout(snapTimerRef.current)
        snapTimerRef.current = window.setTimeout(() => setSnapping(false), SNAP_MS + 20)
      }
    },
    [kind, pageCount, page, stageSize.h, clampOffset],
  )

  const resetView = useCallback(() => {
    if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current)
    zoomRafRef.current = null
    targetZoomRef.current = 1
    zoomIntentRef.current = 1
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"],[role="menu"],[role="listbox"],[aria-modal="true"]')) return
      switch (e.key) {
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault()
          goTo(page + 1)
          break
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault()
          goTo(page - 1)
          break
        case 'Home':
          e.preventDefault()
          if (kind === 'pdf') goTo(1)
          else setOffset((o) => ({ x: o.x, y: 0 }))
          break
        case 'End':
          e.preventDefault()
          if (kind === 'pdf') goTo(pageCount)
          break
        case '+':
        case '=':
          e.preventDefault()
          zoomAround(1.2)
          break
        case '-':
          e.preventDefault()
          zoomAround(1 / 1.2)
          break
        case '0':
          e.preventDefault()
          resetView()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, page, pageCount, kind, zoomAround, resetView])

  // ---- layout numbers ---------------------------------------------------------
  // The sheet's box at the CURRENT zoom. It is what gets centred and panned,
  // so growing it symmetrically around its centre is what keeps the page in
  // place while zooming. The first version kept the box at fit size and let
  // the canvas (and the text sheet's transform) grow out of its top-left
  // corner — the page slid towards the top-left on every wheel tick.
  const sheetW = baseSize ? baseSize.w * fitScale : 0
  const sheetH = baseSize ? baseSize.h * fitScale : 0
  const zoomedW = sheetW * zoom
  const zoomedH = sheetH * zoom
  // Opaque dark chrome on purpose: the controls float over the sheet, and a
  // translucent white button on a white PDF page is invisible (seen on the
  // first render — the zoom row vanished the moment the page grew under it).
  const button =
    'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-white/90 ring-1 ring-white/15 bg-black/60 backdrop-blur-sm hover:bg-black/80 hover:text-white disabled:opacity-40 transition-colors shadow-[0_6px_18px_-6px_rgba(0,0,0,0.8)]'

  return (
    <div className={`relative flex h-full w-full min-h-0 flex-col rounded-xl bg-black overflow-hidden ${className ?? ''}`}>
      <div
        ref={stageRef}
        className="relative flex-1 min-h-0 overflow-hidden select-none touch-none cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetView}
        role="document"
        aria-label={name}
      >
        {/* the sheet: centred, panned by offset, zoomed */}
        {baseSize && !error && (
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: zoomedW,
              height: zoomedH,
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
              // Only the snap-back eases; a live drag and a wheel zoom follow
              // the hand with no lag.
              transition: snapping ? `transform ${SNAP_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none',
            }}
          >
            {kind === 'pdf' ? (
              <canvas
                ref={canvasRef}
                className="block h-full w-full bg-white shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)]"
              />
            ) : (
              <div
                ref={sheetRef}
                className="bg-white text-neutral-900 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)]"
                style={{
                  width: 816,
                  minHeight: 1056,
                  transform: `scale(${fitScale * zoom})`,
                  transformOrigin: 'top left',
                }}
              >
                {kind === 'text' ? (
                  <pre className="whitespace-pre-wrap break-words px-14 py-16 font-mono text-[13px] leading-6">{text}</pre>
                ) : (
                  <div
                    className="fc-document-prose px-16 py-16 text-[15px] leading-7"
                    dangerouslySetInnerHTML={{ __html: html ?? '' }}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center gap-3 text-sm text-white/80">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading document…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <FileText className="h-10 w-10 text-white/40" />
            <p className="text-sm text-white/80">{error}</p>
            {downloadUrl && (
              <a href={downloadUrl} className={button}>
                <Download className="h-3.5 w-3.5" /> Download the file
              </a>
            )}
          </div>
        )}

        {/* zoom controls — top right */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
          <button type="button" className={button} onClick={() => zoomAround(1 / 1.2)} title="Zoom out (−)" aria-label="Zoom out">
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={`${button} tabular-nums`} onClick={resetView} title="Fit to screen (0)">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className={button} onClick={() => zoomAround(1.2)} title="Zoom in (+)" aria-label="Zoom in">
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={button} onClick={resetView} title="Fit to screen (0)" aria-label="Fit to screen">
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          {downloadUrl && (
            <a href={downloadUrl} className={button} title="Download" aria-label="Download">
              <Download className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        {/* page controls — bottom centre (PDF) */}
        {kind === 'pdf' && pageCount > 1 && (
          <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1">
            <button type="button" className={button} onClick={() => goTo(page - 1)} disabled={page <= 1} title="Previous page (↑)" aria-label="Previous page">
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <span className="inline-flex h-8 items-center rounded-md bg-black/60 backdrop-blur-sm px-2.5 text-xs tabular-nums text-white/90 ring-1 ring-white/15 shadow-[0_6px_18px_-6px_rgba(0,0,0,0.8)]">
              {page} / {pageCount}
            </span>
            <button type="button" className={button} onClick={() => goTo(page + 1)} disabled={page >= pageCount} title="Next page (↓)" aria-label="Next page">
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
