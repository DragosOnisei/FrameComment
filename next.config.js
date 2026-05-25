const createNextIntlPlugin = require('next-intl/plugin')
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Allow LAN IPs to access the dev server (phone testing on local Wi-Fi).
  // Next.js 15+ blocks cross-origin _next/* requests in dev with 403 otherwise.
  // Only affects dev mode — production is unaffected.
  //
  // 1.3.2+: wildcard-friendly list that covers every common private-
  // network range (10.x, 172.16-31.x, 192.168.x) so we don't have to
  // edit this file every time the router hands out a different IP
  // (e.g. testing from a different Wi-Fi).
  allowedDevOrigins: [
    '192.168.1.104',
    '192.168.1.133',
    '192.168.50.196',
    '*.local',
    '192.168.*.*',
    '10.*.*.*',
    '172.16.*.*',
    '172.17.*.*',
    '172.18.*.*',
    '172.19.*.*',
    '172.20.*.*',
    '172.21.*.*',
    '172.22.*.*',
    '172.23.*.*',
    '172.24.*.*',
    '172.25.*.*',
    '172.26.*.*',
    '172.27.*.*',
    '172.28.*.*',
    '172.29.*.*',
    '172.30.*.*',
    '172.31.*.*',
  ],
  // Increase body size limit for TUS chunked uploads
  // TUS uploads can send chunks larger than 10MB (default Next.js limit)
  // Set to 100MB to handle large video chunks safely
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb'
    }
  },

  // Security headers are set in src/proxy.ts (nonce-based CSP)
  // Static asset headers below cover paths that bypass proxy
  async headers() {
    return [
      {
        source: '/:path(brand|favicon|manifest\\.json|robots\\.txt|sw\\.js)/:rest*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ]
  }
}

module.exports = withNextIntl(nextConfig)
