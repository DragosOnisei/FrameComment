'use client'

import { useAuth } from '@/components/AuthProvider'
import {
  FolderKanban,
  LogOut,
  Settings as SettingsIcon,
  Trash2,
  User,
  Users,
  ChevronUp,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useTranslations } from 'next-intl'
import WordMark from '@/components/WordMark'

/**
 * 2.5.0+ AdminSidebar — primary left-side navigation.
 *
 * Replaces the legacy horizontal AdminHeader's nav links. Pinned to
 * the left edge of every admin page, fixed width (`--sidebar-width`)
 * with frosted glass background that lets the page spotlight bleed
 * through.
 *
 * Layout, top → bottom:
 *   1. Brand lockup (WordMark) — clicks home to /admin/projects.
 *   2. Primary nav: Projects, Users, Trash. (Settings moved into
 *      the profile dropdown at the bottom in 2.5.0+.) Active state
 *      is a soft primary tint instead of solid fill so it feels
 *      lighter against the glass surface.
 *   3. User profile pinned at the bottom with an upward-opening
 *      dropdown for Profile / Settings / Sign out. (Theme picker
 *      was removed in 2.5.0+ when the app went dark-only.)
 *
 * Hidden on viewports below md: (mobile uses a separate drawer that
 * the topbar's hamburger opens — implemented in a follow-up commit
 * so we ship the desktop layout first).
 */
export default function AdminSidebar() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const t = useTranslations('nav')
  const ta = useTranslations('auth')

  const [trashCount, setTrashCount] = useState<number | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // Trash count badge — fetched once on mount + on every `trash:changed`
  // window event fired by the delete/restore paths. Same protocol the
  // legacy AdminHeader used, so any component that dispatches the
  // event keeps working without changes.
  useEffect(() => {
    let alive = true
    const fetchCount = () => {
      apiFetch('/api/trash/count')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (alive && typeof data?.count === 'number') {
            setTrashCount(data.count)
          }
        })
        .catch(() => {})
    }
    fetchCount()
    const onChanged = () => fetchCount()
    window.addEventListener('trash:changed', onChanged)
    window.addEventListener('focus', fetchCount)
    return () => {
      alive = false
      window.removeEventListener('trash:changed', onChanged)
      window.removeEventListener('focus', fetchCount)
    }
  }, [])

  // Click-outside dismisses the user dropdown.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    if (showUserMenu) {
      document.addEventListener('mousedown', onMouseDown)
      return () => document.removeEventListener('mousedown', onMouseDown)
    }
  }, [showUserMenu])

  if (!user) return null

  const navLinks: Array<{
    href: string
    label: string
    icon: typeof FolderKanban
    badge?: number | null
  }> = [
    { href: '/admin/projects', label: t('projects'), icon: FolderKanban },
    { href: '/admin/users', label: t('users'), icon: Users },
    // 2.5.0+: Settings moved out of the primary nav — it lives in
    // the profile dropdown at the bottom of the sidebar where the
    // user-scoped actions cluster naturally (Profile / Settings /
    // Sign out). One source of truth instead of two.
    // "Trash" was never wired to the i18n bundle in the legacy
    // AdminHeader either (always rendered the literal English) —
    // keep that behaviour rather than ship a key that isn't there.
    { href: '/admin/trash', label: 'Trash', icon: Trash2, badge: trashCount },
  ]

  const initials = (user.name || user.email || '?').trim().charAt(0).toUpperCase()

  return (
    <aside
      className="glass-panel hidden md:flex md:flex-col h-screen sticky top-0 z-40 px-3 py-4 gap-2"
      style={{ width: 'var(--sidebar-width)' }}
    >
      {/* Brand lockup — also doubles as a home link so the sidebar
          has a clear top-most affordance. */}
      <Link
        href="/admin/projects"
        className="flex items-center px-2 py-3 hover:opacity-90 transition-opacity"
        aria-label="FrameComment home"
      >
        <WordMark variant="horizontal" iconSize={28} ariaHidden noBackground />
      </Link>

      {/* Primary nav. `flex-1` so the user profile cluster is pinned
          to the bottom regardless of how many nav items we have. */}
      <nav className="flex-1 flex flex-col gap-1 mt-2">
        {navLinks.map((link) => {
          const Icon = link.icon
          const isActive =
            pathname === link.href ||
            (link.href !== '/admin/projects' && pathname?.startsWith(link.href))
          const showBadge =
            typeof link.badge === 'number' && link.badge > 0
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-primary/15 text-primary'
                  : 'text-foreground/80 hover:bg-foreground/5'
              }`}
            >
              <Icon className="w-[18px] h-[18px] shrink-0" />
              <span className="flex-1 truncate">{link.label}</span>
              {showBadge && (
                <span
                  className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center tabular-nums"
                  aria-label={`${link.badge} items in Trash`}
                  title={`${link.badge} items in Trash`}
                >
                  {link.badge! > 99 ? '99+' : link.badge}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* User profile cluster — pinned at bottom by the `flex-1` on
          the nav above. Click opens an UPWARD dropdown so the menu
          doesn't get clipped by the viewport bottom. */}
      <div ref={userMenuRef} className="relative">
        <button
          type="button"
          onClick={() => setShowUserMenu((s) => !s)}
          className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-foreground/5 transition-colors text-left"
          aria-haspopup="menu"
          aria-expanded={showUserMenu}
        >
          {/* 2.5.1+: if the user has uploaded a profile photo show
              it here; otherwise fall back to the brand-blue
              initials disc that's been here since the original
              sidebar shipped. */}
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
            <div className="text-sm font-medium truncate">
              {user.name || user.email}
            </div>
            {user.name && (
              <div className="text-xs text-muted-foreground truncate">
                {user.email}
              </div>
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
            className="absolute bottom-full left-0 right-0 mb-2 glass-panel rounded-lg shadow-lg p-1.5"
            role="menu"
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
            <Link
              href="/admin/settings"
              onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-foreground/5 transition-colors"
              role="menuitem"
            >
              <SettingsIcon className="w-4 h-4" />
              Settings
            </Link>
            {/* 2.5.0+: light theme dropped — app is dark-only now.
                The row that hosted the inline ThemeToggle has been
                removed; the toggle component itself stays imported
                in case we re-enable a theme picker later. */}
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
              {ta('signOut')}
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
