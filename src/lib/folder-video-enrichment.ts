/**
 * Per-video admin enrichment (1.0.7+).
 *
 * Mints the trio of access tokens (thumbnail / preview / storyboard)
 * for every video row a folder-style API endpoint is about to send to
 * the admin. Originally inlined in `/api/folders/[id]`; lifted into a
 * shared helper so the project-root listing can serve videos that
 * live at `folderId === null` with the same shape.
 *
 * The helper also handles BigInt → string conversion on
 * `originalFileSize` and the soft-fail uploader lookup that would
 * otherwise crash on databases without the `createdById` column
 * migrated.
 */

import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateVideoAccessToken } from '@/lib/video-access'
import { legacyBackend } from '@/lib/storage-backends'
import { logError } from '@/lib/logging'

/** A single video row, minimally typed — we only touch the fields we
 *  actually use here and pass the rest through untouched. */
type VideoLike = {
  id: string
  projectId: string
  thumbnailPath?: string | null
  // 1.9.4+ Phase A: 480p tier is the fastest progressive preview.
  // Preferred for hover-scrub because the file is small (lower
  // seek-and-decode cost than the higher tiers).
  preview480Path?: string | null
  preview720Path?: string | null
  preview1080Path?: string | null
  preview2160Path?: string | null
  storyboardPath?: string | null
  originalFileSize?: bigint | number | string | null
  _count?: { comments?: number }
  [key: string]: any
}

/**
 * Enrich an array of video rows with admin tokens + computed fields,
 * matching the shape `VideoCard` expects.
 *
 * `request` and `sessionId` are forwarded straight to
 * `generateVideoAccessToken` (sessionId is usually `admin:${adminId}`
 * so the Redis token cache amortises subsequent loads).
 *
 * `tag` is used in error messages so each call site can be identified
 * in the logs.
 */
export async function enrichVideosForAdmin<T extends VideoLike>(
  videos: T[],
  request: NextRequest,
  sessionId: string,
  tag = 'enrichVideosForAdmin',
): Promise<Array<T & {
  thumbnailUrl: string | null
  previewUrl: string | null
  storyboardUrl: string | null
  originalFileSize: string | number | null
  commentCount: number
  createdBy: any
}>> {
  // Uploader lookup — best effort, won't break the listing when the
  // `createdById` migration hasn't been applied yet.
  const uploadersByVideoId = new Map<string, any>()
  try {
    const videoIds = videos.map((v) => v.id)
    if (videoIds.length) {
      const rows = await prisma.video.findMany({
        where: { id: { in: videoIds } },
        select: {
          id: true,
          createdBy: {
            select: { id: true, name: true, username: true, email: true },
          },
        },
      })
      for (const r of rows) {
        if ((r as any).createdBy) {
          uploadersByVideoId.set(r.id, (r as any).createdBy)
        }
      }
    }
  } catch (err) {
    logError(`[${tag}] uploader lookup skipped:`, err)
  }

  return Promise.all(
    videos.map(async (v) => {
      let thumbnailUrl: string | null = null
      if (v.thumbnailPath) {
        try {
          const token = await generateVideoAccessToken(
            v.id,
            v.projectId,
            'thumbnail',
            request,
            sessionId,
          )
          thumbnailUrl = `/api/content/${token}`
        } catch (err) {
          logError(`[${tag}] thumbnail token failed:`, err)
        }
      }

      let previewUrl: string | null = null
      // 1.9.4+ Phase A: hover-scrub fallback prefers the SMALLEST
      // tier available. When the storyboard sprite isn't ready
      // yet the VideoCard falls back to seeking a real <video>
      // element — that seek-and-decode is dramatically faster on
      // a 480p preview (~100 MB for a 40-min source) than on the
      // original 2.7 GB master. Without this fix the scrub feels
      // visibly jerky until the storyboard sprite lands.
      const previewQuality = v.preview480Path
        ? '480p'
        : v.preview720Path
          ? '720p'
          : v.preview1080Path
            ? '1080p'
            : v.preview2160Path
              ? '2160p'
              : 'original'
      try {
        const token = await generateVideoAccessToken(
          v.id,
          v.projectId,
          previewQuality,
          request,
          sessionId,
        )
        previewUrl = `/api/content/${token}`
      } catch (err) {
        logError(`[${tag}] preview token failed:`, err)
      }

      let storyboardUrl: string | null = null
      if (v.storyboardPath) {
        try {
          const token = await generateVideoAccessToken(
            v.id,
            v.projectId,
            'storyboard',
            request,
            sessionId,
          )
          storyboardUrl = `/api/content/${token}`
        } catch (err) {
          logError(`[${tag}] storyboard token failed:`, err)
        }
      }

      return {
        ...v,
        originalFileSize:
          typeof v.originalFileSize === 'bigint'
            ? v.originalFileSize.toString()
            : (v.originalFileSize ?? null),
        // 4.2.0+: resolve NULL (legacy) to the instance default backend so the
        // storage tag shows the real location for older videos at the root too.
        storageBackend: (v as any).storageBackend ?? legacyBackend(),
        thumbnailUrl,
        previewUrl,
        storyboardUrl,
        commentCount: v._count?.comments ?? 0,
        createdBy: uploadersByVideoId.get(v.id) ?? null,
      }
    }),
  )
}
