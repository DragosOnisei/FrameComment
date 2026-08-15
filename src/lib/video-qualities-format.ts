/**
 * 6.9.0 — formatting helpers for the download-resolution menu.
 *
 * Kept apart from `video-qualities.ts` on purpose: that module talks to Prisma
 * and storage, so importing it from a client component would drag the server
 * into the browser bundle. This file has no imports and is safe on both sides.
 */

/** "1.2 GB" / "480 MB". Decimal units, the way file managers show them. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
