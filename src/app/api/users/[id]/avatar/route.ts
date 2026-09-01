import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 7.4.1 — one person's avatar, as an image rather than as text.
 *
 * WHY THIS ROUTE EXISTS AT ALL
 *
 * Avatars are stored as base64 data URIs on the User row, and the one on this
 * deployment is 27KB. Putting that on every comment's author would have meant
 * 27KB per comment: a thread of fifty from one person is 1.3MB of JSON, re-sent
 * on every refetch — and the comment list refetches after every paste, resolve
 * and delete. Behind a URL the browser fetches it once and caches it, however
 * many notes that person left.
 *
 * Read through the ARMED client on purpose. RLS then answers the "may this
 * viewer see this person" question for free: a user id from another
 * organisation simply matches no row, so this cannot become a way to read
 * someone else's team by guessing ids.
 *
 * Not reachable from a plain `<img src>`, because this app authenticates with a
 * bearer token held in memory and a native image request carries no headers —
 * the same wall ProjectCoverImage documents. The caller fetches it and hands
 * the bytes to the tag as a blob; see UserAvatar.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiAuth(request)
  if (auth instanceof Response) return auth

  const { id } = await params

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { avatarUrl: true },
    })
    if (!user?.avatarUrl) {
      return NextResponse.json({ error: 'No avatar' }, { status: 404 })
    }

    // `data:image/jpeg;base64,<payload>` — anything else is a stored value this
    // route does not know how to serve, and guessing would send the browser
    // bytes it cannot draw.
    const match = /^data:([^;,]+);base64,(.+)$/.exec(user.avatarUrl)
    if (!match) {
      return NextResponse.json({ error: 'Unsupported avatar format' }, { status: 415 })
    }
    const [, contentType, base64] = match
    const bytes = Buffer.from(base64, 'base64')

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.length),
        // Private: this is one person's face behind a session check, so it must
        // not sit in a shared proxy. An hour is long enough that a busy list
        // never re-fetches it and short enough that changing your photo shows
        // up the same session.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error) {
    logError('[users] avatar read failed:', error, id)
    return NextResponse.json({ error: 'Could not read avatar' }, { status: 500 })
  }
}
