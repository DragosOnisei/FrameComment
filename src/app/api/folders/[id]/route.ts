import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { updateFolderSchema, safeParseBody } from '@/lib/validation'
import {
  loadFolderAncestry,
  wouldCreateFolderCycle,
} from '@/lib/folder-helpers'
import { encrypt } from '@/lib/encryption'
import { logError } from '@/lib/logging'
import { generateVideoAccessToken } from '@/lib/video-access'
import { fetchFolderPreviewData } from '@/lib/folder-previews'
import { computeFolderSizesByProject } from '@/lib/folder-sizes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/folders/[id]
 *
 * Read a folder with its immediate contents (direct subfolders and
 * direct videos) plus a breadcrumb back to the project root. Admin-
 * only — the public share page hits a different endpoint that gates
 * by slug + auth.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult
  const admin = authResult
  const { id } = await params

  try {
    // Two-step load so a missing migration (createdById column not
    // yet present) doesn't take down the whole folder view. We do
    // the main folder load first WITHOUT the uploader include, then
    // attempt to attach uploader info on a best-effort basis.
    const folder = await prisma.folder.findUnique({
      where: { id },
      include: {
        // 1.0.8+: skip soft-deleted children. Trashed items live in
        // the dedicated `/admin/trash` page; the folder grid never
        // shows them.
        subfolders: {
          where: { deletedAt: null } as any,
          orderBy: { name: 'asc' },
          include: {
            _count: { select: { subfolders: true, videos: true } },
          },
        },
        videos: {
          where: { deletedAt: null } as any,
          orderBy: [{ name: 'asc' }, { version: 'desc' }],
          include: {
            // Comment count per video — drives the speech-bubble
            // badge on the Frame.io-style VideoCard.
            _count: { select: { comments: true } },
          },
        },
        _count: { select: { subfolders: true, videos: true } },
      },
    })
    if (!folder) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }
    // If the folder itself is in Trash, treat it as a 404 — admins
    // only reach it from the Trash page, which uses a different
    // endpoint.
    if ((folder as any).deletedAt) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    // Best-effort uploader lookup. After `prisma migrate dev` this
    // returns a Map<videoId, user>; before the migration the query
    // throws (column missing) and we silently fall back to no
    // uploader info.
    const uploadersByVideoId = new Map<string, any>()
    try {
      const videoIds = folder.videos.map((v: any) => v.id)
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
      logError('[GET /api/folders/[id]] uploader lookup skipped:', err)
    }
    const breadcrumb = await loadFolderAncestry(folder.id)

    // Per-video thumbnail tokens (1.0.6+). We mint short-lived signed
    // tokens for each video that has a thumbnailPath, then expose
    // them as `/api/content/<token>` URLs the client can drop
    // straight into <img src>. Stable sessionId per-admin so the
    // Redis cache amortises subsequent folder visits.
    const sessionId = `admin:${admin.id}`
    const videosWithExtras = await Promise.all(
      folder.videos.map(async (v: any) => {
        let thumbnailUrl: string | null = null
        if (v.thumbnailPath) {
          try {
            const token = await generateVideoAccessToken(
              v.id,
              folder.projectId,
              'thumbnail',
              request,
              sessionId,
            )
            thumbnailUrl = `/api/content/${token}`
          } catch (err) {
            // A failure here just means no thumbnail — the card
            // falls back to the Film icon. Don't fail the whole
            // folder load on a single bad thumbnail.
            logError('[GET /api/folders/[id]] thumbnail token failed:', err)
          }
        }

        // Preview URL drives the hover-scrub FALLBACK on VideoCard
        // when a video has no storyboard sprite yet (1.0.6+). Pick
        // the smallest preview that exists so the browser doesn't
        // pull a 4K original just to scrub a tile.
        let previewUrl: string | null = null
        // 4.0.x: CAP the preview at HD (720p). This URL feeds both the
        // hover-scrub fallback AND the Quick Preview (Space) player, and
        // we never want either to pull a 1080p/4K/original stream — the
        // old chain climbed UP (720→1080→2160→original) when 720p was
        // missing, which is the opposite of a cap. Now: prefer 720p, then
        // fall DOWN to 480p, and only climb higher when no low tier exists
        // at all (rare — 480p is always the first tier produced).
        const previewQuality = v.preview720Path
          ? '720p'
          : v.preview480Path
          ? '480p'
          : v.preview1080Path
          ? '1080p'
          : v.preview2160Path
          ? '2160p'
          : 'original'
        try {
          const token = await generateVideoAccessToken(
            v.id,
            folder.projectId,
            previewQuality,
            request,
            sessionId,
          )
          previewUrl = `/api/content/${token}`
        } catch (err) {
          logError('[GET /api/folders/[id]] preview token failed:', err)
        }

        // Storyboard sprite-sheet (1.0.6+). When present, the card
        // uses CSS background-position scrubbing — INSTANT, no
        // network round-trip per frame. Falls back to previewUrl
        // above for legacy rows.
        let storyboardUrl: string | null = null
        if ((v as any).storyboardPath) {
          try {
            const token = await generateVideoAccessToken(
              v.id,
              folder.projectId,
              'storyboard',
              request,
              sessionId,
            )
            storyboardUrl = `/api/content/${token}`
          } catch (err) {
            logError('[GET /api/folders/[id]] storyboard token failed:', err)
          }
        }

        return {
          ...v,
          // Serialise BigInt so NextResponse.json doesn't throw.
          originalFileSize:
            typeof v.originalFileSize === 'bigint'
              ? v.originalFileSize.toString()
              : v.originalFileSize,
          thumbnailUrl,
          previewUrl,
          storyboardUrl,
          commentCount: v._count?.comments ?? 0,
          // Attach uploader info from the side query when available.
          createdBy: uploadersByVideoId.get(v.id) ?? null,
        }
      }),
    )

    // Mosaic preview + corrected item count for each subfolder
    // (1.0.7+). Mirrors what the root-level GET /api/folders does so
    // drilling into a folder keeps showing the same Frame.io-style
    // cover tiles AND the version-aware "N items" label on its
    // children.
    let subfolderPreviews = new Map<string, unknown[]>()
    let subfolderItemCounts = new Map<string, number>()
    try {
      const data = await fetchFolderPreviewData(
        folder.subfolders.map((s: any) => s.id),
        request,
        sessionId,
      )
      subfolderPreviews = data.previews as Map<string, unknown[]>
      subfolderItemCounts = data.itemCounts
    } catch (err) {
      logError('[GET /api/folders/[id]] subfolder preview failed:', err)
    }
    // 1.5.9: recursive byte totals per subfolder, mirrored from
    // GET /api/folders. Soft-fails to an empty map so a slow query
    // doesn't block the folder page itself.
    let folderSizes = new Map<string, bigint>()
    try {
      folderSizes = await computeFolderSizesByProject(folder.projectId)
    } catch (err) {
      logError('[GET /api/folders/[id]] folder-size compute failed:', err)
    }

    const subfoldersWithPreviews = folder.subfolders.map((s: any) => ({
      ...s,
      previewItems: subfolderPreviews.get(s.id) ?? [],
      itemCount:
        subfolderItemCounts.get(s.id) ??
        (s._count?.subfolders ?? 0) + (s._count?.videos ?? 0),
      totalSize: (folderSizes.get(s.id) ?? BigInt(0)).toString(),
    }))

    const safeFolder = {
      ...folder,
      videos: videosWithExtras,
      subfolders: subfoldersWithPreviews,
    }
    return NextResponse.json({ folder: safeFolder, breadcrumb })
  } catch (error) {
    logError('[GET /api/folders/[id]] failed:', error)
    // Surface the real error in the response body during 1.0.6
    // rollout — the migration that adds Video.createdById may not
    // be applied yet on the user's DB, and a generic 500 makes that
    // impossible to diagnose from the browser.
    const message =
      error instanceof Error ? error.message : 'Failed to load folder'
    return NextResponse.json(
      { error: 'Failed to load folder', detail: message },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/folders/[id]
 *
 * Rename a folder, move it to a different parent, or update its
 * share settings (authMode / sharePassword). All fields optional —
 * the server applies only what's present in the body. Cycle
 * detection makes it impossible to move a folder into its own
 * descendant.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many requests. Please slow down.',
  }, 'admin-folders-update')
  if (rl) return rl

  const { id } = await params
  const parsed = await safeParseBody(request)
  if (!parsed.success) return parsed.response
  const validation = updateFolderSchema.safeParse(parsed.data)
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: validation.error.format() },
      { status: 400 },
    )
  }
  const data = validation.data

  try {
    const existing = await prisma.folder.findUnique({
      where: { id },
      select: { id: true, projectId: true, parentFolderId: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    // Validate parentFolderId change.
    if ('parentFolderId' in data) {
      const newParent = data.parentFolderId ?? null
      if (newParent) {
        const parent = await prisma.folder.findUnique({
          where: { id: newParent },
          select: { id: true, projectId: true },
        })
        if (!parent) {
          return NextResponse.json(
            { error: 'Parent folder not found' },
            { status: 404 },
          )
        }
        if (parent.projectId !== existing.projectId) {
          return NextResponse.json(
            { error: 'Cannot move folder across projects' },
            { status: 400 },
          )
        }
      }
      if (await wouldCreateFolderCycle(id, newParent)) {
        return NextResponse.json(
          { error: 'Cannot move a folder into its own descendant' },
          { status: 400 },
        )
      }
    }

    // Compose the update payload — only include keys that were
    // actually provided so Prisma doesn't wipe fields by accident.
    const updateData: any = {}
    if (typeof data.name === 'string') updateData.name = data.name.trim()
    if ('parentFolderId' in data) updateData.parentFolderId = data.parentFolderId ?? null
    if (data.authMode) {
      // For 1.0.6 we only ship NONE + PASSWORD on folder shares. The
      // schema allows OTP / BOTH for forward compatibility but the
      // public share page rejects them with a clear message.
      updateData.authMode = data.authMode
    }
    if ('sharePassword' in data) {
      // Store the share password encrypted (same scheme the project
      // model uses) so a DB leak doesn't expose plaintext credentials.
      updateData.sharePassword = data.sharePassword
        ? encrypt(data.sharePassword)
        : null
    }
    // 1.4.x+: optional share-link expiration. ISO datetime string =
    // set expiry. null = clear (link never expires).
    if ('shareExpiresAt' in data) {
      updateData.shareExpiresAt = data.shareExpiresAt
        ? new Date(data.shareExpiresAt)
        : null
    }

    const folder = await prisma.folder.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { subfolders: true, videos: true } },
      },
    })
    return NextResponse.json(folder)
  } catch (error) {
    logError('[PATCH /api/folders/[id]] failed:', error)
    return NextResponse.json(
      { error: 'Failed to update folder' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/folders/[id]
 *
 * Remove a folder. Subfolders cascade (gone). Videos inside the
 * folder are preserved — their folderId is set to null (so they pop
 * back up at the project root) — that's the database FK rule we set
 * in the migration. The caller doesn't have to do anything special
 * to inherit that behaviour.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'admin-folders-delete')
  if (rl) return rl

  const { id } = await params
  const permanent =
    new URL(request.url).searchParams.get('permanent') === '1'

  try {
    const existing = await prisma.folder.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    // 1.0.8+: soft-delete by default. Cascade the soft-delete to
    // every descendant folder + every video inside any of those
    // folders so the whole subtree lands in Trash atomically and a
    // restore lifts it back together. Hard-delete (`?permanent=1`)
    // keeps the legacy cascade behaviour for the Trash UI.
    if (!permanent) {
      // Collect the folder + all descendants in a single recursive
      // pass via a CTE-style walk.
      const descendantIds = new Set<string>([id])
      let frontier: string[] = [id]
      while (frontier.length > 0) {
        const children = await prisma.folder.findMany({
          where: { parentFolderId: { in: frontier } },
          select: { id: true },
        })
        frontier = []
        for (const c of children) {
          if (!descendantIds.has(c.id)) {
            descendantIds.add(c.id)
            frontier.push(c.id)
          }
        }
      }

      // 1.2.1+: short-circuit for empty folders. If neither the
      // folder itself nor any descendant holds a single video, the
      // whole subtree is just empty containers — there's nothing
      // worth recovering, so we skip Trash and delete the folders
      // outright. The DB cascade drops descendant folder rows along
      // with `id`.
      const videoCountInSubtree = await prisma.video.count({
        where: { folderId: { in: Array.from(descendantIds) } },
      })
      if (videoCountInSubtree === 0) {
        await prisma.folder.delete({ where: { id } })
        return NextResponse.json({ success: true, soft: false, wasEmpty: true })
      }

      const now = new Date()
      await prisma.$transaction([
        prisma.folder.updateMany({
          where: { id: { in: Array.from(descendantIds) } },
          data: { deletedAt: now } as any,
        }),
        prisma.video.updateMany({
          where: { folderId: { in: Array.from(descendantIds) } },
          data: { deletedAt: now } as any,
        }),
      ])
      return NextResponse.json({ success: true, soft: true })
    }

    await prisma.folder.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('[DELETE /api/folders/[id]] failed:', error)
    return NextResponse.json(
      { error: 'Failed to delete folder' },
      { status: 500 },
    )
  }
}
