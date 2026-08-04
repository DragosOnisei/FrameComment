'use client'

/**
 * 4.x TopbarAccountMenu — the account entry point for PHONES / narrow widths.
 *
 * The left sidebar (which carries the Profile / Settings / Users / Trash /
 * Sign out dropdown) is hidden below `md`, leaving no way to reach the account
 * menu on a phone. This drops the user's avatar into the top bar's far right;
 * tapping it opens the same menu. Rendered only below `md` (the breakpoint at
 * which the sidebar disappears) so it never doubles up with the sidebar.
 *
 * The dropdown is portalled to <body> with fixed coords (like the other app
 * menus) so it can't be clipped by the top bar, and uses the shared
 * `brand-menu-surface` so it follows the active accent.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { User, Settings as SettingsIcon, Users, Trash2, LogOut } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canManageSettings, canManageUsers } from '@/lib/permissions'

function initialsOf(nameOrEmail: string): string {
  const s = (nameOrEmail || '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function TopbarAccountMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const compute = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setCoords({
        top: rect.bottom + 6,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null

  const avatarUrl = (user as { avatarUrl?: string | null }).avatarUrl
  const initials = initialsOf(user.name || user.email || '')

  const itemClass =
    'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md text-white hover:bg-white/[0.10] transition-colors text-left'

  return (
    // md:hidden — only shown while the sidebar (which owns this menu on
    // desktop) is collapsed.
    <div ref={wrapRef} className="relative shrink-0 md:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        title="Account"
        className={`flex items-center justify-center h-9 w-9 rounded-full overflow-hidden ring-1 ring-white/15 hover:ring-white/30 transition-shadow ${
          open ? 'ring-white/30' : ''
        }`}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="w-full h-full flex items-center justify-center bg-primary/15 text-primary text-xs font-semibold">
            {initials}
          </span>
        )}
      </button>

      {open && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="menu"
          className="brand-menu-surface fixed z-[130] min-w-[220px] rounded-lg text-white ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-150"
          // Inline opaque accent-tint as a guarantee (wins over any cached /
          // layered background), matching `.brand-menu-surface`.
          //
          // 5.15.2: translateZ(0) + isolation force the menu onto its OWN
          // compositing layer. iOS Safari promotes elements with
          // backdrop-filter (the card select checkboxes) to composited
          // layers and paints them ABOVE non-composited fixed elements,
          // ignoring z-index — the checkboxes bled through this menu on
          // phones. Compositing the menu restores correct z ordering.
          style={{
            top: coords.top,
            right: coords.right,
            transform: 'translateZ(0)',
            willChange: 'transform',
            isolation: 'isolate',
            backgroundColor:
              'color-mix(in srgb, hsl(var(--spotlight-tint)) 18%, hsl(var(--background)))',
          }}
        >
          {/* Identity header */}
          <div className="flex items-center gap-3 px-3 py-2">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                className="w-9 h-9 rounded-full object-cover ring-1 ring-white/10 shrink-0"
              />
            ) : (
              <span className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-semibold shrink-0">
                {initials}
              </span>
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{user.name || user.email}</div>
              {user.name && (
                <div className="text-xs text-white/55 truncate">{user.email}</div>
              )}
            </div>
          </div>

          <div className="h-px bg-white/10 my-1" />

          <Link href="/admin/profile" onClick={() => setOpen(false)} className={itemClass} role="menuitem">
            <User className="w-4 h-4 shrink-0" />
            Profile
          </Link>
          {canManageSettings(user?.role) && (
            <Link href="/admin/settings" onClick={() => setOpen(false)} className={itemClass} role="menuitem">
              <SettingsIcon className="w-4 h-4 shrink-0" />
              Settings
            </Link>
          )}
          {canManageUsers(user?.role) && (
            <Link href="/admin/users" onClick={() => setOpen(false)} className={itemClass} role="menuitem">
              <Users className="w-4 h-4 shrink-0" />
              Users
            </Link>
          )}
          <Link href="/admin/trash" onClick={() => setOpen(false)} className={itemClass} role="menuitem">
            <Trash2 className="w-4 h-4 shrink-0" />
            Trash
          </Link>

          <div className="h-px bg-white/10 my-1" />

          <button
            type="button"
            onClick={() => {
              setOpen(false)
              logout()
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md text-red-400 hover:bg-red-500/15 hover:text-red-300 transition-colors text-left"
            role="menuitem"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            Sign out
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
