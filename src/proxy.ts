import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const DANGEROUS_PROTOCOL = /^(javascript|data|vbscript):/i

// 2.4.0+: Frame.io-style short-link host detector.
//
// When a request comes in on a configured short-link domain (e.g.
// `fcmt.io`) we rewrite the path so the existing /s/[slug] Route
// Handler resolves the slug and 302s to the long share URL.
//
// The configured domain comes from the SHORT_LINK_DOMAINS env var
// (comma-separated). Reading the DB from inside the proxy would
// add a round-trip on every request, so we keep this as a static
// comparison and document that admins must set the env var when
// they enable the feature in Settings.
const SHORT_LINK_HOSTNAMES = new Set<string>(
  (process.env.SHORT_LINK_DOMAINS || 'fcmt.io')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
)

function maybeRewriteShortLink(request: NextRequest): NextResponse | null {
  const host = (request.headers.get('host') || '').toLowerCase()
  const hostname = host.split(':')[0]

  if (!SHORT_LINK_HOSTNAMES.has(hostname)) return null

  const url = request.nextUrl.clone()

  // Leave the framework + API surface alone on the short domain.
  // This means /api/health on fcmt.io still hits the actual
  // handler (handy for liveness probes), and Next assets aren't
  // misinterpreted as slugs.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/_next/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/robots.txt' ||
    url.pathname.startsWith('/s/')
  ) {
    return null
  }

  // Empty path → let the root page render, same as anywhere else.
  if (url.pathname === '/' || url.pathname === '') return null

  // Extract the slug — first path segment, no leading slashes.
  const slug = url.pathname.replace(/^\/+/, '').split('/')[0]
  if (!slug) return null

  url.pathname = `/s/${slug}`
  return NextResponse.rewrite(url)
}

export async function proxy(request: NextRequest) {
  // 2.4.0+: short-link rewrite runs first so the rest of the
  // proxy (CSP, returnUrl sanitisation, etc.) doesn't apply to
  // the lookup path — it's just a DB read + 302, no HTML
  // rendering, no nonce needed.
  const shortLinkResponse = maybeRewriteShortLink(request)
  if (shortLinkResponse) return shortLinkResponse

  const url = request.nextUrl

  // Sanitize returnUrl on the login page
  if (url.pathname === '/login') {
    const returnUrl = url.searchParams.get('returnUrl')
    if (returnUrl && (!returnUrl.startsWith('/') || returnUrl.startsWith('//'))) {
      url.searchParams.set('returnUrl', '/admin/projects')
      return NextResponse.redirect(url)
    }
  }

  // Strip dangerous protocol schemes from query parameters
  let sanitized = false
  for (const [key, value] of url.searchParams.entries()) {
    if (DANGEROUS_PROTOCOL.test(value.trim())) {
      url.searchParams.delete(key)
      sanitized = true
    }
  }
  if (sanitized) {
    return NextResponse.redirect(url)
  }

  // Generate nonce for CSP
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')

  const isHttpsEnabled = process.env.HTTPS_ENABLED === 'true' || process.env.HTTPS_ENABLED === '1'

  // Derive S3 origin for CSP — presigned redirects go directly to the S3 endpoint
  let s3Origin = ''
  if (process.env.STORAGE_PROVIDER === 's3' && process.env.S3_ENDPOINT) {
    try { s3Origin = new URL(process.env.S3_ENDPOINT).origin } catch {}
  }

  const isDev = process.env.NODE_ENV !== 'production'

  const connectSrc = [
    "'self'",
    'blob:',
    s3Origin,
    'https://cloudflareinsights.com',
    // Next.js dev tooling needs websocket connections for HMR
    isDev ? 'ws:' : '',
    isDev ? 'wss:' : '',
  ].filter(Boolean).join(' ')

  // In dev, Turbopack/React DevTools require unsafe-eval and unsafe-inline.
  // Production keeps the strict nonce-based policy.
  const scriptSrc = isDev
    ? "'self' 'unsafe-eval' 'unsafe-inline' https://static.cloudflareinsights.com"
    : `'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`

  const cspDirectives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${s3Origin ? ` ${s3Origin}` : ''}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    `media-src 'self' blob:${s3Origin ? ` ${s3Origin}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'self'",
  ]

  if (isHttpsEnabled) {
    cspDirectives.push('upgrade-insecure-requests')
  }

  const requestHeaders = new Headers(request.headers)
  // In dev we use 'unsafe-inline' instead of nonce-based CSP, so don't expose
  // a nonce — otherwise SSR puts a unique nonce on inline scripts and the
  // client hydration mismatches because the server- and client-rendered
  // markup differ on every request.
  if (!isDev) {
    requestHeaders.set('x-nonce', nonce)
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })

  response.headers.set('Content-Security-Policy', cspDirectives.join('; '))
  response.headers.set('X-DNS-Prefetch-Control', 'on')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'same-origin')
  // microphone=(self) is required for the comment voice-recorder. Camera and
  // geolocation are not used by the app, so they remain disabled.
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), interest-cohort=()')

  if (isHttpsEnabled) {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  }

  return response
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|brand|favicon|manifest\\.json|robots\\.txt|sw\\.js).*)']
}
