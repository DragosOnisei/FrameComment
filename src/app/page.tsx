import type { Metadata } from 'next'
import { LandingClient } from '@/components/marketing/LandingClient'
import { SITE_URL, SITE_NAME, SITE_TITLE, SITE_DESCRIPTION, SITE_KEYWORDS } from '@/lib/site'

/**
 * 5.14 — the root of framecomment.com is the public landing page.
 *
 * History: pre-5.14 this was a client-side redirect to /admin/projects,
 * which bounced logged-out visitors to the bare login screen. Now
 * visitors get the marketing site; signed-in users are still whisked
 * into the app by LandingClient's session check. Sign-in lives at
 * /login (unchanged).
 *
 * SEO/GEO: this wrapper stays a SERVER component so crawlers get full
 * metadata + JSON-LD structured data (Organization, WebSite,
 * SoftwareApplication) without executing JavaScript. Everything below
 * is machine-readable only — zero UI impact. All claims are honest and
 * mirror what the page visibly says (Google's structured-data parity
 * requirement).
 */

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
}

// JSON-LD structured data (schema.org). Facts only — operator, product,
// real pricing. No invented ratings/reviews: Google penalizes schema
// that isn't backed by visible page content.
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'MINDQUB S.R.L.',
      url: SITE_URL,
      logo: `${SITE_URL}/brand/icon-512.svg`,
      email: 'dragos.onisei@mindqub.eu',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Strada Vespasian nr. 47, Camera 2',
        addressLocality: 'București',
        postalCode: '011981',
        addressCountry: 'RO',
      },
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      publisher: { '@id': `${SITE_URL}/#organization` },
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Video review and collaboration',
      operatingSystem: 'Web browser',
      description:
        'Video review and collaboration platform for production teams, agencies and creators: frame-accurate timestamped comments, voice notes, version stacks with side-by-side compare, password-protected client share links, AI transcripts, and your choice of storage (managed hosting, your own NAS, Cloudflare R2 or AWS S3).',
      featureList: [
        'Frame-accurate timestamped comments and colored timeline markers',
        'Voice comments and comment attachments',
        'Version stacking with synced side-by-side comparison',
        'Client share links with passwords and expiration dates — no client account needed',
        'Client uploads through the same share link',
        'AI-generated searchable transcripts',
        'Adaptive streaming up to 4K',
        'Bring your own storage: NAS, Cloudflare R2 or AWS S3 with no per-GB fee',
        'Per-company data isolation enforced with PostgreSQL row-level security',
        '30-day Trash and deletion safety windows',
      ],
      offers: [
        {
          '@type': 'Offer',
          name: 'Free',
          price: '0',
          priceCurrency: 'USD',
          description: '1 team member and 10 GB hosted storage, every feature included.',
        },
        {
          '@type': 'Offer',
          name: 'Pay as you grow',
          price: '25',
          priceCurrency: 'USD',
          description:
            '$25 per extra member per month, plus $0.10 per GB per month only on FrameComment-hosted storage. Own storage is never billed per GB. Prorated monthly, cancel anytime.',
        },
      ],
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
  ],
}

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        // Structured data for search engines and AI assistants.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingClient />
    </>
  )
}
