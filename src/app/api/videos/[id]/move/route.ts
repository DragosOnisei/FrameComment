import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { safeParseBody } from '@/lib/validation'
import { z } from 'zod'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const moveVideoSchema = z.object({
  // null = move to project root (no folder). cuid = drop into that folder.
  folderId: z.string().regex(/^c[a-z0-9]{24}$/, 'Invalid folder id').nullable(),
})

/**
 * POST /api/videos/[id]/move
 *
 * Drop a video into a folder (or back to the project root). The
 * folder must live in the same project as the video — moving across
 * projects is intentionally not supported here. Admin-only.
 *
 * Body: `{ folderId: string | null }`
 * Returns: the updated video row.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const rl = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many requests. Please slow down.',
  }, 'admin-videos-move')
  if (rl) return rl

  const { id } = await params
  const parsed = await safeParseBody(request)
  if (!parsed.success) return parsed.response
  const validation = moveVideoSchema.safeParse(parsed.data)
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: validation.error.format() },
      { status: 400 },
    )
  }
  const { folderId } = validation.data

  try {
    const video = await prisma.video.findUnique({
      where: { id },
      select: { id: true, projectId: true },
    })
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 })
    }

    if (folderId) {
      const folder = await prisma.folder.findUnique({
        where: { id: folderId },
        select: { id: true, projectId: true },
      })
      if (!folder) {
        return NextResponse.json(
          { error: 'Target folder not found' },
          { status: 404 },
        )
      }
      if (folder.projectId !== video.projectId) {
        return NextResponse.json(
          { error: 'Cannot move video across projects' },
          { status: 400 },
        )
      }
    }

    const updated = await prisma.video.update({
      where: { id },
      data: { folderId: folderId ?? null },
      select: { id: true, projectId: true, folderId: true, name: true },
    })
    return NextResponse.json(updated)
  } catch (error) {
    logError('[POST /api/videos/[id]/move] failed:', error)
    return NextResponse.json(
      { error: 'Failed to move video' },
      { status: 500 },
    )
  }
}
