'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * 1.7.2+: shared A-Z / Z-A sort preference for the projects
 * dashboard. The toggle UI lives in AdminHeader (next to the
 * Grid/Table view toggle) so the user reaches it in the same
 * place regardless of which admin page they're on; ProjectsList
 * just consumes the live value via this hook.
 *
 * Mirrors `useAdminViewMode` — same per-user scoping, same
 * synchronous lazy init from `last_admin_user_id`, same window-
 * event broadcast for cross-component + cross-tab sync.
 */

// 4.7.x: extended from just A-Z / Z-A to also cover upload-date order, driven
// by the new Sort menu in the admin topbar. Kept as string literals so the
// per-user localStorage value stays human-readable.
export type AdminSortMode =
  | 'alphabetical'
  | 'alphabetical-reverse'
  | 'date-newest'
  | 'date-oldest'

const VALID_MODES: AdminSortMode[] = [
  'alphabetical',
  'alphabetical-reverse',
  'date-newest',
  'date-oldest',
]

function isValidMode(v: unknown): v is AdminSortMode {
  return typeof v === 'string' && (VALID_MODES as string[]).includes(v)
}

const EVENT_NAME = 'admin-sort-mode-changed'

function storageKey(userId: string | null): string | null {
  if (!userId) return null
  return `admin_sort_mode:${userId}`
}

function readSync(): AdminSortMode {
  if (typeof window === 'undefined') return 'alphabetical'
  try {
    const cachedId = window.localStorage.getItem('last_admin_user_id')
    const key = storageKey(cachedId)
    if (!key) return 'alphabetical'
    const raw = window.localStorage.getItem(key)
    if (isValidMode(raw)) return raw
  } catch {
    /* localStorage disabled */
  }
  return 'alphabetical'
}

export function useAdminSortMode(): [AdminSortMode, (next: AdminSortMode) => void] {
  const [mode, setModeLocal] = useState<AdminSortMode>(readSync)

  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<AdminSortMode>).detail
      if (isValidMode(detail)) {
        setModeLocal(detail)
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('admin_sort_mode:')) return
      if (isValidMode(e.newValue)) {
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

  const setMode = useCallback((next: AdminSortMode) => {
    setModeLocal(next)
    if (typeof window === 'undefined') return
    try {
      const cachedId = window.localStorage.getItem('last_admin_user_id')
      const key = storageKey(cachedId)
      if (key) window.localStorage.setItem(key, next)
    } catch {
      /* localStorage disabled */
    }
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }))
    } catch {
      /* old browsers */
    }
  }, [])

  return [mode, setMode]
}
