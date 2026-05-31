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
import { fetchFolderPreviewData } from '@/lib/folder-previews'

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
    // 1.4.x+: optional `?root=<slug>` query param. The client passes
    // this when navigating into a subfolder of the originally shared
    // folder so we can return the in-scope breadcrumb (root → ... →
    // current). The page uses it to render the breadcrumb without
    // leaking a navigable link to the project share. If `root` is
    // missing OR is the same as `slug`, the current folder IS the
    // root and the breadcrumb is just one entry.
    const rootSlug = request.nextUrl.searchParams.get('root')?.trim() || null

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
    //
    // NOTE: cast to `any` because the folder schema's `shareExpiresAt`
    // field (1.4.x+) is only present in the Prisma client AFTER
    // `prisma generate` runs against the migrated DB. Doing the cast
    // at the awaited-call boundary keeps consumer code working in both
    // the pre-migrate (stale client) and post-migrate (fresh client)
    // states.
    const folderMeta = (await prisma.folder.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        projectId: true,
        parentFolderId: true,
        sharePassword: true,
        authMode: true,
        // 1.4.x+: optional share-link expiration timestamp.
        shareExpiresAt: true,
        project: {
          select: {
            title: true,
            companyName: true,
            slug: true,
            // 1.4.x+: expose the client-download flag so the public
            // share page can show/hide the "Download All" button.
            allowAssetDownload: true,
          },
        },
      } as any,
    })) as any

    if (!folderMeta) {
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
    }

    // 1.4.x+: hard-reject expired folder share links. Admin override
    // below keeps admins able to inspect the folder regardless; for
    // anonymous clients we return 410 Gone with the expiration time
    // so the page renders a clean "link expired" notice.
    if (
      (folderMeta as any).shareExpiresAt &&
      (folderMeta as any).shareExpiresAt.getTime() < Date.now()
    ) {
      const probe = await getCurrentUserFromRequest(request)
      if (probe?.role !== 'ADMIN') {
        return NextResponse.json(
          {
            error: 'This share link has expired.',
            expiredAt: (folderMeta as any).shareExpiresAt.toISOString(),
          },
          { status: 410 },
        )
      }
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
        where: { parentFolderId: folderMeta.id, deletedAt: null } as any,
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { subfolders: true, videos: true } },
        },
      }),
      prisma.video.findMany({
        where: { folderId: folderMeta.id, deletedAt: null } as any,
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
          // 1.9.4+ Phase A: 480p tier is the fastest progressive
          // preview and is preferred for hover-scrub fallback
          // (smaller file → smoother seek).
          preview480Path: true,
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
        // 1.9.4+ Phase A: prefer 480p for hover-scrub fallback —
        // smallest tier, fastest seek when the storyboard sprite
        // isn't ready yet.
        const previewQuality = (v as any).preview480Path
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

    // 1.4.x+: build the IN-SCOPE breadcrumb. Walks parentFolderId from
    // the CURRENT folder up the tree, stopping when we hit the share
    // root (the slug the client passed via `?root=`). Capped at 10
    // levels so a malicious infinite-loop folder couldn't DoS the
    // route. If `root` is missing or equals the current slug, the
    // ancestry is a single entry (the current folder itself).
    //
    // We DO NOT walk above the share root — that's the whole point of
    // folder shares being scoped. The client renders this list as the
    // breadcrumb instead of using `projectTitle`, so the public share
    // never surfaces a link back to the project root.
    type Crumb = { slug: string; name: string }
    const ancestry: Crumb[] = [{ slug, name: folderMeta.name }]
    if (rootSlug && rootSlug !== slug) {
      let cursorId: string | null = folderMeta.parentFolderId
      const safetyLimit = 10
      for (let i = 0; i < safetyLimit && cursorId; i++) {
        const parent = await prisma.folder.findUnique({
          where: { id: cursorId },
          select: { id: true, slug: true, name: true, parentFolderId: true },
        })
        if (!parent) break
        ancestry.unshift({ slug: parent.slug, name: parent.name })
        if (parent.slug === rootSlug) break
        cursorId = parent.parentFolderId
      }
      // If we never reached the declared root, drop everything above
      // the current folder — the supplied root isn't actually an
      // ancestor (defensive against a tampered query param).
      const reachedRoot = ancestry.some((c) => c.slug === rootSlug)
      if (!reachedRoot) {
        ancestry.length = 0
        ancestry.push({ slug, name: folderMeta.name })
      }
    }

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
        // 1.4.x+: drive the "Download All" button in the public folder
        // share UI. Falls back to false so older client builds that
        // don't know about the flag stay safe by default.
        allowAssetDownload: !!folderMeta.project.allowAssetDownload,
        // 1.4.x+: expose the share expiration so the public page can
        // render a countdown banner ("Expires in 5 days"). Sent as
        // ISO string for easy client-side `new Date(...)` parsing.
        shareExpiresAt: (folderMeta as any).shareExpiresAt
          ? (folderMeta as any).shareExpiresAt.toISOString()
          : null,
      },
      subfolders: await (async () => {
        // Mirror the admin folder grid (1.0.7+): mint Frame.io-style
        // preview tiles + corrected item counts for every sub-folder
        // so the public share renders the same large card with a
        // mosaic cover. Failures soft-fall to a plain glyph.
        let previews = new Map<string, unknown[]>()
        let counts = new Map<string, number>()
        try {
          const data = await fetchFolderPreviewData(
            subfolders.map((f) => f.id),
            request,
            thumbSessionId,
          )
          previews = data.previews as Map<string, unknown[]>
          counts = data.itemCounts
        } catch (err) {
          logError('[GET /api/share/folder/[slug]] preview failed:', err)
        }
        return subfolders.map((f) => ({
          id: f.id,
          slug: f.slug,
          name: f.name,
          itemCount:
            counts.get(f.id) ?? f._count.subfolders + f._count.videos,
          previewItems: previews.get(f.id) ?? [],
        }))
      })(),
      videos: videosWithThumb,
      // 1.4.x+: in-scope breadcrumb (root → current). See the walk
      // logic above. The page renders this instead of the old
      // project-title link, so the share is fully scoped to the
      // folder subtree.
      ancestry,
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
