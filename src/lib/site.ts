/**
 * 5.14 — single source of truth for the PUBLIC site's identity (SEO,
 * sitemap, robots, JSON-LD, Open Graph, llms.txt references).
 *
 * SITE_URL is only used in machine-readable metadata (canonicals,
 * sitemap, structured data) where ABSOLUTE URLs are required by the
 * specs; all human-facing navigation stays relative. Overridable via
 * NEXT_PUBLIC_SITE_URL for staging installs.
 */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://framecomment.com').replace(/\/+$/, '')

export const SITE_NAME = 'FrameComment'

export const SITE_TITLE = 'FrameComment — Video review, feedback & deliverables'

export const SITE_DESCRIPTION =
  'FrameComment keeps every cut, comment and approval between your production team and your clients organized. Frame-accurate feedback, client-friendly share links, version stacks, AI transcripts and honest pay-as-you-grow pricing.'

/** Honest, human-written keyword set — what the product actually does. */
export const SITE_KEYWORDS = [
  'video review platform',
  'video feedback tool',
  'client video approval',
  'frame accurate comments',
  'video collaboration for production teams',
  'video versioning',
  'share videos with clients',
  'video review and approval software',
  'Frame.io alternative',
  'video post-production workflow',
]
