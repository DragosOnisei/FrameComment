'use client'

/**
 * 3.5.0+ NotificationBell — the live bell in the admin top bar.
 *
 * 4.x inbox behaviour (Frame.io-style):
 *   - Notifications no longer vanish when handled. Reading one just clears its
 *     unread dot and decrements the bell badge; the row stays in the list.
 *   - Three filter tabs: All (default) / Unread / Read.
 *   - Per-row actions: toggle read/unread, and delete.
 *   - Bulk actions in the header: Mark all as read / Mark all as unread.
 *   - Rows are grouped by day: Today / Yesterday / then the date.
 *
 * Data + live updates come from `NotificationsContext`; this component is
 * presentation + navigation only.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Check, CheckCheck, Circle, Trash2 } from 'lucide-react'
import {
  useNotifications,
  type InAppNotification,
} from '@/contexts/NotificationsContext'

type Tab = 'all' | 'unread' | 'read'

/** Compact relative time: "now", "5m", "3h", "2d", else a date. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(then).toLocaleDateString()
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** "Today" / "Yesterday" / "Jul 20, 2026". */
function dateGroupLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Earlier'
  const today = startOfDay(new Date())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const day = startOfDay(d).getTime()
  if (day === today.getTime()) return 'Today'
  if (day === yesterday.getTime()) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function deepLink(n: InAppNotification): string {
  // Include the STABLE video id so the review page can resolve the video even
  // if its display name changed (rename / version-stack) since the notification
  // was created — `video` (name) stays as a fallback for older links.
  const params = new URLSearchParams({ video: n.videoName })
  if (n.videoId) params.set('videoId', n.videoId)
  if (n.folderId) params.set('folderId', n.folderId)
  return `/admin/projects/${n.projectId}/share?${params.toString()}`
}

export default function NotificationBell() {
  const router = useRouter()
  const {
    notifications,
    unreadCount,
    markRead,
    markUnread,
    remove,
    markAllRead,
    markAllUnread,
  } = useNotifications()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('all')
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Filter by tab, sort newest-first, then split into day sections.
  const groups = useMemo(() => {
    const filtered = notifications.filter((n) =>
      tab === 'all' ? true : tab === 'unread' ? !n.isRead : n.isRead,
    )
    const sorted = [...filtered].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    const out: { label: string; items: InAppNotification[] }[] = []
    for (const n of sorted) {
      const label = dateGroupLabel(n.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(n)
      else out.push({ label, items: [n] })
    }
    return out
  }, [notifications, tab])

  const onRowClick = (n: InAppNotification) => {
    setOpen(false)
    // Opening the video marks it read but keeps it in the list.
    if (!n.isRead) void markRead(n.id)
    router.push(deepLink(n))
  }

  const badge = unreadCount > 99 ? '99+' : String(unreadCount)

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'read', label: 'Read' },
  ]

  const emptyText =
    tab === 'unread'
      ? 'Nothing unread.'
      : tab === 'read'
        ? 'Nothing read yet.'
        : 'No notifications yet.'

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : 'Notifications'
        }
        title="Notifications"
        className="relative flex items-center justify-center h-9 w-9 rounded-lg bg-white/[0.06] ring-1 ring-white/10 hover:bg-white/[0.12] hover:ring-white/20 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] transition-colors text-white/70 hover:text-white"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none ring-2 ring-[#0b1622]">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          // Phones: a FIXED panel clamped to the viewport (left-2/right-2) just
          // below the top bar, so it can never run off the left edge like an
          // `absolute right-0` dropdown does when the bell isn't at the screen
          // edge. Desktop (sm+): the normal dropdown anchored under the bell.
          // Opaque accent-tinted surface (inline color-mix) to match the other
          // menus — no more see-through glass.
          className="fixed left-2 right-2 top-[calc(var(--topbar-height)_+_0.5rem)] sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[380px] sm:max-w-[92vw] rounded-xl overflow-hidden ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] text-white z-[100] bg-background"
          style={{
            backgroundColor:
              'color-mix(in srgb, hsl(var(--spotlight-tint)) 18%, hsl(var(--background)))',
          }}
        >
          {/* Title + bulk actions */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
            <span className="text-sm font-semibold">Notifications</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void markAllRead()}
                title="Mark all as read"
                aria-label="Mark all as read"
                className="flex items-center justify-center h-7 w-7 rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <CheckCheck className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => void markAllUnread()}
                title="Mark all as unread"
                aria-label="Mark all as unread"
                className="flex items-center justify-center h-7 w-7 rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Circle className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-white/10">
            {tabs.map((t) => {
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    active
                      ? 'bg-white/15 text-white'
                      : 'text-white/55 hover:text-white hover:bg-white/[0.08]'
                  }`}
                >
                  {t.label}
                  {t.key === 'unread' && unreadCount > 0 ? ` (${unreadCount})` : ''}
                </button>
              )
            })}
          </div>

          <div className="max-h-[60vh] overflow-y-auto overflow-x-hidden">
            {groups.length === 0 ? (
              <div className="px-4 py-8 text-sm text-white/50 text-center">
                {emptyText}
              </div>
            ) : (
              groups.map((section) => (
                <div key={section.label}>
                  <div className="sticky top-0 z-10 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/40 bg-white/[0.04] backdrop-blur-sm">
                    {section.label}
                  </div>
                  <div className="divide-y divide-white/[0.07]">
                    {section.items.map((n) => (
                      <div
                        key={n.id}
                        className={`group relative flex items-start gap-2.5 px-4 py-3 transition-colors ${
                          n.isRead
                            ? 'hover:bg-white/[0.05]'
                            : 'bg-primary/[0.08] hover:bg-primary/[0.14]'
                        }`}
                      >
                        {/* Unread dot (keeps the column aligned when read). */}
                        <span
                          className={`mt-1.5 shrink-0 w-2 h-2 rounded-full ${
                            n.isRead ? 'bg-transparent' : 'bg-primary'
                          }`}
                        />
                        <button
                          type="button"
                          onClick={() => onRowClick(n)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div className="text-sm leading-snug text-white/80">
                            New comments on
                          </div>
                          <div className="text-sm font-medium truncate">
                            {n.videoName}
                          </div>
                          <div className="text-xs text-white/50 truncate mt-0.5">
                            {n.actorName ? `${n.actorName} · ` : ''}
                            {relativeTime(n.createdAt)}
                          </div>
                        </button>

                        {/* Per-row actions */}
                        <div className="shrink-0 flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (n.isRead) void markUnread(n.id)
                              else void markRead(n.id)
                            }}
                            title={n.isRead ? 'Mark as unread' : 'Mark as read'}
                            aria-label={n.isRead ? 'Mark as unread' : 'Mark as read'}
                            className="flex items-center justify-center h-7 w-7 rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            {n.isRead ? (
                              <Circle className="w-3.5 h-3.5" />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void remove(n.id)
                            }}
                            title="Delete"
                            aria-label="Delete notification"
                            className="flex items-center justify-center h-7 w-7 rounded-md text-white/60 hover:text-red-400 hover:bg-white/10 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
