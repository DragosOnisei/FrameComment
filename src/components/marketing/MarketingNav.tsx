'use client'

/**
 * 5.14.0, public site top navigation (landing / privacy / terms).
 *
 * Glass bar with the brand lockup, anchor links into the landing
 * sections, and the two real actions: Sign in (/login) and Request
 * early access (/register). All links are RELATIVE so the pages work
 * identically on localhost and framecomment.com.
 *
 * `onLanding` controls whether section links are same-page anchors
 * ("#features") or absolute-path anchors ("/#features") from the
 * legal pages.
 */

import { useState } from 'react'
import Link from 'next/link'
import { Menu, X, ArrowRight } from 'lucide-react'
import { WordMark } from '@/components/WordMark'

export function MarketingNav({ onLanding = false }: { onLanding?: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = (id: string) => (onLanding ? `#${id}` : `/#${id}`)

  const sections = [
    { id: 'features', label: 'Features' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'about', label: 'About' },
  ]

  return (
    // 5.14: fully transparent top bar, the page's aurora/spotlight shows
    // straight through it. Individual controls carry their own glass
    // surfaces so they stay legible over any content.
    <header className="sticky top-0 z-50">
      <div>
        <nav aria-label="Main navigation" className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-6">
          <Link href="/" className="shrink-0 text-white" aria-label="FrameComment home">
            <WordMark iconSize={26} noBackground />
          </Link>

          <div className="hidden md:flex items-center gap-1 ml-4">
            {sections.map((s) => (
              <a
                key={s.id}
                href={anchor(s.id)}
                className="px-3 py-2 rounded-lg text-sm text-white/65 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                {s.label}
              </a>
            ))}
          </div>

          <div className="flex-1" />

          <div className="hidden sm:flex items-center gap-2">
            <Link
              href="/login"
              className="px-3.5 h-9 inline-flex items-center rounded-lg text-sm text-white/80 hover:text-white bg-white/[0.06] hover:bg-white/[0.12] ring-1 ring-white/10 hover:ring-white/20 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/request-access"
              className="pl-4 pr-3 h-9 inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-primary-foreground bg-primary hover:brightness-110 transition-[filter]"
            >
              Request early access
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/80 bg-white/[0.06] ring-1 ring-white/10"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
          >
            {open ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </nav>

        {open && (
          // The dropdown needs its own surface (the bar itself is
          // transparent) so the menu stays readable over page content.
          <div
            className="md:hidden mx-3 mb-3 rounded-xl ring-1 ring-white/10 px-4 py-3 space-y-1"
            style={{
              backgroundColor: 'rgba(10, 15, 20, 0.9)',
              backdropFilter: 'blur(20px) saturate(150%)',
              WebkitBackdropFilter: 'blur(20px) saturate(150%)',
            }}
          >
            {sections.map((s) => (
              <a
                key={s.id}
                href={anchor(s.id)}
                onClick={() => setOpen(false)}
                className="block px-3 py-2 rounded-lg text-sm text-white/75 hover:text-white hover:bg-white/[0.06]"
              >
                {s.label}
              </a>
            ))}
            <div className="pt-2 flex items-center gap-2">
              <Link
                href="/login"
                className="flex-1 h-10 inline-flex items-center justify-center rounded-lg text-sm text-white/85 bg-white/[0.06] ring-1 ring-white/10"
              >
                Sign in
              </Link>
              <Link
                href="/request-access"
                className="flex-1 h-10 inline-flex items-center justify-center rounded-lg text-sm font-medium text-primary-foreground bg-primary"
              >
                Request access
              </Link>
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
