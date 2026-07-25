import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiOwner } from '@/lib/auth'
import { verifyPassword } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import { initiateTransfer } from '@/lib/ownership'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.3.0+: initiate an ownership transfer. OWNER only.
 *
 * Requires the acting owner to re-enter their password — an interim second
 * factor so a hijacked session alone can't hand ownership away. (An email
 * approval step is intended to layer on top once email is available.) The
 * recipient becomes the active owner immediately, but the caller keeps a
 * 30-day reversal window (see /api/users/ownership/reverse).
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiOwner(request)
  if (auth instanceof Response) return auth

  const rl = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'ownership-transfer',
  )
  if (rl) return rl

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const toUserId = typeof body?.toUserId === 'string' ? body.toUserId : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!toUserId) {
    return NextResponse.json({ error: 'Please choose who to transfer ownership to.' }, { status: 400 })
  }
  if (!password) {
    return NextResponse.json({ error: 'Your password is required to confirm this transfer.' }, { status: 400 })
  }

  try {
    // Re-authenticate the acting owner.
    const me = await prisma.user.findUnique({ where: { id: auth.id }, select: { password: true } })
    if (!me || !(await verifyPassword(password, me.password))) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 })
    }

    const result = await initiateTransfer(auth.id, toUserId)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('[ownership/transfer] failed:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
