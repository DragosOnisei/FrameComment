'use client'

import { useEffect, useState, useRef } from 'react'

/**
 * 1.3.2+: Social-media safe-zone overlay.
 *
 * Draws a guide frame on top of the <video> showing what would be
 * visible after cropping the source to the chosen platform aspect
 * ratio, plus translucent red zones where the platform's own UI
 * (like/share/comment buttons, title bar, etc.) would overlap.
 *
 * The video is rendered with `object-contain` inside an aspect-locked
 * wrapper, so the actual painted video may be smaller than the wrapper
 * (letterboxing). We measure the real painted rect via the wrapper's
 * computed dimensions and the video's intrinsic aspect ratio, then
 * draw the overlay only inside that rect.
 */
export type SafeZonePreset = 'off' | '9:16' | '4:5' | '16:9'

interface Props {
  /** Active preset; 'off' renders nothing. */
  mode: SafeZonePreset
  /** Source video intrinsic dimensions (or selectedVideo.width/height
   *  from Prisma). Used to compute the painted rect inside the wrapper
   *  so the safe-zone lines line up with what the user actually sees. */
  videoWidth: number | null | undefined
  videoHeight: number | null | undefined
  /** Wrapper that contains the <video> element. Same one we use for
   *  AnnotationOverlay; the overlay sits as an absolute child. */
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface PaintedRect {
  left: number
  top: number
  width: number
  height: number
}

export default function SafeZoneOverlay({
  mode,
  videoWidth,
  videoHeight,
  containerRef,
}: Props) {
  const [rect, setRect] = useState<PaintedRect | null>(null)

  // Recompute the painted rect on every container resize. Object-contain
  // letterboxes the video inside the wrapper, so the real video rect
  // can be smaller than the wrapper rect in either axis.
  useEffect(() => {
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
        // Video wider than wrapper → fill width, letterbox top/bottom.
        paintedW = w
        paintedH = w / videoAR
        top = (h - paintedH) / 2
      } else {
        // Video taller than wrapper → fill height, pillarbox sides.
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
  }, [containerRef, videoWidth, videoHeight])

  if (mode === 'off' || !rect) return null

  // For each preset compute the CROP frame (what survives the export
  // to that platform's canvas) and the UI overlay zones inside it.
  // All numbers are expressed as fractions of the painted video rect.
  const videoAR = (videoWidth || 16) / (videoHeight || 9)

  // Helper: a centred crop frame at `targetAR` (e.g. 9/16 for Shorts).
  // Returns {x, y, w, h} fractions of the painted video.
  const computeCrop = (targetAR: number) => {
    if (Math.abs(videoAR - targetAR) < 0.001) {
      // Video already matches → crop is the whole frame.
      return { x: 0, y: 0, w: 1, h: 1 }
    }
    if (videoAR > targetAR) {
      // Source wider than target → pillarbox to fit target height.
      const w = targetAR / videoAR
      return { x: (1 - w) / 2, y: 0, w, h: 1 }
    }
    // Source taller than target → letterbox top/bottom.
    const h = videoAR / targetAR
    return { x: 0, y: (1 - h) / 2, w: 1, h }
  }

  // UI overlay zones per platform, expressed as fractions OF THE CROP
  // (not the painted video). Each is `{x, y, w, h, label}`.
  type Zone = { x: number; y: number; w: number; h: number; label?: string }
  let crop: { x: number; y: number; w: number; h: number }
  let zones: Zone[] = []
  let label = ''
  if (mode === '9:16') {
    crop = computeCrop(9 / 16)
    label = '9:16 · YT Shorts / Reels / TikTok'
    // Right rail (like/dislike/comment/share/remix/more) — typically
    // takes the right ~14% of the canvas from roughly 45% down to
    // 95%. Bottom title/description ribbon is ~18% tall.
    zones = [
      { x: 0.86, y: 0.4, w: 0.14, h: 0.55, label: 'UI: buttons' },
      { x: 0, y: 0.82, w: 0.86, h: 0.18, label: 'UI: title' },
      { x: 0, y: 0, w: 1, h: 0.06, label: 'UI: top bar' },
    ]
  } else if (mode === '4:5') {
    crop = computeCrop(4 / 5)
    label = '4:5 · Instagram feed'
    // IG feed doesn't overlay UI on the video itself (it sits below),
    // but the bottom 10% gets covered by the username/caption gradient
    // when watched fullscreen on mobile.
    zones = [
      { x: 0, y: 0.9, w: 1, h: 0.1, label: 'UI: caption' },
    ]
  } else {
    // 16:9 — landscape (YouTube / Vimeo).
    crop = computeCrop(16 / 9)
    label = '16:9 · YouTube / Vimeo'
    // YouTube transport overlay covers the bottom ~10 % when hovered;
    // the progress bar pill takes the bottom 1-2 %.
    zones = [
      { x: 0, y: 0.9, w: 1, h: 0.1, label: 'UI: controls' },
    ]
  }

  // Translate crop fractions to absolute pixels inside the painted rect.
  const cropPx = {
    left: rect.left + crop.x * rect.width,
    top: rect.top + crop.y * rect.height,
    width: crop.w * rect.width,
    height: crop.h * rect.height,
  }

  return (
    <div
      className="absolute inset-0 pointer-events-none z-[35]"
      aria-hidden="true"
    >
      {/* Crop frame: dashed white border with a subtle dark fill
          outside the crop area so the eye is drawn to the visible
          portion. */}
      <div
        className="absolute"
        style={{
          left: cropPx.left,
          top: cropPx.top,
          width: cropPx.width,
          height: cropPx.height,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
          border: '2px dashed rgba(255,255,255,0.9)',
        }}
      />

      {/* UI overlay zones inside the crop — translucent red with a
          dashed red border so the user can immediately see whether
          their content collides with platform UI. */}
      {zones.map((z, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: cropPx.left + z.x * cropPx.width,
            top: cropPx.top + z.y * cropPx.height,
            width: z.w * cropPx.width,
            height: z.h * cropPx.height,
            backgroundColor: 'rgba(255, 80, 80, 0.18)',
            border: '1px dashed rgba(255, 100, 100, 0.85)',
          }}
        />
      ))}

      {/* Tiny label in the top-left of the painted rect so the user
          remembers which preset is active. */}
      <div
        className="absolute px-2 py-0.5 rounded text-[10px] font-mono font-semibold text-white shadow-md"
        style={{
          left: rect.left + 8,
          top: rect.top + 8,
          backgroundColor: 'rgba(0,0,0,0.65)',
          backdropFilter: 'blur(4px)',
        }}
      >
        {label}
      </div>
    </div>
  )
}
