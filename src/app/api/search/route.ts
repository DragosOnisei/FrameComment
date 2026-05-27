import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { generateVideoAccessToken } from '@/lib/video-access'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 1.7.0+: Global video search across every project/folder. Admin
 * only. The frontend hits this endpoint twice during a single
 * session:
 *
 *   1. As the user types (debounced, `?q=foo&limit=5`) — for the
 *      live dropdown shown directly under the search input.
 *   2. On Enter / submit (`?q=foo&limit=100`) — to populate the
 *      two-pane full results screen.
 *
 * We deliberately keep the response shape identical for both calls
 * so the live dropdown can reuse the heavy view's renderer.
 *
 * The Postgres query is a simple case-insensitive `contains` on
 * `Video.name`. Trash is filtered out (both project-level and
 * video-level `deletedAt`). Ordered by `updatedAt desc` so freshly
 * touched assets float to the top — matches how editors think
 * about "the video I was just working on".
 *
 * Thumbnails are signed per-admin so the existing `/api/content/<token>`
 * route serves them without an extra auth round-trip from <img>.
 */

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 100
const MIN_QUERY_LENGTH = 3

export async function GET(request: NextRequest) {
  // SECURITY: admin-only — clients/guest editors must not see this
  // endpoint exist. Returning the bare 401 from requireApiAdmin is
  // fine; we don't leak query text into the unauthenticated path.
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }
  const admin = authResult

  const { searchParams } = new URL(request.url)
  const rawQuery = (searchParams.get('q') || '').trim()
  const requestedLimit = parseInt(searchParams.get('limit') || '', 10)
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT

  // Empty / too-short queries return an empty result set rather
  // than a 400 — the UI will simply hide the dropdown until the
  // user types 3+ chars. Saves us a round trip on every keystroke
  // below threshold.
  if (rawQuery.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ results: [], total: 0, query: rawQuery })
  }

  try {
    // Match on Video.name (case-insensitive `contains`). Excludes
    // soft-deleted videos AND videos whose owning project is in the
    // trash so the search mirrors what the admin sees in the UI.
    const where = {
      deletedAt: null,
      name: { contains: rawQuery, mode: 'insensitive' as const },
      project: { deletedAt: null },
    }

    // 1.7.0+: stacks are modelled as multiple Video rows sharing the
    // same (projectId, folderId, name). The folder UI only ever
    // shows the latest version, so the search MUST dedupe the same
    // way — otherwise three versions of "Episode 3" each get their
    // own row and the admin sees the same asset repeated 3×.
    //
    // We pull a wider window than `limit` (×5, capped), pick the
    // highest version per stack, re-sort by `updatedAt desc`, then
    // slice down to the requested limit. The wider window protects
    // us from cases where the top N rows all belong to the same
    // stack — without it we'd return < N distinct assets.
    const fetchWindow = Math.min(limit * 5, 500)
    const rawVideos = await prisma.video.findMany({
      where,
      select: {
        id: true,
        name: true,
        projectId: true,
        folderId: true,
        thumbnailPath: true,
        preview720Path: true,
        preview1080Path: true,
        preview2160Path: true,
        duration: true,
        width: true,
        height: true,
        mediaType: true,
        originalFileName: true,
        originalFileSize: true,
        createdAt: true,
        updatedAt: true,
        status: true,
        version: true,
        versionLabel: true,
        project: {
          select: { id: true, title: true },
        },
        folder: {
          select: { id: true, name: true },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
      take: fetchWindow,
    })

    // Dedupe by (projectId, folderId, name) — keep the latest
    // version (highest `version`, with `updatedAt` as a tiebreaker).
    const byStack = new Map<string, any>()
    for (const v of rawVideos) {
      const key = `${v.projectId}::${v.folderId ?? ''}::${v.name}`
      const existing = byStack.get(key)
      if (
        !existing ||
        v.version > existing.version ||
        (v.version === existing.version &&
          new Date(v.updatedAt) > new Date(existing.updatedAt))
      ) {
        byStack.set(key, v)
      }
    }
    // Stable order: most recently updated stack first.
    const videos = Array.from(byStack.values())
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, limit)

    // Total = number of DISTINCT stacks matching, not the raw row
    // count. Cheaper than COUNT(DISTINCT (...)) — Prisma's groupBy
    // returns one row per stack so its length IS the count.
    const stackGroups = await prisma.video.groupBy({
      by: ['projectId', 'folderId', 'name'],
      where,
    })
    const total = stackGroups.length

    // Mint thumbnail tokens in parallel — same pattern as the
    // folder GET so the Redis cache amortises subsequent searches
    // in the same admin session.
    const sessionId = `admin:${admin.id}`
    const results = await Promise.all(
      videos.map(async (v: any) => {
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
            logError('[GET /api/search] thumbnail token failed:', err)
          }
        }
        // 1.7.0+: signed preview URL for the right-pane <video> tag.
        // Prefer 720p (smallest transcode that still looks decent),
        // then 1080p, then 2160p. Images don't get a preview URL —
        // the renderer falls back to the thumbnail tag.
        let previewUrl: string | null = null
        if (v.mediaType !== 'IMAGE') {
          const quality = v.preview720Path
            ? '720p'
            : v.preview1080Path
            ? '1080p'
            : v.preview2160Path
            ? '2160p'
            : null
          if (quality) {
            try {
              const token = await generateVideoAccessToken(
                v.id,
                v.projectId,
                quality,
                request,
                sessionId,
              )
              previewUrl = `/api/content/${token}`
            } catch (err) {
              logError('[GET /api/search] preview token failed:', err)
            }
          }
        }
        return {
          id: v.id,
          name: v.name,
          projectId: v.projectId,
          folderId: v.folderId,
          // Project model uses `title`, not `name`. Map it to
          // `projectName` so the client-side renderer doesn't have
          // to care about the schema field.
          projectName: v.project?.title ?? null,
          folderName: v.folder?.name ?? null,
          thumbnailUrl,
          previewUrl,
          duration: v.duration,
          width: v.width,
          height: v.height,
          mediaType: v.mediaType,
          originalFileName: v.originalFileName,
          originalFileSize: v.originalFileSize.toString(),
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
          status: v.status,
          versionLabel: v.versionLabel,
        }
      }),
    )

    return NextResponse.json({ results, total, query: rawQuery })
  } catch (error) {
    logError('[GET /api/search] failed:', error)
    return NextResponse.json(
      { error: 'Search failed', results: [], total: 0 },
      { status: 500 },
    )
  }
}
