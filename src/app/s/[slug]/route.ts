import { NextRequest, NextResponse } from 'next/server'
import { resolveShortLink } from '@/lib/short-link'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
// 2.4.0+: dynamic because the slug is a path param (per-request)
// and we read the DB every call. `force-dynamic` also stops
// Next.js from prerendering an HTML page for /s/<slug>.
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Short-link resolver (2.4.0+).
 *
 * Both `fcmt.io/<slug>` (via middleware rewrite to `/s/<slug>`) and
 * `<appDomain>/s/<slug>` (direct hit, fallback if the short domain
 * is down) land here. We look up the slug in the ShortLink table
 * and 302 the browser to `targetUrl`.
 *
 * No auth — the original URL we redirect to carries its own HMAC
 * signature + expiration, so the slug itself is opaque.
 *
 * Status codes:
 *   - 302 Found    → resolved, redirecting
 *   - 410 Gone     → slug exists but `expiresAt` has passed
 *   - 404 Not Found → unknown slug
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params

  if (!slug || typeof slug !== 'string') {
    return new NextResponse('Bad request', { status: 400 })
  }

  try {
    const link = await resolveShortLink(slug)

    if (!link) {
      return new NextResponse('Short link not found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    if (link.expired) {
      return new NextResponse(
        'This share link has expired. Please ask the sender for a fresh link.',
        {
          status: 410,
          headers: { 'Cache-Control': 'no-store' },
        },
      )
    }

    // 302 Found (not 301) — browsers won't cache the redirect,
    // so if the operator ever rotates targetUrl on a slug (e.g.
    // share is revoked + re-issued), the next access sees the new
    // destination immediately.
    return NextResponse.redirect(link.targetUrl, {
      status: 302,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    logError('[short-link] resolve failed:', err)
    return new NextResponse('Internal error resolving short link', {
      status: 500,
    })
  }
}
