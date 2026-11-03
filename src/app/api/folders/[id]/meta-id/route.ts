import { NextRequest, NextResponse } from 'next/server'
import { currentOrgId } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { logError } from '@/lib/logging'
import { generateMetaId, removeMetaId } from '@/lib/meta-id'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.20.0: a folder's Meta ID (src/lib/meta-id.ts).
 *
 * POST   → give the folder the company's next "FC<n>" (or answer with the
 *          one it already has). 409 when a folder above or below it
 *          already carries one — a video can only belong to one ad.
 * DELETE → take it away. The number is never handed out again.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiAdmin(request)
  if (user instanceof Response) return user
  const { id } = await params
  try {
    const organizationId = (user as any).organizationId ?? currentOrgId()
    const result = await generateMetaId(id, organizationId)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ metaNumber: result.metaNumber, created: result.created })
  } catch (error) {
    logError('[POST /api/folders/[id]/meta-id] failed:', error)
    return NextResponse.json({ error: 'Could not generate a Meta ID' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiAdmin(request)
  if (user instanceof Response) return user
  const { id } = await params
  try {
    const organizationId = (user as any).organizationId ?? currentOrgId()
    const removed = await removeMetaId(id, organizationId)
    return NextResponse.json({ removed })
  } catch (error) {
    logError('[DELETE /api/folders/[id]/meta-id] failed:', error)
    return NextResponse.json({ error: 'Could not remove the Meta ID' }, { status: 500 })
  }
}
