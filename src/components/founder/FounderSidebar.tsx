'use client'

/**
 * 6.2.0 Founder sidebar — same shell vocabulary as AdminSidebar (glass panel,
 * brand lockup on top, section list, account cluster pinned at the bottom with
 * an upward dropdown), but the nav is the PLATFORM's, not a company's:
 * Dashboard / CRM / AI Agents.
 *
 * Deliberately NOT reusing AdminSidebar: that component is wired to projects,
 * Trash counts and tenant permissions. Sharing it would mean threading "am I
 * the founder?" through every branch — the thing that made the platform and the
 * founder's own company impossible to tell apart in the first place.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  BarChart3,
  Bot,
  ChevronUp,
  LogOut,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  User,
  Users2,
  MessageSquarePlus,
} from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import WordMark from '@/components/WordMark'

export const FOUNDER_NAV = [
  { href: '/founder', label: 'Dashboard', icon: BarChart3 },
  { href: '/founder/crm', label: 'CRM', icon: Users2 },
  { href: '/founder/agents', label: 'AI Agents', icon: Bot },
  { href: '/founder/investors', label: 'Investors', icon: ShieldCheck },
  { href: '/founder/security', label: 'Security', icon: ShieldAlert },
  { href: '/founder/feedback', label: 'Feedback', icon: MessageSquarePlus },
] as const

export default function FounderSidebar() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showUserMenu) return
    const onMouseDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowUserMenu(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [showUserMenu])

  if (!user) return null

  const initials = (user.name || user.email || '?').trim().charAt(0).toUpperCase()

  return (
    <aside
      // 6.20.2: `h-full` inside a viewport-height shell, not `h-screen
      // sticky`. Sticky was solving the wrong problem — it kept the panel in
      // view while the document scrolled past the end of it. Now the document
      // does not scroll at all; only the content column does.
      className="glass-panel hidden md:flex md:flex-col h-full shrink-0 z-40 px-3 py-4 gap-2"
      style={{ width: 'var(--sidebar-width)' }}
    >
      {/* Brand lockup — the platform's own name, not a customer's. */}
      <Link
        href="/founder"
        className="flex items-center px-2 py-3 hover:opacity-90 transition-opacity"
        aria-label="FrameComment platform home"
      >
        <WordMark variant="horizontal" iconSize={28} ariaHidden noBackground />
      </Link>

      <nav className="flex-1 flex flex-col gap-1 mt-2 min-h-0" aria-label="Founder navigation">
        <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Platform
        </div>
        <div className="h-px bg-border mx-3 mb-1" />

        {FOUNDER_NAV.map(({ href, label, icon: Icon }) => {
          // Exact match for the dashboard so /founder/crm doesn't light it up.
          const isActive = href === '/founder' ? pathname === href : !!pathname?.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-primary/15 text-primary'
                  : 'text-foreground/75 hover:bg-foreground/5'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1 truncate">{label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Account cluster — pinned at the bottom, opens upward. */}
      <div ref={userMenuRef} className="relative">
        <button
          type="button"
          onClick={() => setShowUserMenu((s) => !s)}
          className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-foreground/5 transition-colors text-left"
          aria-haspopup="menu"
          aria-expanded={showUserMenu}
        >
          {(user as any).avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={(user as any).avatarUrl}
              alt=""
              className="w-9 h-9 rounded-full object-cover ring-1 ring-white/10 shrink-0"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center font-medium text-sm shrink-0">
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{user.name || user.email}</div>
            {user.name && (
              <div className="text-xs text-muted-foreground truncate">{user.email}</div>
            )}
          </div>
          <ChevronUp
            className={`w-4 h-4 text-muted-foreground transition-transform ${
              showUserMenu ? '' : 'rotate-180'
            }`}
          />
        </button>

        {showUserMenu && (
          <div
            /* 6.22.0: opaque, matching the admin sidebar's menu and the rest of
               the menu family. See the note in AdminSidebar for why glass is
               wrong specifically for menus. */
            className="brand-menu-surface absolute bottom-full left-0 right-0 mb-2 rounded-lg ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-1.5 bg-background"
            role="menu"
            style={{
              backgroundColor:
                'color-mix(in srgb, hsl(var(--spotlight-tint)) 18%, hsl(var(--background)))',
              // Existing iOS compositing guard, kept: without it, backdrop-filter
              // surfaces behind can paint over this panel regardless of z-index.
              transform: 'translateZ(0)',
              isolation: 'isolate',
            }}
          >
            <Link
              href="/admin/profile"
              onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-foreground/5 transition-colors"
              role="menuitem"
            >
              <User className="w-4 h-4" />
              Profile
            </Link>
            {/* Temporary: the platform-level fields (application domain,
                short-link domain, shared OpenAI key) still live in the app's
                Settings page. They move into the Founder area next, and this
                entry goes with them. */}
            <Link
              href="/admin/settings"
              onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-foreground/5 transition-colors"
              role="menuitem"
            >
              <SettingsIcon className="w-4 h-4" />
              Platform settings
            </Link>

            <div className="h-px bg-border my-1" />

            <button
              type="button"
              onClick={() => {
                setShowUserMenu(false)
                logout()
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm rounded-md text-destructive hover:bg-destructive/10 transition-colors"
              role="menuitem"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
