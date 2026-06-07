import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { buildShortUrl, createShortLink } from '@/lib/short-link'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/short-links (2.4.0+).
 *
 * Body: { targetUrl: string, expiresAt?: string (ISO-8601) }
 *
 * Admin-only. Creates a ShortLink row and returns the tidy
 * `https://<shortLinkDomain>/<slug>` URL so the share modal can
 * copy it to clipboard instead of the long signed URL.
 *
 * Returns 400 + a hint when `Settings.shortLinkDomain` is NULL —
 * caller is expected to fall back to the long URL silently.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  let body: { targetUrl?: unknown; expiresAt?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const targetUrl =
    typeof body.targetUrl === 'string' ? body.targetUrl.trim() : ''
  if (!targetUrl) {
    return NextResponse.json(
      { error: 'targetUrl is required' },
      { status: 400 },
    )
  }
  // 2 KB cap on the target URL. Real signed share URLs land
  // around 200-400 chars; anything past 2 KB is almost certainly
  // a bug or someone trying to use us as a generic URL shortener.
  if (targetUrl.length > 2048) {
    return NextResponse.json(
      { error: 'targetUrl is too long (max 2048 chars)' },
      { status: 400 },
    )
  }
  // Require a real scheme — http(s) only. Stops mailto:, javascript:,
  // data:, file:, etc. from sneaking in via the redirect.
  if (!/^https?:\/\//i.test(targetUrl)) {
    return NextResponse.json(
      { error: 'targetUrl must use http:// or https://' },
      { status: 400 },
    )
  }

  let expiresAt: Date | null = null
  if (body.expiresAt != null) {
    if (typeof body.expiresAt !== 'string') {
      return NextResponse.json(
        { error: 'expiresAt must be an ISO-8601 string or omitted' },
        { status: 400 },
      )
    }
    const parsed = new Date(body.expiresAt)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: 'expiresAt is not a valid date' },
        { status: 400 },
      )
    }
    expiresAt = parsed
  }

  try {
    // Read the configured short-link domain. If it's not set,
    // the feature is effectively disabled — the caller should
    // fall back to the long URL. We still create the slug so the
    // operator can flip the feature on later and existing share
    // history doesn't break, BUT we return the long-domain
    // equivalent (`<appDomain>/s/<slug>`) as a usable fallback.
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { shortLinkDomain: true, appDomain: true },
    })

    const link = await createShortLink(targetUrl, expiresAt)

    const shortDomain = settings?.shortLinkDomain?.trim()
    const shortUrl = shortDomain
      ? buildShortUrl(shortDomain, link.slug)
      : settings?.appDomain
        ? // Fallback to <appDomain>/s/<slug> when the short
          // domain isn't configured. Same trim that `buildShortUrl`
          // does so we don't end up with a double slash.
          `${settings.appDomain.trim().replace(/\/+$/, '')}/s/${link.slug}`
        : `/s/${link.slug}` // last resort — relative URL, browser will use current host

    return NextResponse.json({
      slug: link.slug,
      shortUrl,
      // Echo the targetUrl back so callers can offer "long URL"
      // as a fallback to copy without a second round-trip.
      targetUrl,
      shortDomainConfigured: !!shortDomain,
    })
  } catch (err) {
    logError('[short-link] create failed:', err)
    return NextResponse.json(
      { error: 'Failed to create short link' },
      { status: 500 },
    )
  }
}
