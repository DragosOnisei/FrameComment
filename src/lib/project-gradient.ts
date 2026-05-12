/**
 * Deterministic gradient generator for project tiles on the admin
 * dashboard (1.0.6+). Same project id → same gradient every time, so
 * the visual identity stays stable across reloads.
 *
 * Strategy: hash the id into 3 numbers that pick a hue + tilt + a
 * second hue, then build a CSS `linear-gradient(...)` with a pair of
 * vibrant stops. We bias the hues toward the magenta → blue → teal
 * arc Frame.io uses so the grid reads as a coherent set rather than
 * a clown-car of random colours.
 */

function hashStringToInt(input: string): number {
  // Standard FNV-1a 32-bit hash. Cheap, no collisions in practice for
  // CUID-shaped ids.
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Returns a CSS background string suitable for `style.background`
 * applied to a tile element. The gradient uses two hues in the
 * 220° → 320° range (cool blue → magenta) with a hint of warmth on
 * the corner, mirroring Frame.io's macOS-wallpaper look.
 */
export function projectGradient(id: string): string {
  const hash = hashStringToInt(id)
  // 32 bits → split into 4 bytes for 4 independent dials.
  const b1 = hash & 0xff
  const b2 = (hash >> 8) & 0xff
  const b3 = (hash >> 16) & 0xff
  const b4 = (hash >> 24) & 0xff

  // Hue arcs. We keep them in the cool/magenta range so the grid
  // looks like one family. ~220° (blue) → ~330° (pink).
  const hueA = 210 + (b1 % 130) // 210–340
  const hueB = (hueA + 30 + (b2 % 60)) % 360 // 30–90° off from A
  const angle = 100 + (b3 % 80) // 100°–180° tilt
  const sat = 65 + (b4 % 20) // 65–85% — vivid but not neon
  const lightA = 55
  const lightB = 60

  return `linear-gradient(${angle}deg, hsl(${hueA} ${sat}% ${lightA}%) 0%, hsl(${hueB} ${sat}% ${lightB}%) 100%)`
}

/**
 * Compact relative-time formatter ("2h ago", "3d ago", "11mo ago",
 * "1y ago"). Designed to match the Frame.io tile footer string. Falls
 * back to "just now" for anything under a minute.
 */
export function formatRelativeTime(date: Date | string | number): string {
  const t = typeof date === 'number' ? date : new Date(date).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, Date.now() - t)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.round(diff / minute)}m ago`
  if (diff < day) return `${Math.round(diff / hour)}h ago`
  if (diff < month) return `${Math.round(diff / day)}d ago`
  if (diff < year) return `${Math.round(diff / month)}mo ago`
  return `${Math.round(diff / year)}y ago`
}

/** Format a byte count as a human-readable string with 1 decimal. */
export function formatBytes(bytes: number | bigint | string | null | undefined): string {
  if (bytes === null || bytes === undefined) return '0 B'
  const n = typeof bytes === 'string' ? Number(bytes) : Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // Whole bytes show no decimal; everything else gets one.
  const fixed = i === 0 ? v.toFixed(0) : v.toFixed(1)
  return `${fixed} ${units[i]}`
}
