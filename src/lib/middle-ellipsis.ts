/**
 * 7.17.3: a one-line label with the ellipsis in the MIDDLE.
 *
 * CSS `text-overflow: ellipsis` can only cut the END of a line, and the end
 * of a FrameComment filename is where the information is
 * ("…_9×16_V7"). The Quick Look preview (Space on a card) used to let the
 * whole title decide the width of the window instead — a 9:16 clip opened
 * in a wide box with black bars on both sides because its 85-character name
 * had to fit on one line. The window is now as wide as the video, and the
 * title is fitted into that width here: the first characters, "…", the last
 * characters, as many of each as fit. The full name stays in the tooltip.
 *
 * `measure` returns the rendered width of a string in CSS pixels (the
 * component passes a canvas `measureText` with the element's font), so this
 * function is pure and a node script can check it with a fake ruler. Head
 * and tail split the kept characters evenly (head gets the odd one); when
 * not even "a…b" fits, only the ellipsis is returned. Characters are code
 * points, so an emoji or "×" is never cut in half.
 */
export const ELLIPSIS = '…'

export function middleEllipsis(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string {
  if (!text) return text
  if (measure(text) <= maxWidth) return text
  const chars = Array.from(text)
  const n = chars.length
  const build = (keep: number): string => {
    const head = Math.ceil(keep / 2)
    const tail = keep - head
    return chars.slice(0, head).join('') + ELLIPSIS + (tail > 0 ? chars.slice(n - tail).join('') : '')
  }
  // Width grows with `keep`, so the largest fitting `keep` is found by
  // bisection; keep = n − 1 drops exactly one character.
  if (measure(build(0)) > maxWidth) return ELLIPSIS
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(build(mid)) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return build(lo)
}

let rulerCanvas: HTMLCanvasElement | null = null

/**
 * Rendered width of `text` in the given CSS font (the `font` shorthand, or
 * the longhands joined as "style weight size family"). Falls back to a rough
 * 7 px per character where there is no canvas (server render, old browsers).
 */
export function measureTextWidth(text: string, font: string): number {
  if (typeof document === 'undefined') return text.length * 7
  rulerCanvas ??= document.createElement('canvas')
  const ctx = rulerCanvas.getContext('2d')
  if (!ctx) return text.length * 7
  ctx.font = font
  return ctx.measureText(text).width
}

/**
 * The element's font as a canvas-compatible string. Firefox leaves the
 * `font` shorthand empty in getComputedStyle, so the longhands are the
 * reliable source.
 */
export function fontOf(style: CSSStyleDeclaration): string {
  const shorthand = style.font?.trim()
  if (shorthand) return shorthand
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize || '14px'} ${style.fontFamily || 'sans-serif'}`
}
