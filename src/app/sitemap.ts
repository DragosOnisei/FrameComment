import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

/**
 * 5.14 SEO — sitemap for the PUBLIC pages only. Served at /sitemap.xml.
 * The app itself (admin, share links, API) is private and deliberately
 * absent; robots.ts disallows it too.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/request-access`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/source`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ]
}
