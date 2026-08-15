/**
 * 6.9.0 — the download-resolution ladder.
 *
 * One place that knows which encoded tiers a video has, what they're called
 * in the UI, and how big each file is. Both the menu and the download route
 * read from here, so what you're offered and what you get can't drift apart.
 *
 * On sizes: they are recorded when a tier finishes encoding. Videos uploaded
 * before that existed have no recorded size, so the first time someone opens
 * the menu we measure the file on storage and write the number down. Measuring
 * is a HEAD request or a stat — cheap — and it happens once per file, ever.
 */

import { prismaPrivileged } from './db'
import { getStorageFileSize } from './storage'
import { logError } from './logging'

export interface QualityOption {
  /** Token quality string, e.g. '1080p'. */
  quality: string
  /** What the user sees: SD / HD / HD+ / 4K / Original. */
  label: string
  /** Height in pixels, for ordering and for the secondary line. */
  height: number | null
  /** Bytes, or null when we could not measure the file. */
  bytes: number | null
  /** True when the file carries a watermark (no clean tier available yet). */
  watermarked: boolean
}

/** Tier definitions, smallest first. `label` is the customer-facing name. */
const TIERS = [
  { quality: '480p', label: 'SD', height: 480, wm: 'preview480Path', clean: null, size: 'preview480Size' },
  { quality: '720p', label: 'HD', height: 720, wm: 'preview720Path', clean: 'cleanPreview720Path', size: 'preview720Size' },
  { quality: '1080p', label: 'HD+', height: 1080, wm: 'preview1080Path', clean: 'cleanPreview1080Path', size: 'preview1080Size' },
  { quality: '2160p', label: '4K', height: 2160, wm: 'preview2160Path', clean: 'cleanPreview2160Path', size: 'preview2160Size' },
] as const

/** Quality strings that mean "this exact encoded tier", not a fallback ladder. */
export const EXACT_DOWNLOAD_TIERS: string[] = TIERS.map((t) => t.quality)

/**
 * The exact file for one tier. Clean (un-watermarked) is preferred when the
 * video is approved and a clean render exists; otherwise the watermarked one.
 * Returns null when that tier was never produced — the caller must not
 * substitute a different resolution.
 */
export function exactPreviewPath(video: any, quality: string): string | null {
  const tier = TIERS.find((t) => t.quality === quality)
  if (!tier) return null
  const clean = tier.clean ? (video[tier.clean] as string | null | undefined) : null
  if (video.approved && clean) return clean
  return (video[tier.wm] as string | null | undefined) || clean || null
}

function isWatermarked(video: any, quality: string): boolean {
  const tier = TIERS.find((t) => t.quality === quality)
  if (!tier) return false
  const clean = tier.clean ? (video[tier.clean] as string | null | undefined) : null
  return !(video.approved && clean)
}

/**
 * Every resolution this video can actually be downloaded at, with sizes.
 *
 * `includeOriginal` is for admins: the source file is always available to
 * them, and its size is already in the database.
 */
export async function listVideoQualities(
  videoId: string,
  options: { includeOriginal?: boolean } = {},
): Promise<QualityOption[]> {
  const video = (await (prismaPrivileged as any).video.findUnique({
    where: { id: videoId },
  })) as any
  if (!video) return []

  const out: QualityOption[] = []
  const sizesToPersist: Record<string, bigint> = {}

  for (const tier of TIERS) {
    const path = exactPreviewPath(video, tier.quality)
    if (!path) continue

    let bytes: number | null = null
    const stored = video[tier.size]
    if (stored != null) {
      bytes = Number(stored)
    } else {
      // Not recorded (encoded before 6.9.0, or a clean render swapped in).
      // Measure once and remember.
      try {
        bytes = await getStorageFileSize(path, (video as any).storageBackend || undefined)
        if (Number.isFinite(bytes) && bytes > 0) {
          sizesToPersist[tier.size] = BigInt(Math.round(bytes))
        }
      } catch (error) {
        // A missing or unreachable file must not break the menu — the entry
        // simply shows no size rather than a made-up one.
        logError(`[qualities] could not measure ${tier.quality} for ${videoId}:`, error)
        bytes = null
      }
    }

    out.push({
      quality: tier.quality,
      label: tier.label,
      height: tier.height,
      bytes,
      watermarked: isWatermarked(video, tier.quality),
    })
  }

  if (Object.keys(sizesToPersist).length > 0) {
    await (prismaPrivileged as any).video
      .update({ where: { id: videoId }, data: sizesToPersist })
      .catch((err: unknown) => logError('[qualities] failed to persist sizes:', err))
  }

  if (options.includeOriginal && video.originalStoragePath) {
    out.push({
      quality: 'original',
      label: 'Original',
      height: null,
      bytes: video.originalFileSize != null ? Number(video.originalFileSize) : null,
      watermarked: false,
    })
  }

  return out
}

// Formatting lives in video-qualities-format so client components can use it
// without pulling Prisma and the storage layer into the browser bundle.
export { formatBytes } from './video-qualities-format'
