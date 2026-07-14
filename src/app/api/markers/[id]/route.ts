import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/lib/auth'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.1.0+: DELETE / PATCH a single marker.
 *
 * Authorization mirrors comment self-edit: admins (authenticated users)
 * may delete/patch any marker; a client may only touch the marker its
 * own browser session created (editorSessionId === client:<browserId>).
 */

const ALLOWED_COLORS = ['red', 'orange', 'green', 'blue']

async function loadAndAuthorize(request: NextRequest, id: string) {
  const authContext = await getAuthContext(request)
  const marker = await (prisma as any).marker.findUnique({ where: { id } })
  if (!marker) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }
  const isAdmin = !!authContext.user
  let authorized = isAdmin
  if (!authorized) {
    const browserId = (request.headers.get('x-framecomment-client-id') || '').trim()
    const viewerSessionId = browserId ? `client:${browserId}` : null
    authorized =
      !!marker.editorSessionId && !!viewerSessionId && marker.editorSessionId === viewerSessionId
  }
  if (!authorized) {
    return { error: NextResponse.json({ error: 'Not authorized' }, { status: 403 }) }
  }
  return { marker }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const res = await loadAndAuthorize(request, id)
    if (res.error) return res.error
    await (prisma as any).marker.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('Error deleting marker:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const res = await loadAndAuthorize(request, id)
    if (res.error) return res.error
    const body = await request.json().catch(() => null)
    const data: any = {}
    if (body && typeof body.color === 'string' && ALLOWED_COLORS.includes(body.color)) {
      data.color = body.color
    }
    if (body && typeof body.label === 'string') {
      const l = body.label.trim().slice(0, 200)
      data.label = l || null
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    const updated = await (prisma as any).marker.update({ where: { id }, data })
    return NextResponse.json({ id: updated.id, color: updated.color, label: updated.label ?? null })
  } catch (error) {
    logError('Error updating marker:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
