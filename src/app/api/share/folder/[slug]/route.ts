import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  getCurrentUserFromRequest,
  getShareContext,
  signShareToken,
} from '@/lib/auth'
import { getClientIpAddress } from '@/lib/utils'
import { getShareTokenTtlSeconds } from '@/lib/settings'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'
import { generateVideoAccessToken } from '@/lib/video-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/share/folder/[slug]
 *
 * Public folder share endpoint. Mirrors `/api/share/[token]` but
 * scopes to a single folder subtree rather than a whole project:
 *
 *  - NONE      → open access; we issue a fresh share token bound to
 *                this folder and return the folder's contents.
 *  - PASSWORD  → if the caller already presents a valid share token
 *                bound to this folder we return contents; otherwise
 *                we reply 401 with `authMode` so the share page
 *                shows the password challenge. The verify endpoint
 *                (POST /api/share/folder/[slug]/verify) signs the
 *                token after a successful password check.
 *  - OTP / BOTH→ rejected for now with a clear message. Folder OTP
 *                shares require additional plumbing (per-folder
 *                recipients OR explicit inheritance from the parent
 *                project), shipping in a follow-up release.
 *
 * Response shape mirrors the project share endpoint so the share-
 * page client can be written symmetrically.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params

    // Light rate limit so a leaked URL can't be brute-forced via
    // metadata probes. The /verify route has a much stricter limit.
    const rl = await rateLimit(request, {
      windowMs: 15 * 60 * 1000,
      maxRequests: 300,
      message: 'Too many requests. Please try again later.',
    }, `share-folder-access:${slug}`)
    if (rl) return rl

    // Cheap lookup first so an invalid slug short-circuits before
    // we go fetching contents.
    const folderMeta = await prisma.folder.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        projectId: true,
        parentFolderId: true,
        sharePassword: true,
        authMode: true,
        project: { select: { title: true, companyName: true, slug: true } },
      },
    })

    if (!folderMeta) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    if (folderMeta.authMode === 'OTP' || folderMeta.authMode === 'BOTH') {
      // 1.0.6 ships NONE + PASSWORD only on folder shares. Tell the
      // client clearly rather than silently failing.
      return NextResponse.json(
        {
          error:
            'Folder OTP/BOTH auth is not yet supported. Switch the folder to NONE or PASSWORD in admin.',
          authMode: folderMeta.authMode,
        },
        { status: 400 },
      )
    }

    // Admin override: a logged-in studio admin can always view any
    // folder share, no challenge needed.
    const currentUser = await getCurrentUserFromRequest(request)
    const isAdmin = currentUser?.role === 'ADMIN'
    const shareContext = await getShareContext(request)

    let authorized = false
    let sessionId: string | undefined

    if (isAdmin) {
      authorized = true
      sessionId = `admin:${currentUser.id}`
    } else if (folderMeta.authMode === 'NONE') {
      authorized = true
      // Deterministic per-IP session id so click-to-edit on a comment
      // can match the same session across the page (mirrors how the
      // project NONE flow derives sessions — see auth.ts).
      sessionId = shareContext?.sessionId
        || `none:folder:${folderMeta.id}:${getClientIpAddress(request)}`
    } else if (folderMeta.authMode === 'PASSWORD') {
      // Only authorize when an incoming share token says it's scoped
      // to THIS folder. Mismatched project / folder tokens are
      // refused.
      if (
        shareContext &&
        shareContext.folderId === folderMeta.id &&
        shareContext.projectId === folderMeta.projectId
      ) {
        authorized = true
        sessionId = shareContext.sessionId
      }
    }

    if (!authorized) {
      // The share page reads `authMode` to render the right challenge.
      return NextResponse.json(
        {
          error: 'Authentication required',
          authMode: folderMeta.authMode,
          folder: {
            id: folderMeta.id,
            name: folderMeta.name,
            projectId: folderMeta.projectId,
            projectTitle: folderMeta.project.title,
          },
        },
        { status: 401 },
      )
    }

    // Fetch contents (direct subfolders + direct videos) — we
    // intentionally do not pre-flatten the tree; deeper navigation
    // is handled by additional GETs from the client as it drills down.
    const [subfolders, videos] = await Promise.all([
      prisma.folder.findMany({
        where: { parentFolderId: folderMeta.id },
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { subfolders: true, videos: true } },
        },
      }),
      prisma.video.findMany({
        where: { folderId: folderMeta.id },
        orderBy: [{ name: 'asc' }, { version: 'desc' }],
        select: {
          id: true,
          name: true,
          version: true,
          versionLabel: true,
          duration: true,
          width: true,
          height: true,
          fps: true,
          status: true,
          approved: true,
          thumbnailPath: true,
          preview720Path: true,
          preview1080Path: true,
          preview2160Path: true,
          storyboardPath: true,
          createdAt: true,
          _count: { select: { comments: true } },
        },
      }),
    ])

    // Resolve uploader info per video (best effort — same defensive
    // shape as the admin folder GET; falls back silently for legacy
    // rows that pre-date the createdById column).
    const uploadersByVideoId = new Map<string, any>()
    try {
      const videoIds = videos.map((v) => v.id)
      if (videoIds.length > 0) {
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
      logError('[GET /api/share/folder/[slug]] uploader lookup skipped:', err)
    }

    // Mint per-video thumbnail tokens (1.0.6+) so the public share
    // grid renders real first-frame previews instead of just the
    // Film icon. Each token is signed with the SAME sessionId we
    // use for issuing the folder share token below, so an attacker
    // who steals one URL still can't pivot to another video.
    // Every authorized branch above sets `sessionId`; tighten the
    // type for the helper call below.
    const thumbSessionId = sessionId as string
    const videosWithThumb = await Promise.all(
      videos.map(async (v: any) => {
        let thumbnailUrl: string | null = null
        if (v.thumbnailPath) {
          try {
            const token = await generateVideoAccessToken(
              v.id,
              folderMeta.projectId,
              'thumbnail',
              request,
              thumbSessionId,
            )
            thumbnailUrl = `/api/content/${token}`
          } catch (err) {
            logError(
              '[GET /api/share/folder/[slug]] thumbnail token failed:',
              err,
            )
          }
        }

        // Hover-scrub assets (1.0.6+). Sprite-sheet first, low-res
        // preview as fallback. Same logic as the admin folder GET.
        let storyboardUrl: string | null = null
        if (v.storyboardPath) {
          try {
            const token = await generateVideoAccessToken(
              v.id,
              folderMeta.projectId,
              'storyboard',
              request,
              thumbSessionId,
            )
            storyboardUrl = `/api/content/${token}`
          } catch (err) {
            logError('[GET /api/share/folder/[slug]] storyboard token failed:', err)
          }
        }
        let previewUrl: string | null = null
        const previewQuality = v.preview720Path
          ? '720p'
          : v.preview1080Path
          ? '1080p'
          : v.preview2160Path
          ? '2160p'
          : 'original'
        try {
          const token = await generateVideoAccessToken(
            v.id,
            folderMeta.projectId,
            previewQuality,
            request,
            thumbSessionId,
          )
          previewUrl = `/api/content/${token}`
        } catch (err) {
          logError('[GET /api/share/folder/[slug]] preview token failed:', err)
        }

        return {
          ...v,
          thumbnailUrl,
          storyboardUrl,
          previewUrl,
          commentCount: v._count?.comments ?? 0,
          createdBy: uploadersByVideoId.get(v.id) ?? null,
        }
      }),
    )

    // Issue a fresh folder-scoped share token when one isn't already
    // attached (matches what /api/share/[token] does for project NONE).
    let issuedShareToken: string | undefined
    if (!shareContext && !isAdmin) {
      const ttl = await getShareTokenTtlSeconds()
      issuedShareToken = signShareToken({
        shareId: slug,
        projectId: folderMeta.projectId,
        folderId: folderMeta.id,
        permissions: ['view', 'comment', 'download'],
        guest: false,
        sessionId,
        authMode: folderMeta.authMode,
        ttlSeconds: ttl,
      })
    }

    return NextResponse.json({
      folder: {
        id: folderMeta.id,
        name: folderMeta.name,
        slug,
        projectId: folderMeta.projectId,
        parentFolderId: folderMeta.parentFolderId,
        projectTitle: folderMeta.project.title,
        projectSlug: folderMeta.project.slug,
        companyName: folderMeta.project.companyName,
        authMode: folderMeta.authMode,
      },
      subfolders: subfolders.map((f) => ({
        id: f.id,
        slug: f.slug,
        name: f.name,
        itemCount: f._count.subfolders + f._count.videos,
      })),
      videos: videosWithThumb,
      isAdmin,
      sessionId,
      shareToken: issuedShareToken,
    })
  } catch (error) {
    logError('[GET /api/share/folder/[slug]] failed:', error)
    return NextResponse.json(
      { error: 'Failed to load folder' },
      { status: 500 },
    )
  }
}
