import type { Metadata } from 'next'

/**
 * 5.14 SEO — registration is invite-gated (private beta), so the page
 * is noindexed; prospects are routed through /request-access instead.
 * The page component is a client component, hence this layout.
 */
export const metadata: Metadata = {
  title: 'Create your company — FrameComment',
  robots: { index: false, follow: true },
  alternates: { canonical: '/register' },
}

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children
}
