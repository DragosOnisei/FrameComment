/**
 * 7.17.7: counts on the dashboard read as "1.2k folders · 2.7k videos", not
 * "1169 folders · 2668 videos" (Dragos, 2026-10-04, from the 99_OLD PROJECTS
 * card). Below 1000 the number is exact. From 1000 the value is shown with
 * one decimal and a letter — k for thousands, M for millions, B beyond — and
 * the decimal is dropped when it is zero or when the integer part already
 * has two digits (12k, not 12.3k: the card is not the place for that
 * precision). The exact value stays available to callers for a tooltip.
 *
 * Pure, so a node script checks the edges: 999, 1000, 1049 (rounds to
 * "1k", never "1.0k"), 999500 (rounds up into "1M", not "1000k").
 */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs < 1000) return sign + String(Math.round(abs))
  const units: Array<[number, string]> = [
    [1e3, 'k'],
    [1e6, 'M'],
    [1e9, 'B'],
  ]
  for (let i = 0; i < units.length; i++) {
    const [size, letter] = units[i]
    const next = units[i + 1]
    const value = abs / size
    // One decimal below 10, whole numbers from 10 up.
    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
    // Rounding can carry into the next unit (999500 / 1e3 = 999.5 → "1000k"):
    // let the next unit show it as "1M" instead.
    if (rounded >= 1000 && next) continue
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    return `${sign}${text}${letter}`
  }
  return sign + String(Math.round(abs))
}
