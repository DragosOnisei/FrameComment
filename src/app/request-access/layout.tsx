import type { Metadata } from 'next'

/**
 * 5.14 SEO — /request-access is a conversion page worth indexing. The
 * page component is a client component, so its metadata lives here.
 */
export const metadata: Metadata = {
  title: 'Request early access — FrameComment',
  description:
    'FrameComment is in private beta. Tell us who you are, video editor, director, YouTuber or entrepreneur, and we will send you an invite as spots open up.',
  alternates: { canonical: '/request-access' },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: '/request-access',
    siteName: 'FrameComment',
    title: 'Request early access — FrameComment',
    description:
      'FrameComment is in private beta. Request an invite and bring your video review workflow into one place.',
  },
}

export default function RequestAccessLayout({ children }: { children: React.ReactNode }) {
  return children
}
