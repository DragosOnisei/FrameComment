import { prisma, orgSettingsWhere } from './db'
import { NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { SITE_URL } from './site'

/**
 * Get the application URL from request headers
 * Priority: DB settings → Request headers (NextRequest or Server Component) → Error
 * Automatically detects headers from Server Components when request is not provided
 */
/**
 * 2.2.6+: defensive strip of trailing slash from the configured
 * `appDomain`. The Settings UI explicitly says "no trailing slash"
 * but users still type one, and the unguarded
 * `${baseUrl}/share/${slug}` template then produces
 * `https://framecomment.com//share/...` — works in most browsers
 * but breaks reverse proxies / curl / Slack unfurls.
 */
function normaliseBase(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * 6.0.3 — is this host unreachable for a CLIENT on the open internet?
 *
 * Editors browse the admin over the LAN or through the TrueNAS app
 * portal (`http://192.168.1.50:30080`), so the request's Host header is
 * frequently an IP literal or `localhost`. A share link built from that
 * host looks fine to the person who created it and is completely dead
 * for the client who receives it — the bug that made this function
 * necessary.
 *
 * Raw IPs are rejected even when publicly routable: a share URL should
 * always carry the branded domain, and a bare IP breaks HTTPS anyway.
 */
export function isNonPublicHost(hostWithPort: string): boolean {
  const host = hostWithPort.trim().toLowerCase().replace(/:\d+$/, '')
  if (!host) return true
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  // Docker/compose service names and LAN suffixes: no dot at all, or a
  // suffix that only resolves inside a private network.
  if (!host.includes('.')) return true
  if (/\.(local|lan|internal|home|localdomain)$/.test(host)) return true
  // IPv4 literal (any range) and bracketed IPv6.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  if (host.startsWith('[')) return true
  return false
}

/**
 * 6.0.3 — the origin every client-facing link must fall back to when we
 * can't trust the request host. `NEXT_PUBLIC_SITE_URL` overrides it for
 * staging installs; otherwise it's the platform domain.
 */
export function canonicalPublicOrigin(): string {
  return normaliseBase(SITE_URL)
}

/**
 * 6.0.3 — rewrite a URL's origin onto `base` when its host can't be
 * reached from outside the network. Path, query and hash are preserved
 * exactly, so the HMAC-signed share params survive untouched. Returns
 * the input unchanged when it's already public (or unparseable).
 */
export function forcePublicOrigin(url: string, base?: string): string {
  try {
    const parsed = new URL(url)
    if (!isNonPublicHost(parsed.host)) return url
    const target = new URL(normaliseBase(base || canonicalPublicOrigin()))
    parsed.protocol = target.protocol
    parsed.host = target.host // host carries the port, so :30080 is dropped
    parsed.port = target.port
    return parsed.toString()
  } catch {
    return url
  }
}

export async function getAppUrl(request?: NextRequest): Promise<string> {
  // 1. Try database settings first. This is the source of truth
  // when set, because admins often run local dev against the
  // production DB and explicitly WANT share links to point at the
  // production host so they can be sent to clients straight from
  // the local UI.
  try {
    const settings = await prisma.settings.findUnique({
      where: orgSettingsWhere(),
      select: { appDomain: true },
    })

    if (settings?.appDomain) {
      return normaliseBase(settings.appDomain)
    }
  } catch (error) {
    // DB not available, continue to request detection
  }

  // 2. Extract from request headers if available (API routes).
  // 6.0.3: ONLY when that host is reachable from the internet. Editors
  // hit the admin over LAN / the TrueNAS portal, and the old code happily
  // baked `http://192.168.x.x:30080` into share links that clients then
  // couldn't open.
  if (request) {
    const proto = request.headers.get('x-forwarded-proto') ||
                  (request.url.startsWith('https') ? 'https' : 'http')
    const host = request.headers.get('x-forwarded-host') ||
                 request.headers.get('host')

    if (host && !isNonPublicHost(host)) {
      return `${proto}://${host}`
    }
  }

  // 3. Try to get headers from Server Component context
  try {
    const headersList = await headers()
    const proto = headersList.get('x-forwarded-proto') || 'http'
    const host = headersList.get('x-forwarded-host') ||
                 headersList.get('host')

    if (host && !isNonPublicHost(host)) {
      return `${proto}://${host}`
    }
  } catch (error) {
    // Not in a request context
  }

  // 4. 6.0.3: last resort is the canonical public origin, never a throw.
  // A missing `appDomain` used to mean "share whatever host you're on",
  // which is exactly how LAN links reached clients.
  return canonicalPublicOrigin()
}

/**
 * Get the application domain from settings
 * Falls back to empty string if not configured (NO LOCALHOST)
 */
export async function getAppDomain(): Promise<string> {
  try {
    const settings = await prisma.settings.findUnique({
      where: orgSettingsWhere(),
      select: { appDomain: true },
    })

    if (settings?.appDomain) {
      return settings.appDomain
    }
  } catch (error) {
    // Silent fail
  }

  // Return empty string - NO LOCALHOST FALLBACK
  return ''
}

/**
 * Generate a share URL for a project
 */
export async function generateShareUrl(
  projectSlug: string,
  request?: NextRequest
): Promise<string> {
  const baseUrl = await getAppUrl(request)
  return `${baseUrl}/share/${projectSlug}`
}
