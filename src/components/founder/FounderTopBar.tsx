'use client'

/**
 * 6.2.0 Founder topbar — the same slim, borderless strip as AdminTopBar so the
 * spotlight wash bleeds through uninterrupted, minus everything that belongs to
 * a company: no global search over projects/videos, no notification bell tied
 * to tenant activity.
 *
 * It carries the page title on the left, and on phones (where the sidebar is
 * hidden) the platform nav as a compact segmented control.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { FOUNDER_NAV } from '@/components/founder/FounderSidebar'

export default function FounderTopBar({ title }: { title: string }) {
  const { user, logout } = useAuth()
  const pathname = usePathname()

  if (!user) return null

  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-2 px-4 md:px-6 bg-transparent"
      style={{ height: 'var(--topbar-height)' }}
    >
      <h1 className="font-semibold truncate" style={{ fontSize: 18, lineHeight: '24px' }}>
        {title}
      </h1>

      <div className="flex-1" />

      {/* Phones: the sidebar is hidden, so the nav rides in the bar. */}
      <nav className="md:hidden flex items-center gap-1" aria-label="Founder navigation">
        {FOUNDER_NAV.map(({ href, label, icon: Icon }) => {
          const isActive = href === '/founder' ? pathname === href : !!pathname?.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              className={`inline-flex h-9 w-9 items-center justify-center rounded-md ring-1 transition-colors ${
                isActive
                  ? 'bg-primary/15 text-primary ring-primary/30'
                  : 'text-foreground/70 ring-white/10 hover:bg-foreground/5'
              }`}
            >
              <Icon className="w-4 h-4" />
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => logout()}
          aria-label="Sign out"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-destructive ring-1 ring-white/10 hover:bg-destructive/10 transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </nav>
    </header>
  )
}
