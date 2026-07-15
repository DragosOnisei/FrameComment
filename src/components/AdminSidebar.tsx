'use client'

import { useAuth } from '@/components/AuthProvider'
import {
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
import ProjectCoverImage from '@/components/ProjectCoverImage'

/**
 * 2.5.0+ AdminSidebar — primary left-side navigation.
 *
 * 4.1.5+ layout, top → bottom:
 *   1. Brand lockup (WordMark) — clicks home to /admin/projects.
 *   2. "Projects" as a section title (also a link to the projects
 *      dashboard), with the live list of projects underneath so the
 *      user can hop between them in one click.
 *   3. User profile pinned at the bottom with an upward-opening
 *      dropdown for Profile / Settings / Users / Trash / Sign out.
 *      (Users + Trash moved here from the primary nav in 4.1.5.)
 *
 * Hidden below md: (mobile uses the topbar drawer).
 */
export default function AdminSidebar() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const t = useTranslations('nav')
  const ta = useTranslations('auth')

  const [trashCount, setTrashCount] = useState<number | null>(null)
  const [projects, setProjects] = useState<
    Array<{ id: string; title: string; hasCover: boolean }>
  >([])
  const [showUserMenu, setShowUserMenu] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // Trash count badge — fetched once on mount + on every `trash:changed`
  // window event fired by the delete/restore paths.
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

  // 4.1.5+: live project list for quick switching. Refetched on mount,
  // on window focus, and whenever a `projects:changed` event fires (so
  // creating/renaming/deleting a project updates the sidebar).
  useEffect(() => {
    let alive = true
    const fetchProjects = () => {
      apiFetch('/api/projects')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!alive || !data) return
          const list = Array.isArray(data) ? data : data.projects || []
          setProjects(
            list.map((p: any) => ({
              id: p.id,
              title: p.title || p.name || 'Untitled',
              hasCover: !!p.coverImagePath,
            })),
          )
        })
        .catch(() => {})
    }
    fetchProjects()
    const onChanged = () => fetchProjects()
    window.addEventListener('projects:changed', onChanged)
    window.addEventListener('focus', fetchProjects)
    return () => {
      alive = false
      window.removeEventListener('projects:changed', onChanged)
      window.removeEventListener('focus', fetchProjects)
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

  const initials = (user.name || user.email || '?').trim().charAt(0).toUpperCase()
  const projectsActive = pathname === '/admin/projects'

  return (
    <aside
      className="glass-panel hidden md:flex md:flex-col h-screen sticky top-0 z-40 px-3 py-4 gap-2"
      style={{ width: 'var(--sidebar-width)' }}
    >
      {/* Brand lockup — doubles as a home link. */}
      <Link
        href="/admin/projects"
        className="flex items-center px-2 py-3 hover:opacity-90 transition-opacity"
        aria-label="FrameComment home"
      >
        <WordMark variant="horizontal" iconSize={28} ariaHidden noBackground />
      </Link>

      {/* Projects section: a title (also a link to the dashboard) + the
          live list of projects underneath for quick switching. `flex-1`
          keeps the user cluster pinned to the bottom; the list scrolls
          on its own when there are many projects. */}
      <nav className="flex-1 flex flex-col gap-1 mt-2 min-h-0">
        <Link
          href="/admin/projects"
          className={`flex items-center px-3 py-2 rounded-lg text-xs font-semibold uppercase tracking-wide transition-colors ${
            projectsActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span className="flex-1 truncate">{t('projects')}</span>
        </Link>

        {/* Delimiter under the Projects title. */}
        <div className="h-px bg-border mx-3 mb-1" />

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 pr-1">
          {projects.map((p) => {
            const isActive = !!pathname?.startsWith(`/admin/projects/${p.id}`)
            return (
              <Link
                key={p.id}
                href={`/admin/projects/${p.id}`}
                title={p.title}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/15 text-primary'
                    : 'text-foreground/75 hover:bg-foreground/5'
                }`}
              >
                {/* Project icon (cover). Falls back to the initial while
                    there's no cover / it hasn't loaded. */}
                <span className="relative w-5 h-5 rounded-[5px] overflow-hidden shrink-0 bg-foreground/10 ring-1 ring-white/10 flex items-center justify-center text-[9px] font-semibold text-foreground/60">
                  {p.title.charAt(0).toUpperCase()}
                  {p.hasCover && (
                    <ProjectCoverImage
                      projectId={p.id}
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                  )}
                </span>
                <span className="flex-1 truncate">{p.title}</span>
              </Link>
            )
          })}
          {projects.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No projects yet</div>
          )}
        </div>
      </nav>

      {/* User profile cluster — pinned at bottom. Click opens an UPWARD
          dropdown (Profile / Settings / Users / Trash / Sign out). */}
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

            <div className="h-px bg-border my-1" />

            {/* 4.1.5+: Users + Trash moved out of the primary nav into
                the profile menu so the sidebar focuses on projects. */}
            <Link
              href="/admin/users"
              onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-foreground/5 transition-colors"
              role="menuitem"
            >
              <Users className="w-4 h-4" />
              {t('users')}
            </Link>
            <Link
              href="/admin/trash"
              onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-foreground/5 transition-colors"
              role="menuitem"
            >
              <Trash2 className="w-4 h-4" />
              <span className="flex-1">Trash</span>
              {typeof trashCount === 'number' && trashCount > 0 && (
                <span
                  className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center tabular-nums"
                  aria-label={`${trashCount} items in Trash`}
                >
                  {trashCount > 99 ? '99+' : trashCount}
                </span>
              )}
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
              {ta('signOut')}
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
