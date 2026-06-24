'use client'

/**
 * 3.5.0+ Notifications context — the live data layer behind the admin
 * bell.
 *
 * Responsibilities:
 *   1. Load the current admin's notifications once on mount.
 *   2. Keep them LIVE with zero page refreshes via a Server-Sent
 *      Events stream — consumed through `fetch()` + a stream reader
 *      (NOT the native `EventSource`, which can't send the bearer
 *      token our admin auth requires).
 *   3. Degrade gracefully: if the SSE stream can't be established or
 *      keeps dropping (e.g. a reverse proxy buffering text/event-
 *      stream), fall back to polling `/api/notifications` every few
 *      seconds so the bell still updates — just a touch less instantly.
 *
 * The provider is mounted once in the admin layout so a single stream
 * survives navigation between admin pages.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { logError } from '@/lib/logging'

export interface InAppNotification {
  id: string
  type: string
  projectId: string
  videoId: string
  videoName: string
  folderId: string | null
  actorName: string | null
  isRead: boolean
  createdAt: string
}

interface NotificationsContextValue {
  notifications: InAppNotification[]
  unreadCount: number
  /** True while a live SSE stream is connected (vs polling fallback). */
  live: boolean
  refresh: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsContextValue>({
  notifications: [],
  unreadCount: 0,
  live: false,
  refresh: async () => {},
  markRead: async () => {},
  markAllRead: async () => {},
})

export function useNotifications() {
  return useContext(NotificationsContext)
}

const POLL_MS = 8_000
const MAX_RECONNECT_MS = 15_000

export function NotificationsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState<InAppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [live, setLive] = useState(false)

  // Merge a freshly-pushed notification into local state: dedupe by id,
  // float it to the top, and keep the list capped. Unread count is
  // recomputed from the merged list so a "bump" of an already-unread
  // row doesn't double-count.
  const ingest = useCallback((incoming: InAppNotification) => {
    setNotifications((prev) => {
      const without = prev.filter((n) => n.id !== incoming.id)
      const next = [incoming, ...without].slice(0, 30)
      setUnreadCount(next.filter((n) => !n.isRead).length)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/notifications')
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data?.notifications)) {
        setNotifications(data.notifications)
      }
      if (typeof data?.unreadCount === 'number') {
        setUnreadCount(data.unreadCount)
      }
    } catch (err) {
      logError('[notifications] refresh failed:', err)
    }
  }, [])

  const markRead = useCallback(async (id: string) => {
    // Optimistic — the bell feels instant.
    setNotifications((prev) => {
      const next = prev.map((n) =>
        n.id === id ? { ...n, isRead: true } : n,
      )
      setUnreadCount(next.filter((n) => !n.isRead).length)
      return next
    })
    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } catch (err) {
      logError('[notifications] markRead failed:', err)
    }
  }, [])

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })))
    setUnreadCount(0)
    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
    } catch (err) {
      logError('[notifications] markAllRead failed:', err)
    }
  }, [])

  // ── Live connection manager ───────────────────────────────────────
  // Refs hold the mutable connection bookkeeping so the effect can run
  // once per authenticated session without re-subscribing on every
  // state change.
  const ingestRef = useRef(ingest)
  const refreshRef = useRef(refresh)
  ingestRef.current = ingest
  refreshRef.current = refresh

  const userId = user?.id
  useEffect(() => {
    if (!userId) {
      setNotifications([])
      setUnreadCount(0)
      setLive(false)
      return
    }

    let aborted = false
    let controller: AbortController | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let sseFailures = 0
    // Debounce reconciling the authoritative count after a live push.
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null

    const startPolling = () => {
      if (pollTimer) return
      void refreshRef.current()
      pollTimer = setInterval(() => void refreshRef.current(), POLL_MS)
    }
    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
    const scheduleReconnect = (delay: number) => {
      if (aborted || reconnectTimer) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connectSSE()
      }, delay)
    }

    const handleFrame = (frame: string, onReady: () => void) => {
      const lines = frame.split('\n')
      let event = 'message'
      let data = ''
      for (const line of lines) {
        if (line.startsWith(':')) continue // heartbeat / comment
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (event === 'ready') {
        onReady()
        return
      }
      if (event === 'error') {
        startPolling()
        return
      }
      if (data) {
        try {
          const n = JSON.parse(data) as InAppNotification
          ingestRef.current(n)
          // Reconcile the authoritative unread count shortly after, so
          // the badge can't drift over a long-lived session.
          if (reconcileTimer) clearTimeout(reconcileTimer)
          reconcileTimer = setTimeout(() => void refreshRef.current(), 400)
        } catch {
          /* ignore malformed frame */
        }
      }
    }

    const connectSSE = async () => {
      if (aborted) return
      controller = new AbortController()
      try {
        const res = await apiFetch('/api/notifications/stream', {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        })
        if (!res.ok || !res.body) {
          throw new Error(`stream status ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const markReady = () => {
          sseFailures = 0
          stopPolling()
          setLive(true)
        }
        // Read until the server recycles the connection or we abort.
        while (true) {
          const { done, value } = await reader.read()
          if (done || aborted) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            handleFrame(frame, markReady)
          }
        }
        // Normal end (server recycled the stream) → reconnect promptly.
        setLive(false)
        if (!aborted) scheduleReconnect(1_000)
      } catch (err) {
        if (aborted) return
        sseFailures += 1
        setLive(false)
        // Two strikes → keep the bell alive with polling while we keep
        // retrying the stream in the background.
        if (sseFailures >= 2) startPolling()
        scheduleReconnect(Math.min(1_000 * 2 ** sseFailures, MAX_RECONNECT_MS))
        logError('[notifications] stream error:', err)
      }
    }

    // Initial population (independent of the live stream), then connect.
    void refreshRef.current()
    void connectSSE()

    return () => {
      aborted = true
      if (controller) controller.abort()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (reconcileTimer) clearTimeout(reconcileTimer)
      stopPolling()
    }
  }, [userId])

  return (
    <NotificationsContext.Provider
      value={{ notifications, unreadCount, live, refresh, markRead, markAllRead }}
    >
      {children}
    </NotificationsContext.Provider>
  )
}
