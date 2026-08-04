import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

/**
 * 5.14 SEO/GEO — served at /robots.txt (replaces the old static file).
 *
 * Philosophy: be MAXIMALLY WELCOMING to search engines AND AI crawlers
 * on the public marketing pages, while keeping the private app surface
 * (admin, API, share links, invite/auth flows) firmly out of every
 * index — share links carry client work and must never be crawled.
 *
 * AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …)
 * follow the same `*` rules below: public pages allowed, private paths
 * disallowed. We intentionally do NOT block any of them — being read
 * and cited by AI assistants is part of being findable in 2026. The
 * companion /llms.txt gives them a curated summary.
 */

const PRIVATE_PATHS = [
  '/admin/',
  '/api/',
  '/s/', // short share links (client work)
  '/share/', // share views (client work)
  '/invite/', // team invite tokens
  '/device', // device auth flow
  '/reset-password',
  '/forgot-password',
  '/unsubscribe',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: PRIVATE_PATHS,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
