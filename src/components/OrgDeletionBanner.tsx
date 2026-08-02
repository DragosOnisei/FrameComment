'use client'

/**
 * 5.10 Danger Zone: fixed red banner while a company deletion countdown is
 * pending. Shows days left (HH:MM:SS under 24h — ticking every second) and
 * lets an Owner cancel with their password. Driven by /api/billing/status
 * (already the wall/status endpoint every admin page can call).
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { useAuth } from '@/components/AuthProvider'
import { isOwner } from '@/lib/permissions'

export default function OrgDeletionBanner() {
  const { user } = useAuth()
  const [scheduledAt, setScheduledAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [showCancel, setShowCancel] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/billing/status')
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      const at = data?.deletionScheduledAt
      setScheduledAt(at ? new Date(at).getTime() : null)
    } catch {
      /* banner is best-effort */
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(load, 60_000)
    return () => clearInterval(poll)
  }, [load])

  // 1s tick only while the countdown is visible.
  useEffect(() => {
    if (!scheduledAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [scheduledAt])

  const handleCancel = useCallback(async () => {
    if (!password.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/organization/delete/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Failed to cancel deletion.')
        return
      }
      setScheduledAt(null)
      setShowCancel(false)
      setPassword('')
    } catch {
      setError('Failed to cancel deletion.')
    } finally {
      setBusy(false)
    }
  }, [password, busy])

  if (!scheduledAt) return null

  const msLeft = Math.max(0, scheduledAt - now)
  const days = Math.floor(msLeft / 86_400_000)
  let label: string
  if (days >= 1) {
    label = `${days} day${days === 1 ? '' : 's'} left`
  } else {
    const h = String(Math.floor(msLeft / 3_600_000)).padStart(2, '0')
    const m = String(Math.floor((msLeft % 3_600_000) / 60_000)).padStart(2, '0')
    const s = String(Math.floor((msLeft % 60_000) / 1000)).padStart(2, '0')
    label = `${h}:${m}:${s}`
  }

  const canCancel = isOwner(user?.role)

  return (
    <div className="sticky top-0 z-[60] w-full bg-red-600 text-white shadow-lg">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2 text-sm">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="font-semibold">
          This company is scheduled for permanent deletion — {label}.
        </span>
        <span className="hidden sm:inline text-white/85">
          Everything (users, settings, history) will be erased when the timer ends.
        </span>
        {canCancel && !showCancel && (
          <button
            onClick={() => setShowCancel(true)}
            className="ml-auto shrink-0 px-3 py-1 rounded-md bg-white text-red-700 font-semibold hover:bg-red-50 transition-colors"
          >
            Cancel deletion
          </button>
        )}
        {canCancel && showCancel && (
          <span className="ml-auto flex items-center gap-2">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCancel()}
              placeholder="Owner password"
              autoFocus
              className="h-8 rounded-md px-2 text-sm text-red-900 placeholder:text-red-900/50 bg-white focus:outline-none"
            />
            <button
              onClick={handleCancel}
              disabled={busy || !password.trim()}
              className="shrink-0 px-3 py-1 rounded-md bg-white text-red-700 font-semibold hover:bg-red-50 transition-colors disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm'}
            </button>
          </span>
        )}
        {error && <span className="basis-full text-xs text-red-100">{error}</span>}
      </div>
    </div>
  )
}
