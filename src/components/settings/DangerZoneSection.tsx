'use client'

/**
 * 5.10 Danger Zone (tenant companies only — the platform org never sees
 * this): schedule the company's deletion. Server enforces everything; this
 * UI explains the safety model and collects the double confirmation
 * (exact company name + Owner password).
 */

import { useState } from 'react'
import { AlertTriangle, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api-client'

interface DangerZoneSectionProps {
  companyName: string
  /** Only Owners may initiate — the button is hidden otherwise. */
  isOwner: boolean
}

export function DangerZoneSection({ companyName, isOwner }: DangerZoneSectionProps) {
  const [open, setOpen] = useState(false)
  const [typedName, setTypedName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOwner) return null

  async function handleDelete() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/organization/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, companyName: typedName }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Failed to schedule deletion.')
        return
      }
      // Reload so the red countdown banner appears everywhere immediately.
      window.location.reload()
    } catch {
      setError('Failed to schedule deletion.')
    } finally {
      setBusy(false)
    }
  }

  return (
    // 5.10.2: border instead of ring — rings are box-shadows drawn
    // OUTSIDE the box and get clipped by the settings pane's scroll
    // container (the left edge was cut off). A border renders inside
    // the border-box, so it survives any ancestor overflow.
    <div className="rounded-xl border border-red-500/40 bg-red-500/[0.06] p-4 space-y-3">
      <div className="flex items-center gap-2 text-red-300">
        <AlertTriangle className="w-5 h-5" />
        <h3 className="font-semibold text-red-200">Danger Zone</h3>
      </div>
      <p className="text-sm text-white/70">
        Permanently delete this company and everything in it — users, settings
        and history. A 30-day countdown starts first, visible to everyone, and
        any Owner can cancel it at any time.
      </p>
      <Button
        variant="ghost"
        className="bg-red-600/80 hover:bg-red-600 text-white font-semibold"
        onClick={() => {
          setTypedName('')
          setPassword('')
          setError(null)
          setOpen(true)
        }}
      >
        <Trash2 className="w-4 h-4 mr-2" />
        Delete Company
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          overlayClassName="bg-black/60"
          className="sm:max-w-md bg-[#2a1215] text-white ring-2 ring-red-500/50 border-0 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-300">
              <AlertTriangle className="w-5 h-5" />
              Delete {companyName}?
            </DialogTitle>
            <DialogDescription className="text-white/70">
              This is the most destructive action in FrameComment.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <ul className="text-sm text-white/75 space-y-1.5 list-disc pl-5">
              <li>
                A <strong className="text-red-300">30-day countdown</strong> starts —
                a red banner shows it to everyone, and any Owner can cancel it
                with their password at any time.
              </li>
              <li>
                When the timer ends, <strong className="text-red-300">everything is
                erased permanently</strong>: users, invites, settings, billing
                history. There is no undo.
              </li>
              <li>
                For safety, deletion is only possible once the company has{' '}
                <strong>zero projects</strong> (Trash included) — and projects can
                only be deleted one per 24 hours, each spending 24 hours in
                Trash first. This makes it impossible for a compromised account
                to wipe out your work quickly.
              </li>
            </ul>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/15 ring-1 ring-red-500/40">
                <p className="text-sm text-red-200">{error}</p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="dz-name" className="text-white/80">
                Type the company name to confirm: <span className="font-mono text-red-300">{companyName}</span>
              </Label>
              <Input
                id="dz-name"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder={companyName}
                className="bg-white/[0.06] border-white/10 text-white"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dz-password" className="text-white/80">Your password</Label>
              <Input
                id="dz-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-white/[0.06] border-white/10 text-white"
                autoComplete="current-password"
              />
            </div>

            <Button
              onClick={handleDelete}
              disabled={busy || typedName.trim() !== companyName.trim() || !password.trim()}
              className="w-full bg-red-600 hover:bg-red-500 text-white font-semibold"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Start the 30-day deletion countdown
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
