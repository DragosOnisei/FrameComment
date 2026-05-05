import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const DANGEROUS_PROTOCOL = /^(javascript|data|vbscript):/i

export async function proxy(request: NextRequest) {
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
