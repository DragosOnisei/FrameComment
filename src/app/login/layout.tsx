import type { Metadata } from 'next'

/**
 * 5.14 SEO — the login page is functional, not content: keep it OUT of
 * search results (noindex) while leaving it reachable for humans. The
 * page component itself is a client component, so the metadata lives
 * in this pass-through layout.
 */
export const metadata: Metadata = {
  title: 'Sign in — FrameComment',
  robots: { index: false, follow: true },
  alternates: { canonical: '/login' },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
