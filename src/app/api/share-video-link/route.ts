import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { signVideoShareName } from '@/lib/share-video-sig'
import { safeParseBody } from '@/lib/validation'
import { getAppUrl } from '@/lib/url'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  projectId: z.string().min(1),
  videoName: z.string().min(1).max(500),
  folderId: z.string().min(1).optional(),
})

/**
 * 1.2.0: Admin-only endpoint. Given a project + video name, returns a
 * share URL that is cryptographically scoped to that single video so a
 * client opening the link can only see that video and its comments —
 * not the other videos in the project / folder.
 *
 * The URL shape is /share/{slug}?v={videoName}&sig={hmac}. The share
 * GET endpoint verifies the signature and filters the project data
 * accordingly.
 */
export async function POST(request: NextRequest) {
  try {
    // Admin-only — clients should never mint a single-video share URL
    // for themselves.
    const adminCheck = await requireApiAdmin(request)
    if (adminCheck instanceof Response) return adminCheck

    const parsed = await safeParseBody(request)
    if (!parsed.success) return parsed.response
    const validation = bodySchema.safeParse(parsed.data)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error.format() },
        { status: 400 },
      )
    }
    const { projectId, videoName, folderId } = validation.data

    // Look up the project slug (the public URL segment) so the signed
    // link uses the same /share/{slug} structure clients already know.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { slug: true },
    })
    if (!project?.slug) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const sig = signVideoShareName(project.slug, videoName)
    const params = new URLSearchParams({
      // `video` is the existing pre-select param — we keep using it so
      // the share page lands on the correct version on first paint.
      video: videoName,
      v: videoName, // signed param name kept short
      sig,
    })
    if (folderId) params.set('folderId', folderId)

    // 2.2.1+: use the configured `appDomain` from Settings → Branding
    // when available so the copied link uses the studio's public
    // domain (e.g. `https://framecomment.com/...`) instead of whatever
    // host header the request arrived with. The pre-2.2.1 code built
    // the URL from `request.url` directly, which on TrueNAS behind
    // the built-in reverse proxy resolves to `http://localhost:4321`
    // — so admins ended up sharing a link only reachable from the
    // server itself. `getAppUrl` checks the DB-level setting first
    // and falls back to the request headers (x-forwarded-host /
    // host) so external deployments without `appDomain` set still
    // get a useful URL.
    const rawBaseUrl = await getAppUrl(request)
    // Strip any trailing slash from the admin-entered domain so the
    // final URL has exactly one slash before `/share/...` even if the
    // user pasted `https://framecomment.com/` (which the input
    // explicitly allows).
    const origin = rawBaseUrl.replace(/\/+$/, '')
    const shareUrl = `${origin}/share/${project.slug}?${params.toString()}`

    return NextResponse.json({ url: shareUrl, sig })
  } catch (error) {
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
