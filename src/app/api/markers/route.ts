import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { getPrimaryRecipient } from '@/lib/recipients'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.1.0+: Premiere-style timeline markers.
 *
 * GET  /api/markers?projectId=xxx[&videoId=yyy]  — list markers
 * POST /api/markers                              — create a marker
 *
 * Auth mirrors the comments API: dual admin/share access via
 * `verifyProjectAccess` (+ the `comment` permission for writes). Markers
 * are NOT the timeline comment pins — they're lightweight colored flags
 * you drop to navigate a video version.
 */

const ALLOWED_COLORS = ['red', 'orange', 'green', 'blue'] as const
type MarkerColor = (typeof ALLOWED_COLORS)[number]
const MAX_LABEL_LEN = 200

function shapeMarker(m: any, viewerSessionId: string | null, isAdmin: boolean) {
  return {
    id: m.id,
    videoId: m.videoId,
    videoVersion: m.videoVersion ?? null,
    timestampMs: m.timestampMs,
    color: m.color,
    label: m.label ?? null,
    authorName: m.authorName ?? null,
    isInternal: m.isInternal,
    createdAt: m.createdAt,
    // Whether the current viewer is allowed to delete this marker.
    // Admins can delete any; a client can delete only its own (the
    // browser session that created it).
    mine: isAdmin || (!!m.editorSessionId && m.editorSessionId === viewerSessionId),
  }
}

export async function GET(request: NextRequest) {
  const rl = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests. Please slow down.' },
    'markers-read',
  )
  if (rl) return rl

  try {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId') ?? ''
    const videoId = searchParams.get('videoId') ?? ''

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, sharePassword: true, authMode: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const accessCheck = await verifyProjectAccess(
      request,
      project.id,
      project.sharePassword,
      project.authMode,
    )
    if (!accessCheck.authorized) {
      return accessCheck.errorResponse || NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
    if (accessCheck.isGuest) return NextResponse.json([])

    const authContext = await getAuthContext(request)
    const browserId = (request.headers.get('x-framecomment-client-id') || '').trim()
    const viewerSessionId = accessCheck.isAdmin
      ? `admin:${authContext.user?.id || ''}`
      : browserId
        ? `client:${browserId}`
        : (accessCheck as any).shareTokenSessionId || null

    const markers = await (prisma as any).marker.findMany({
      where: { projectId: project.id, ...(videoId ? { videoId } : {}) },
      orderBy: { timestampMs: 'asc' },
    })

    return NextResponse.json(
      markers.map((m: any) => shapeMarker(m, viewerSessionId, !!accessCheck.isAdmin)),
    )
  } catch (error) {
    logError('Error fetching markers:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const rl = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many markers. Please slow down.' },
    'markers-create',
  )
  if (rl) return rl

  try {
    const authContext = await getAuthContext(request)
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const projectId = String(body.projectId || '')
    const videoId = String(body.videoId || '')
    const timestampMs = Number(body.timestampMs)
    const color: MarkerColor = ALLOWED_COLORS.includes(body.color) ? body.color : 'blue'
    let label: string | null =
      typeof body.label === 'string' ? body.label.trim().slice(0, MAX_LABEL_LEN) : null
    if (label === '') label = null
    const isInternal = !!body.isInternal
    const authorName =
      typeof body.authorName === 'string' ? body.authorName.trim().slice(0, 120) || null : null

    if (!projectId || !videoId || !Number.isFinite(timestampMs) || timestampMs < 0) {
      return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 })
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, sharePassword: true, authMode: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const accessCheck = await verifyProjectAccess(
      request,
      project.id,
      project.sharePassword,
      project.authMode,
      { allowGuest: false, requiredPermission: 'comment' },
    )
    if (!accessCheck.authorized) {
      return accessCheck.errorResponse || NextResponse.json({ error: 'Unable to process request' }, { status: 400 })
    }

    const sessionId = accessCheck.shareTokenSessionId
    if (!sessionId) {
      return NextResponse.json({ error: 'Unable to process request' }, { status: 400 })
    }
    const clientBrowserId = (request.headers.get('x-framecomment-client-id') || '').trim()
    const effectiveSessionId =
      !authContext.user && clientBrowserId.length > 0 ? `client:${clientBrowserId}` : sessionId

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, projectId: true, version: true },
    })
    if (!video || video.projectId !== projectId) {
      return NextResponse.json({ error: 'Video does not belong to this project' }, { status: 400 })
    }
    const finalVideoVersion =
      (typeof body.videoVersion === 'number' ? body.videoVersion : undefined) || video.version || null

    // Fallback display name for client-side markers (mirrors comments).
    let finalAuthorName = authorName
    if (!finalAuthorName && !authContext.user) {
      const primaryRecipient = await getPrimaryRecipient(projectId)
      finalAuthorName = primaryRecipient?.name || null
    }

    const marker = await (prisma as any).marker.create({
      data: {
        projectId,
        videoId,
        videoVersion: finalVideoVersion,
        timestampMs: Math.round(timestampMs),
        color,
        label,
        authorName: finalAuthorName,
        isInternal,
        userId: authContext.user?.id || null,
        editorSessionId: authContext.user ? null : effectiveSessionId,
      },
    })

    const viewerSessionId = authContext.user ? `admin:${authContext.user.id}` : effectiveSessionId
    return NextResponse.json(shapeMarker(marker, viewerSessionId, !!authContext.user), { status: 201 })
  } catch (error) {
    logError('Error creating marker:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
