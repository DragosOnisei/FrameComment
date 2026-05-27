'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * 1.7.0+: ONE source of truth for the admin Grid / Table view
 * preference, shared between the projects dashboard, the in-
 * project folder browser, and any nested folder page. The toggle
 * lives in AdminHeader so it's always reachable; subscribers
 * elsewhere on the page consume the live value through this hook.
 *
 * Storage:
 *  - `admin_view_mode:<userId>` is the canonical per-user key.
 *  - `last_admin_user_id` is written by AuthProvider after a
 *    session check so the lazy initializer can read the right
 *    scoped key synchronously on the very first render — no flash
 *    from grid → table while React waits for the auth callback.
 *
 * Cross-component sync:
 *  React's `useState` doesn't broadcast updates between unrelated
 *  trees (AdminHeader and ProjectsList are siblings under the app
 *  layout, not a shared provider). We bridge the gap with a
 *  custom `admin-view-mode-changed` window event that every
 *  subscriber listens to. A storage event listener catches the
 *  rarer cross-tab case where the user has the admin open in two
 *  windows and flips the toggle in one.
 */

export type AdminViewMode = 'grid' | 'table'

const EVENT_NAME = 'admin-view-mode-changed'

function storageKey(userId: string | null): string | null {
  if (!userId) return null
  return `admin_view_mode:${userId}`
}

function readSync(): AdminViewMode {
  if (typeof window === 'undefined') return 'grid'
  try {
    const cachedId = window.localStorage.getItem('last_admin_user_id')
    const key = storageKey(cachedId)
    if (!key) return 'grid'
    const raw = window.localStorage.getItem(key)
    if (raw === 'grid' || raw === 'table') return raw
  } catch {
    /* localStorage disabled */
  }
  return 'grid'
}

export function useAdminViewMode(): [AdminViewMode, (next: AdminViewMode) => void] {
  const [mode, setModeLocal] = useState<AdminViewMode>(readSync)

  // Listen for changes from siblings + other tabs so all consumers
  // stay in lockstep without a Context provider in the layout.
  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<AdminViewMode>).detail
      if (detail === 'grid' || detail === 'table') setModeLocal(detail)
    }
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('admin_view_mode:')) return
      if (e.newValue === 'grid' || e.newValue === 'table') {
        setModeLocal(e.newValue)
      }
    }
    window.addEventListener(EVENT_NAME, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setMode = useCallback((next: AdminViewMode) => {
    setModeLocal(next)
    if (typeof window === 'undefined') return
    try {
      const cachedId = window.localStorage.getItem('last_admin_user_id')
      const key = storageKey(cachedId)
      if (key) window.localStorage.setItem(key, next)
    } catch {
      /* localStorage disabled — keep the in-memory value */
    }
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }))
    } catch {
      /* old browsers — sync only happens after a reload */
    }
  }, [])

  return [mode, setMode]
}
