import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShareContext } from '@/lib/auth'
import { logError } from '@/lib/logging'
import { generateVideoAccessToken } from '@/lib/video-access'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const shareMessages = messages?.share
  const url = new URL(request.url)
  const videoId = url.searchParams.get('videoId')
  const quality = url.searchParams.get('quality') || '720p'

  if (!videoId) {
    return NextResponse.json({ error: shareMessages?.videoIdRequired || 'videoId is required' }, { status: 400 })
  }

  const shareContext = await getShareContext(request)
  if (!shareContext) {
    return NextResponse.json({ error: shareMessages?.unauthorized || 'Unauthorized' }, { status: 401 })
  }

  const project = await prisma.project.findUnique({
    where: { id: shareContext.projectId },
    select: { id: true, slug: true, allowAssetDownload: true },
  })

  if (!project || project.slug !== token) {
    return NextResponse.json({ error: shareMessages?.accessDenied || 'Access denied' }, { status: 403 })
  }

  // 1.9.4+ Phase A: cast via `as any` because preview480Path was
  // added to the schema but the Prisma client types haven't been
  // regenerated yet (`npx prisma migrate dev` does that at the
  // same time it runs the migration). Runtime is fine.
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectId: true,
      approved: true,
      thumbnailPath: true,
      preview480Path: true,
      preview720Path: true,
      preview1080Path: true,
      preview2160Path: true,
    } as any,
  }) as any

  if (!video || video.projectId !== project.id) {
    return NextResponse.json({ error: shareMessages?.videoNotFound || 'Video not found' }, { status: 404 })
  }

  // 3.3.x: the original source is available once the video is approved
  // OR when the project opts into client downloads (`allowAssetDownload`)
  // — the latter lets a client download the source of a single-video
  // share before approval. Without `allowAssetDownload` the original
  // stays gated behind approval as before.
  if (quality === 'original' && !video.approved && !project.allowAssetDownload) {
    return NextResponse.json({ error: shareMessages?.originalQualityUnavailable || 'Original quality unavailable' }, { status: 403 })
  }

  // 1.9.4+ Phase A: return an empty token when the caller asks
  // for a quality tier that doesn't exist yet. The client mirrors
  // this back as `streamUrl<tier>: ''`, so the player's "highest
  // available" picker (and its quality label) stays honest while
  // the worker is still producing higher tiers.
  if (quality === '480p' && !video.preview480Path) {
    return NextResponse.json({ token: '' })
  }
  if (quality === '720p' && !video.preview720Path) {
    return NextResponse.json({ token: '' })
  }
  if (quality === '1080p' && !video.preview1080Path) {
    return NextResponse.json({ token: '' })
  }
  if (quality === '2160p' && !video.preview2160Path) {
    return NextResponse.json({ token: '' })
  }

  const sessionId = shareContext.sessionId || `share:${project.id}:${token}`

  try {
    const tokenValue = await generateVideoAccessToken(
      video.id,
      project.id,
      quality,
      request,
      sessionId
    )

    return NextResponse.json({ token: tokenValue })
  } catch (error) {
    logError(`[SHARE] Failed to generate video token (videoId=${videoId}, quality=${quality})`, error)
    return NextResponse.json({ error: shareMessages?.failedToGenerateToken || 'Failed to generate token' }, { status: 500 })
  }
}
