'use client'

/**
 * 3.5.0+ NotificationBell — the live bell in the admin top bar.
 *
 * Sits at the far right of the top bar (after the page's sort/view
 * controls). Shows an unread badge that updates live, and a dropdown
 * listing recent "New comments on <video>" notifications. Clicking a
 * row marks it read and deep-links straight to that video in the
 * review view.
 *
 * Data + live updates come from `NotificationsContext`; this component
 * is purely presentational + navigation.
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Check } from 'lucide-react'
import {
  useNotifications,
  type InAppNotification,
} from '@/contexts/NotificationsContext'

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

function deepLink(n: InAppNotification): string {
  const params = new URLSearchParams({ video: n.videoName })
  if (n.folderId) params.set('folderId', n.folderId)
  return `/admin/projects/${n.projectId}/share?${params.toString()}`
}

export default function NotificationBell() {
  const router = useRouter()
  const { notifications, unreadCount, markRead, markAllRead } =
    useNotifications()
  const [open, setOpen] = useState(false)
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

  const onRowClick = (n: InAppNotification) => {
    setOpen(false)
    void markRead(n.id)
    router.push(deepLink(n))
  }

  const badge = unreadCount > 99 ? '99+' : String(unreadCount)

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
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-primary text-white text-[10px] font-semibold leading-none ring-2 ring-[#0b1622]">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[340px] max-w-[90vw] rounded-xl overflow-hidden bg-white/[0.06] ring-1 ring-white/10 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] text-white z-[100]"
          style={{
            backdropFilter: 'blur(40px) saturate(160%)',
            WebkitBackdropFilter: 'blur(40px) saturate(160%)',
          }}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="text-xs text-white/60 hover:text-white transition-colors flex items-center gap-1"
              >
                <Check className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-sm text-white/50 text-center">
                No notifications yet.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.07]">
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => onRowClick(n)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${
                      n.isRead ? 'hover:bg-white/[0.05]' : 'bg-primary/[0.08] hover:bg-primary/[0.14]'
                    }`}
                  >
                    {/* Unread dot keeps the column aligned for read rows. */}
                    <span
                      className={`mt-1.5 shrink-0 w-2 h-2 rounded-full ${
                        n.isRead ? 'bg-transparent' : 'bg-primary'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm leading-snug">
                        New comments on{' '}
                        <span className="font-medium">{n.videoName}</span>
                      </div>
                      <div className="text-xs text-white/50 truncate mt-0.5">
                        {n.actorName ? `${n.actorName} · ` : ''}
                        {relativeTime(n.createdAt)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
