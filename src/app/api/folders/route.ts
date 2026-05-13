import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { createFolderSchema, safeParseBody } from '@/lib/validation'
import { generateUniqueFolderSlug } from '@/lib/folder-helpers'
import { fetchFolderPreviewData } from '@/lib/folder-previews'
import { enrichVideosForAdmin } from '@/lib/folder-video-enrichment'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/folders
 *
 * Create a folder inside a project. Admin-only. When `parentFolderId`
 * is provided the folder lands inside that parent; otherwise it lands
 * at the project root. The server generates a fresh share slug — the
 * caller never picks the URL.
 *
 * Body: `{ projectId, parentFolderId?, name }`
 * Returns: the created folder row.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  // Rate limit: writing a folder is cheap but we still cap it to keep
  // bulk-script abuse off the table.
  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'admin-folders-create')
  if (rl) return rl

  const parsed = await safeParseBody(request)
  if (!parsed.success) return parsed.response
  const validation = createFolderSchema.safeParse(parsed.data)
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: validation.error.format() },
      { status: 400 },
    )
  }
  const { projectId, parentFolderId, name } = validation.data

  try {
    // The parent (when set) must live in the same project — moving a
    // folder across projects is a separate operation we don't support
    // here, and would be a permission-leak vector if we did.
    if (parentFolderId) {
      const parent = await prisma.folder.findUnique({
        where: { id: parentFolderId },
        select: { id: true, projectId: true },
      })
      if (!parent) {
        return NextResponse.json(
          { error: 'Parent folder not found' },
          { status: 404 },
        )
      }
      if (parent.projectId !== projectId) {
        return NextResponse.json(
          { error: 'Parent folder belongs to a different project' },
          { status: 400 },
        )
      }
    }

    // Sanity-check the project exists. We don't return it but we want
    // to avoid creating an orphaned folder with a stale projectId.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const slug = await generateUniqueFolderSlug()
    const folder = await prisma.folder.create({
      data: {
        projectId,
        parentFolderId: parentFolderId || null,
        name: name.trim(),
        slug,
        authMode: 'NONE',
        createdById: authResult.id || null,
      },
      include: {
        _count: { select: { subfolders: true, videos: true } },
      },
    })

    return NextResponse.json(folder, { status: 201 })
  } catch (error) {
    logError('[POST /api/folders] failed:', error)
    return NextResponse.json(
      { error: 'Failed to create folder' },
      { status: 500 },
    )
  }
}

/**
 * GET /api/folders?projectId=...&parentFolderId=...
 *
 * List folders at a given level. Admin-only. Both filters are
 * required to keep responses bounded — clients always ask "what's in
 * THIS level of THIS project" rather than dumping the whole tree.
 *
 * `parentFolderId=root` (literal string) selects folders at the
 * project root; any cuid value selects subfolders of that folder.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult
  const admin = authResult

  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId')
  const parentParam = url.searchParams.get('parentFolderId')

  if (!projectId) {
    return NextResponse.json(
      { error: 'projectId is required' },
      { status: 400 },
    )
  }
  const parentFolderId =
    parentParam && parentParam !== 'root' ? parentParam : null

  try {
    const folders = await prisma.folder.findMany({
      where: { projectId, parentFolderId, deletedAt: null } as any,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { subfolders: true, videos: true } },
      },
    })

    // Frame.io-style folder previews + corrected item counts
    // (1.0.7+). The helper returns both the mosaic tiles and a count
    // that treats a video group (e.g. v1/v2/v3 of the same asset) as
    // a single item, so the "N items" label matches what the user
    // visually sees inside the folder. Failures are soft (logged,
    // treated as no preview / fall back to _count).
    const sessionId = `admin:${admin.id}`
    let previewsByFolder = new Map<string, unknown[]>()
    let itemCountByFolder = new Map<string, number>()
    try {
      const data = await fetchFolderPreviewData(
        folders.map((f) => f.id),
        request,
        sessionId,
      )
      previewsByFolder = data.previews as Map<string, unknown[]>
      itemCountByFolder = data.itemCounts
    } catch (err) {
      logError('[GET /api/folders] preview fetch failed:', err)
    }
    const enriched = folders.map((f) => ({
      ...f,
      previewItems: previewsByFolder.get(f.id) ?? [],
      itemCount:
        itemCountByFolder.get(f.id) ??
        (f._count?.subfolders ?? 0) + (f._count?.videos ?? 0),
    }))

    // 1.0.7+: when the caller is listing the project root we also
    // need to surface any videos that live there (e.g. one that was
    // just moved up out of a top-level folder). For nested levels we
    // keep the legacy array response so existing clients stay happy.
    if (parentFolderId === null) {
      const rootVideos = await prisma.video.findMany({
        where: { projectId, folderId: null, deletedAt: null } as any,
        orderBy: [{ name: 'asc' }, { version: 'desc' }],
        include: { _count: { select: { comments: true } } },
      })
      const enrichedVideos = await enrichVideosForAdmin(
        rootVideos as any[],
        request,
        sessionId,
        'GET /api/folders root videos',
      )
      return NextResponse.json({
        folders: enriched,
        videos: enrichedVideos,
      })
    }

    return NextResponse.json(enriched)
  } catch (error) {
    logError('[GET /api/folders] failed:', error)
    return NextResponse.json(
      { error: 'Failed to list folders' },
      { status: 500 },
    )
  }
}
