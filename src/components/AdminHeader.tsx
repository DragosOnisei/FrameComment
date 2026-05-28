'use client'

import { useAuth } from '@/components/AuthProvider'
import { FolderKanban, LogOut, Search, Settings, Shield, Trash2, User, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useTranslations } from 'next-intl'
import GlobalSearchOverlay from '@/components/GlobalSearchOverlay'
import ViewModeToggle from '@/components/ViewModeToggle'
import SortModeToggle from '@/components/SortModeToggle'
import { useAdminViewMode } from '@/lib/use-admin-view-mode'
import { useAdminSortMode } from '@/lib/use-admin-sort-mode'

export default function AdminHeader() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const [showSecurityDashboard, setShowSecurityDashboard] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  // 1.2.1+: small numeric badge next to the Trash nav link so admins
  // can see at a glance how many items are still recoverable. The
  // count is fetched from a cheap dedicated endpoint and refreshed
  // on window focus + whenever a delete-side component fires a
  // `trash:changed` window event.
  const [trashCount, setTrashCount] = useState<number | null>(null)
  // 1.7.0+: global search overlay state. Opens via the magnifier
  // button or Cmd/Ctrl+K from anywhere in the admin app.
  const [searchOpen, setSearchOpen] = useState(false)
  // 1.7.0+: unified Grid / Table view toggle, synced via
  // useAdminViewMode. Only shown on screens where the toggle has
  // an effect (Projects dashboard + individual project / folder
  // pages); on Settings / Users / Trash etc. the toggle would be
  // meaningless so we hide it.
  const [adminView, setAdminView] = useAdminViewMode()
  const [adminSort, setAdminSort] = useAdminSortMode()
  const showViewToggle =
    !!pathname &&
    (pathname === '/admin/projects' ||
      pathname.startsWith('/admin/projects/'))
  // 1.7.8+: sort toggle stays visible on every projects-related
  // page. On the dashboard it orders the project tiles; inside a
  // project the FolderBrowser respects it for the folder + video
  // grid as well. Same scope as the Grid/Table view toggle.
  const showSortToggle =
    !!pathname &&
    (pathname === '/admin/projects' ||
      pathname.startsWith('/admin/projects/'))
  const t = useTranslations('nav')
  const ta = useTranslations('auth')

  // Fetch security settings to check if security dashboard should be shown
  useEffect(() => {
    async function fetchSecuritySettings() {
      try {
        const response = await apiFetch('/api/settings')
        if (response.ok) {
          const data = await response.json()
          setShowSecurityDashboard(data.security?.viewSecurityEvents ?? false)
        }
      } catch (error) {
        // Security settings fetch failed - using defaults
      }
    }

    fetchSecuritySettings()
  }, [])

  // Trash count — polled on mount, on tab focus, and on
  // `trash:changed` events so the badge always reflects the live
  // state. We intentionally don't poll on an interval; the focus +
  // event combo covers the cases the admin actually cares about
  // (came back to the tab, just trashed/restored something).
  useEffect(() => {
    if (!user) return
    let cancelled = false

    const fetchCount = async () => {
      try {
        const res = await apiFetch('/api/trash/count')
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        if (typeof data?.count === 'number') {
          setTrashCount(data.count)
        }
      } catch {
        /* network blip — leave the previous count */
      }
    }

    fetchCount()
    const onFocus = () => fetchCount()
    const onTrashChanged = () => fetchCount()
    window.addEventListener('focus', onFocus)
    window.addEventListener('trash:changed', onTrashChanged)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('trash:changed', onTrashChanged)
    }
  }, [user])

  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showUserMenu])

  // 1.7.0+: Cmd/Ctrl+K opens the global search overlay from
  // anywhere in the admin app. Bound at the header (which is
  // mounted on every admin page) so the binding survives route
  // changes without leaking listeners.
  useEffect(() => {
    if (!user) return
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [user])

  if (!user) return null

  const navLinks: Array<{ href: string; label: string; icon: typeof FolderKanban; title?: string }> = [
    { href: '/admin/projects', label: t('projects'), icon: FolderKanban },
    { href: '/admin/trash', label: 'Trash', icon: Trash2 },
    { href: '/admin/users', label: t('users'), icon: Users },
    { href: '/admin/settings', label: t('settings'), icon: Settings },
  ]

  // Add Security link if enabled
  if (showSecurityDashboard) {
    navLinks.push({ href: '/admin/security', label: t('security'), icon: Shield })
  }

  return (
    <>
    <div className="relative z-50 bg-card border-b border-border/50 shadow-elevation-sm backdrop-blur-sm">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-2">
        {/* 1.7.0+: 3-section grid layout. Nav links live on the
            LEFT, the Grid/Table view toggle in the CENTER (so the
            switch reads as a global control unrelated to user /
            theme), and Search + Theme + Help + User cluster on the
            RIGHT. Outer columns are `1fr` so the center column is
            mathematically centered against the page, not just
            centered within the leftover space. */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="flex items-center gap-2 sm:gap-6 min-w-0">
            <nav className="flex gap-1 sm:gap-2 overflow-x-auto">
              {navLinks.map((link) => {
                const Icon = link.icon
                const isActive = pathname === link.href || (link.href !== '/admin/projects' && pathname?.startsWith(link.href))
                // Only the Trash link gets the count badge; every
                // other nav item ignores it. Keeping the rendering
                // logic inline keeps the existing nav config array
                // simple (just href/label/icon).
                const isTrashLink = link.href === '/admin/trash'
                const showBadge =
                  isTrashLink && typeof trashCount === 'number' && trashCount > 0

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    title={link.title || link.label || undefined}
                    className={`relative flex items-center gap-2 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 whitespace-nowrap ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-elevation'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    {Icon && (
                      <span className="relative inline-flex">
                        <Icon className="w-4 h-4" />
                        {/* 1.3.2+: badge is only the corner red pill
                            on phones (where the label is hidden).
                            From sm: up we drop the corner pill in
                            favour of an inline count after the label
                            — see the chip rendered next to the label
                            below. */}
                        {showBadge && (
                          <span
                            className="sm:hidden absolute -top-1.5 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] leading-[16px] font-semibold text-center shadow-sm"
                            aria-label={`${trashCount} items in Trash`}
                            title={`${trashCount} items in Trash`}
                          >
                            {trashCount! > 99 ? '99+' : trashCount}
                          </span>
                        )}
                      </span>
                    )}
                    {link.label && <span className="hidden sm:inline">{link.label}</span>}
                    {/* 1.3.2+: inline count chip after the Trash label
                        on sm:+ screens. Reads "Trash 2" with the count
                        styled as a destructive pill so it pulls focus
                        without overlapping the icon. */}
                    {showBadge && (
                      <span
                        className="hidden sm:inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold tabular-nums"
                        aria-label={`${trashCount} items in Trash`}
                        title={`${trashCount} items in Trash`}
                      >
                        {trashCount! > 99 ? '99+' : trashCount}
                      </span>
                    )}
                  </Link>
                )
              })}
            </nav>
          </div>

          {/* 1.7.0+: CENTER column — Grid / Table toggle lives
              here so the switch reads as a top-level navigation
              concern (alongside the global Projects / Trash /
              Users / Settings rail), not as a setting bolted onto
              the user-menu cluster on the right. The wrapper
              always renders so the grid columns stay aligned even
              on pages that don't show the toggle. */}
          <div className="flex items-center justify-center gap-2">
            {showViewToggle && (
              <ViewModeToggle value={adminView} onChange={setAdminView} />
            )}
            {/* 1.7.2+: A-Z / Z-A sort toggle, sibling of the view
                toggle and visually identical (segmented pill).
                Limited to the dashboard route where ordering
                actually matters. */}
            {showSortToggle && (
              <SortModeToggle value={adminSort} onChange={setAdminSort} />
            )}
          </div>

          <div className="flex items-center justify-end gap-2 sm:gap-3">
            {/* 1.7.0+: global video search. Same styling as the
                neighbouring round-corner icon buttons so it sits
                naturally next to the theme toggle / help / user
                menu cluster. Keyboard hint shown on sm:+ screens. */}
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="p-2 rounded-lg border border-border bg-background hover:bg-accent transition-colors shadow-sm"
              aria-label="Search videos"
              title="Search videos (⌘K)"
            >
              <Search className="h-5 w-5 text-foreground" />
            </button>
            <ThemeToggle />
            {/* 1.7.3+: Help/About dialog removed from the header
                to keep the right cluster tight (Search · Theme ·
                User). The About info still lives on the public
                README + repo page. */}
            <div ref={userMenuRef} className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="p-2 rounded-lg border border-border bg-background hover:bg-accent transition-colors shadow-sm"
                aria-label={user.name || user.email}
                title={user.name || user.email}
              >
                <User className="h-5 w-5 text-foreground" />
              </button>
              {showUserMenu && (
                <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-border bg-card shadow-elevation-lg z-50">
                  <div className="px-3 py-2.5 border-b border-border">
                    <p className="text-sm font-medium truncate">{user.name || user.email}</p>
                    {user.name && <p className="text-xs text-muted-foreground truncate">{user.email}</p>}
                    <p className="text-xs text-muted-foreground mt-0.5">{user.role}</p>
                  </div>
                  <div className="p-1">
                    <button
                      onClick={() => { setShowUserMenu(false); logout() }}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      {ta('signOut')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    <GlobalSearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  )
}
