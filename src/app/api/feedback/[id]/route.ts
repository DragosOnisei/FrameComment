import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prismaPrivileged } from '@/lib/db'
import { requirePlatformAdmin } from '@/lib/platform'
import { safeParseBody } from '@/lib/validation'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  status: z.enum(['NEW', 'READ', 'DONE']),
})

/**
 * 7.3.0 — the founder moves a report along. Founder only: a sender can write
 * feedback but has no business marking their own report handled.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin(request)
  if (auth instanceof Response) return auth

  const { id } = await params
  const parsed = await safeParseBody(request)
  if (!parsed.success) return parsed.response
  const validation = patchSchema.safeParse(parsed.data)
  if (!validation.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  try {
    await prismaPrivileged.feedback.update({
      where: { id },
      data: { status: validation.data.status },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    logError('[feedback] status change failed:', error, id)
    return NextResponse.json({ error: 'Could not update' }, { status: 500 })
  }
}
