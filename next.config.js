const createNextIntlPlugin = require('next-intl/plugin')
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Allow LAN IPs to access the dev server (phone testing on local Wi-Fi).
  // Next.js 15+ blocks cross-origin _next/* requests in dev with 403 otherwise.
  // Only affects dev mode — production is unaffected.
  allowedDevOrigins: ['192.168.1.104', '192.168.1.133'],
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
