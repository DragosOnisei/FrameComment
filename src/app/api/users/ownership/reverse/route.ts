import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiOwner } from '@/lib/auth'
import { verifyPassword } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import { reverseTransfer } from '@/lib/ownership'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 4.3.0+: reverse an in-flight ownership transfer — the anti-hijack rescue.
 *
 * Only the previous ("grace") owner may call this, and only inside the 30-day
 * window (enforced in reverseTransfer). Requires password re-authentication.
 * The recipient is demoted back to their previous role and the caller keeps
 * ownership. During the grace window the new owner cannot remove/demote the
 * grace owner, so a hijacker who transferred ownership away can always be
 * undone by the real owner.
 */
export async function POST(request: NextRequest) {
  const auth = await requireApiOwner(request)
  if (auth instanceof Response) return auth

  const rl = await rateLimit(
    request,
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'ownership-reverse',
  )
  if (rl) return rl

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!password) {
    return NextResponse.json({ error: 'Your password is required to confirm this.' }, { status: 400 })
  }

  try {
    const me = await prisma.user.findUnique({ where: { id: auth.id }, select: { password: true } })
    if (!me || !(await verifyPassword(password, me.password))) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 })
    }

    const result = await reverseTransfer(auth.id)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('[ownership/reverse] failed:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
