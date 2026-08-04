'use client'

/**
 * 5.14.0, public site footer (landing / privacy / terms).
 *
 * Honest by design: no social icons (we don't have social accounts yet),
 * no fake badges. Carries the legal operator line requested for the
 * footer and relative links only.
 */

import Link from 'next/link'
import { WordMark } from '@/components/WordMark'

export function MarketingFooter({ onLanding = false }: { onLanding?: boolean }) {
  const anchor = (id: string) => (onLanding ? `#${id}` : `/#${id}`)
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12">
        <div className="flex flex-col md:flex-row gap-10 md:gap-6">
          <div className="md:flex-1 min-w-0">
            <div className="text-white">
              <WordMark iconSize={24} noBackground />
            </div>
            <p className="mt-3 text-sm text-white/50 max-w-xs">
              Video review, feedback &amp; deliverables, everything between
              your team and your clients in one place.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-8 md:gap-14">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">
                Product
              </p>
              <ul className="space-y-2 text-sm">
                <li><a href={anchor('features')} className="text-white/65 hover:text-white transition-colors">Features</a></li>
                <li><a href={anchor('security')} className="text-white/65 hover:text-white transition-colors">Security</a></li>
                <li><a href={anchor('pricing')} className="text-white/65 hover:text-white transition-colors">Pricing</a></li>
                <li><a href={anchor('about')} className="text-white/65 hover:text-white transition-colors">About</a></li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">
                Get started
              </p>
              <ul className="space-y-2 text-sm">
                <li><Link href="/login" className="text-white/65 hover:text-white transition-colors">Sign in</Link></li>
                <li><Link href="/request-access" className="text-white/65 hover:text-white transition-colors">Request early access</Link></li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">
                Legal
              </p>
              <ul className="space-y-2 text-sm">
                <li><Link href="/terms" className="text-white/65 hover:text-white transition-colors">Terms of Use</Link></li>
                <li><Link href="/privacy" className="text-white/65 hover:text-white transition-colors">Privacy Policy</Link></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-white/[0.06] flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <p className="text-xs text-white/40">
            These Services are operated by MINDQUB S.R.L.
          </p>
          <p className="text-xs text-white/40">
            © {year} MINDQUB S.R.L. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}
