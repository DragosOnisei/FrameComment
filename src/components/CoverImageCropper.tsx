'use client'

import * as React from 'react'
import { Loader2, Maximize, RotateCcw } from 'lucide-react'

/**
 * 1.2.0+: Square cover-image cropper used by the New Project modal.
 *
 * Lightweight in-place crop: the user picks an image; we render it
 * inside the square preview area scaled to fit, then they drag /
 * pinch / wheel-zoom to reposition the visible 1:1 region. On
 * "Apply" we draw the visible portion to an offscreen canvas at a
 * reasonable export resolution and hand the parent a `File` ready
 * for upload.
 *
 * Why no `react-easy-crop` / `react-image-crop`: the project keeps
 * its dependency surface small, and the crop UX for our square
 * cover only needs drag + zoom — both straightforward.
 */
export interface CoverImageCropperHandle {
  /**
   * Render the current crop to a Blob (square `OUTPUT_SIZE` × `OUTPUT_SIZE`
   * PNG/JPEG, depending on the source). Returns null if the image
   * hasn't loaded yet.
   */
  commit(): Promise<File | null>
}

export interface CoverImageCropperProps {
  /** Original image file picked by the user. */
  file: File
  /** Output edge size in pixels. 1024 is plenty for the dashboard
   *  card (the tile renders at well under 400px on a 2x retina). */
  outputSize?: number
  /** Output format. JPEG is smaller for photographs; PNG is used
   *  when the source has transparency. */
  className?: string
}

const DEFAULT_OUTPUT_SIZE = 1024
const MIN_SCALE = 1 // never zoom out past "cover" — preview must stay full
const MAX_SCALE = 4

const CoverImageCropper = React.forwardRef<CoverImageCropperHandle, CoverImageCropperProps>(
  function CoverImageCropper(
    { file, outputSize = DEFAULT_OUTPUT_SIZE, className },
    ref,
  ) {
    // Object URL for the picked file. We revoke it whenever the file
    // changes or the component unmounts so the browser frees memory.
    const [objectUrl, setObjectUrl] = React.useState<string | null>(null)
    React.useEffect(() => {
      const url = URL.createObjectURL(file)
      setObjectUrl(url)
      return () => {
        URL.revokeObjectURL(url)
      }
    }, [file])

    // Crop transform state. `x`/`y` are pixel offsets relative to
    // the centered "cover" base position; `scale` is multiplicative
    // over the base cover scale (so 1 = the original cover fit).
    const [scale, setScale] = React.useState(1)
    const [translate, setTranslate] = React.useState({ x: 0, y: 0 })
    const [naturalSize, setNaturalSize] = React.useState<{ w: number; h: number } | null>(null)
    const [previewSize, setPreviewSize] = React.useState<{ w: number; h: number } | null>(null)

    const containerRef = React.useRef<HTMLDivElement | null>(null)
    const imgRef = React.useRef<HTMLImageElement | null>(null)
    const dragStateRef = React.useRef<{
      startX: number
      startY: number
      origX: number
      origY: number
      pointerId: number
    } | null>(null)

    // Track the container size so the drag math + commit math use the
    // same coordinate space. We re-measure on mount + on window
    // resize.
    React.useEffect(() => {
      const update = () => {
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        setPreviewSize({ w: rect.width, h: rect.height })
      }
      update()
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }, [])

    // Reset transform whenever the source file changes — a fresh
    // image should start centered + at minimum scale.
    React.useEffect(() => {
      setScale(1)
      setTranslate({ x: 0, y: 0 })
    }, [file])

    /**
     * Compute the base cover-fit scale: the multiplier that makes the
     * shorter image side equal the container's edge so the square
     * preview is fully covered (object-fit: cover semantics).
     */
    const baseCoverScale = React.useMemo(() => {
      if (!naturalSize || !previewSize) return 1
      const scaleW = previewSize.w / naturalSize.w
      const scaleH = previewSize.h / naturalSize.h
      return Math.max(scaleW, scaleH)
    }, [naturalSize, previewSize])

    /**
     * Clamp the translate so the image always covers the square — we
     * never want black bars in the export.
     */
    const clampTranslate = React.useCallback(
      (raw: { x: number; y: number }, withScale: number) => {
        if (!naturalSize || !previewSize) return raw
        const effective = baseCoverScale * withScale
        const dispW = naturalSize.w * effective
        const dispH = naturalSize.h * effective
        const maxX = Math.max(0, (dispW - previewSize.w) / 2)
        const maxY = Math.max(0, (dispH - previewSize.h) / 2)
        return {
          x: Math.max(-maxX, Math.min(maxX, raw.x)),
          y: Math.max(-maxY, Math.min(maxY, raw.y)),
        }
      },
      [naturalSize, previewSize, baseCoverScale],
    )

    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
      setScale(1)
      setTranslate({ x: 0, y: 0 })
    }

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!previewSize) return
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)
      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: translate.x,
        origY: translate.y,
        pointerId: e.pointerId,
      }
    }
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current
      if (!drag) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      setTranslate(clampTranslate({ x: drag.origX + dx, y: drag.origY + dy }, scale))
    }
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      dragStateRef.current = null
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released — fine */
      }
    }

    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
      // Wheel zoom. We negate deltaY so scroll up = zoom in (matches
      // every desktop image editor on the planet).
      e.preventDefault()
      const delta = -e.deltaY * 0.002
      setScale((prev) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta))
        // Re-clamp translate against the new scale so we don't trap
        // the user with a non-covering position.
        setTranslate((t) => clampTranslate(t, next))
        return next
      })
    }

    const handleZoomChange = (value: number) => {
      setScale((prev) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
        setTranslate((t) => clampTranslate(t, next))
        return next
      })
    }

    const handleReset = () => {
      setScale(1)
      setTranslate({ x: 0, y: 0 })
    }

    // Expose `commit()` to the parent so the Create New Project
    // button can pull the cropped File at submit time.
    React.useImperativeHandle(ref, () => ({
      commit: async () => {
        if (!naturalSize || !previewSize || !imgRef.current) return null

        const effective = baseCoverScale * scale
        const dispW = naturalSize.w * effective
        const dispH = naturalSize.h * effective

        // The square preview's centre lines up with the centre of
        // the displayed image plus the user's translate. Convert
        // the preview viewport (0..previewSize) into source-pixel
        // coordinates on the original image.
        const offsetXInDisplay = (dispW - previewSize.w) / 2 - translate.x
        const offsetYInDisplay = (dispH - previewSize.h) / 2 - translate.y
        const sourceX = offsetXInDisplay / effective
        const sourceY = offsetYInDisplay / effective
        const sourceSize = previewSize.w / effective

        // Cap export at the source resolution — upscaling a small
        // image to `outputSize` only adds blur.
        const exportEdge = Math.min(outputSize, Math.round(sourceSize))

        const canvas = document.createElement('canvas')
        canvas.width = exportEdge
        canvas.height = exportEdge
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(
          imgRef.current,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          0,
          0,
          exportEdge,
          exportEdge,
        )

        // Pick output format. JPEG is much smaller for photo-style
        // covers; for PNG sources (with transparency) we keep PNG to
        // avoid baking a flat background colour into the export.
        const wantsPng = file.type === 'image/png'
        const mime = wantsPng ? 'image/png' : 'image/jpeg'
        const ext = wantsPng ? 'png' : 'jpg'
        const quality = wantsPng ? undefined : 0.92

        const blob: Blob | null = await new Promise((resolve) =>
          canvas.toBlob(resolve, mime, quality),
        )
        if (!blob) return null

        const filename = `cover.${ext}`
        return new File([blob], filename, { type: mime })
      },
    }), [naturalSize, previewSize, baseCoverScale, scale, translate, file.type, outputSize])

    return (
      <div className={className}>
        <div
          ref={containerRef}
          className="relative w-full h-full overflow-hidden bg-muted touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          {objectUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              ref={imgRef}
              src={objectUrl}
              alt=""
              draggable={false}
              onLoad={handleImageLoad}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: naturalSize ? naturalSize.w * baseCoverScale * scale : 'auto',
                height: naturalSize ? naturalSize.h * baseCoverScale * scale : 'auto',
                transform: `translate(calc(-50% + ${translate.x}px), calc(-50% + ${translate.y}px))`,
                userSelect: 'none',
                maxWidth: 'none',
              }}
            />
          )}

          {/* Zoom slider + reset, anchored at the bottom of the
              cropper. We surface it INSIDE the preview area so the
              parent modal layout doesn't need to change to host it. */}
          <div
            className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-lg bg-black/55 px-2 py-1 backdrop-blur-sm pointer-events-none"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <Maximize className="w-3.5 h-3.5 text-white/80 shrink-0" />
            <input
              type="range"
              min={MIN_SCALE}
              max={MAX_SCALE}
              step={0.01}
              value={scale}
              onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
              className="flex-1 h-1 accent-primary pointer-events-auto"
            />
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center justify-center w-6 h-6 rounded text-white/80 hover:bg-white/10 pointer-events-auto"
              title="Reset"
              aria-label="Reset crop"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          {!objectUrl && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}
        </div>
      </div>
    )
  },
)

export default CoverImageCropper
