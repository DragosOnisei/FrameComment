import type { CSSProperties } from 'react'

/**
 * Frame.io-style smart popover positioning (1.3.1+).
 *
 * Given the bounding rect of an anchor element (typically the kebab
 * button), return inline `style` props that place a popover so that:
 *
 *   1. The popover's right edge sits flush with the anchor's right
 *      edge by default (Frame.io / macOS menu convention), then is
 *      clamped horizontally so it never falls outside the viewport.
 *   2. The popover opens BELOW the anchor when there's enough room,
 *      otherwise FLIPS to open ABOVE it. This matters on phones where
 *      a kebab near the bottom of the screen would otherwise get
 *      occluded by the browser chrome (URL bar, gesture handle).
 *   3. Vertical sizing is capped to the available space minus a small
 *      margin so the popover always fits, with `overflow-y: auto`
 *      gracefully handling tall menus that don't fit either way.
 */
export function computePopoverStyle(
  anchorRect: DOMRect,
  options?: {
    /** Desired width in px. Default 240. */
    width?: number
    /**
     * Approximate menu height in px. Used only to decide whether to
     * flip above the anchor — actual height is constrained by
     * `maxHeight`. Default 280 (fits ~7 menu items).
     */
    estimatedHeight?: number
    /** Safety gap from the viewport edges. Default 8 px. */
    margin?: number
  },
): CSSProperties {
  const width = options?.width ?? 240
  const estimatedHeight = options?.estimatedHeight ?? 280
  const margin = options?.margin ?? 8
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768

  // Horizontal: right-align to anchor, clamp inside viewport.
  let left = anchorRect.right - width
  if (left < margin) left = margin
  if (left + width > vw - margin) {
    left = vw - width - margin
  }
  const clampedWidth = Math.min(width, vw - margin * 2)

  // Vertical: prefer below, flip to above if more space up there.
  const spaceBelow = vh - anchorRect.bottom - margin
  const spaceAbove = anchorRect.top - margin
  const fitsBelow = spaceBelow >= estimatedHeight
  const openAbove = !fitsBelow && spaceAbove > spaceBelow

  if (openAbove) {
    return {
      position: 'fixed',
      bottom: Math.max(vh - anchorRect.top + 4, margin),
      left,
      width: clampedWidth,
      maxHeight: Math.max(spaceAbove - 4, 120),
    }
  }
  return {
    position: 'fixed',
    top: anchorRect.bottom + 4,
    left,
    width: clampedWidth,
    maxHeight: Math.max(spaceBelow - 4, 120),
  }
}
