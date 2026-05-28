'use client'

/**
 * ShareModal (1.0.8+).
 *
 * Frame.io-style modal that replaces the legacy "Link copied to
 * clipboard" alert. Shows the share URL prominently with a Copy
 * button, a short "Anyone with the link can view + comment" caption,
 * a primary Done action, and (1.4.x+) a share-link expiration
 * toggle:
 *
 *  - Default: "No expiration date" (toggle ON).
 *  - When the user turns it OFF, a row of presets (1 day / 1 week /
 *    1 month) plus a custom date picker appears. Picking any of
 *    these queues an `expiresAt` Date that's persisted on Done via
 *    `onSaveExpiration`.
 *  - When the modal opens, we ALSO auto-copy the link to the
 *    clipboard so the admin can paste it straight into the chat
 *    they're about to send. The Copy button shows a green
 *    "Copied" state for ~1.8s afterwards so the action is visible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Calendar as CalendarIcon,
  Check,
  Copy,
  Link as LinkIcon,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface ShareModalProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Headline of the modal — usually the asset name. */
  title: string
  /** Shareable URL the recipient should open. */
  shareUrl: string
  /** Optional small caption under the URL row. Defaults to a sensible
   *  "anyone with the link" line. */
  caption?: React.ReactNode
  /** 1.4.x+: current expiration on the target (Project / Folder).
   *  Pass `null` if the link never expires. Drives the toggle's
   *  initial state when the modal opens. */
  initialExpiresAt?: Date | string | null
  /** 1.4.x+: persists the new expiration. Called from "Done". Receives
   *  an ISO string for an expiration date, or `null` to clear it.
   *  Caller decides which API endpoint to PATCH (project vs folder)
   *  and supplies the appropriate handler. */
  onSaveExpiration?: (expiresAt: string | null) => Promise<void> | void
}

type Preset = '1d' | '1w' | '1m' | 'custom' | null

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

function addMonths(base: Date, months: number): Date {
  const d = new Date(base)
  d.setMonth(d.getMonth() + months)
  return d
}

function formatDateForInput(d: Date): string {
  // <input type="date"> wants YYYY-MM-DD in the user's local TZ.
  const yyyy = d.getFullYear().toString().padStart(4, '0')
  const mm = (d.getMonth() + 1).toString().padStart(2, '0')
  const dd = d.getDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function ShareModal({
  open,
  onOpenChange,
  title,
  shareUrl,
  caption,
  initialExpiresAt = null,
  onSaveExpiration,
}: ShareModalProps) {
  const [copied, setCopied] = useState(false)
  const initialExpiresDate = useMemo(() => {
    if (!initialExpiresAt) return null
    return initialExpiresAt instanceof Date
      ? initialExpiresAt
      : new Date(initialExpiresAt)
  }, [initialExpiresAt])

  // Toggle ON = "No expiration date". Default ON when caller didn't
  // pass an initialExpiresAt.
  const [noExpiration, setNoExpiration] = useState<boolean>(
    !initialExpiresDate,
  )
  // Currently-selected preset or 'custom' for the date picker.
  const [activePreset, setActivePreset] = useState<Preset>(
    initialExpiresDate ? 'custom' : null,
  )
  // The actual chosen expiration date (only meaningful when
  // noExpiration === false).
  const [expiresDate, setExpiresDate] = useState<Date | null>(
    initialExpiresDate,
  )
  const [saving, setSaving] = useState(false)

  // Auto-copy on open (1.4.x+). The clipboard write is gated behind a
  // user gesture in most browsers, but `Dialog`'s open transition
  // happens inside a click handler so we're fine. If the API is
  // unavailable (Safari Private Mode, http://, etc.) we silently fall
  // back — the user can still hit the Copy button manually.
  // 1.7.7+: clipboard write that survives insecure contexts.
  // `navigator.clipboard.writeText` requires a secure origin
  // (HTTPS or localhost); on TrueNAS LAN over plain HTTP it
  // rejects with NotAllowedError. We fall back to the legacy
  // `document.execCommand('copy')` path so the share URL still
  // lands on the clipboard, instead of forcing the user through
  // a `window.prompt('Copy this share link:', …)` dialog.
  const writeClipboard = useCallback(async (text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        /* fall through to legacy path */
      }
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }, [])

  const autoCopiedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      autoCopiedRef.current = false
      return
    }
    if (autoCopiedRef.current) return
    autoCopiedRef.current = true
    void writeClipboard(shareUrl).then((ok) => {
      if (ok) setCopied(true)
    })
  }, [open, shareUrl, writeClipboard])

  // Reset the green check after a couple of seconds so the user can
  // re-copy without the modal needing to be re-opened.
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])

  // Hydrate / reset expiration state every time the modal opens so the
  // edit state matches the latest server value (prevents a closed-and-
  // reopened modal from rendering stale toggle state).
  useEffect(() => {
    if (!open) return
    setNoExpiration(!initialExpiresDate)
    setExpiresDate(initialExpiresDate)
    setActivePreset(initialExpiresDate ? 'custom' : null)
    setCopied(false)
  }, [open, initialExpiresDate])

  const handleCopy = useCallback(async () => {
    // 1.7.7+: same insecure-context-safe write as the auto-copy
    // on open. No more native `window.prompt` fallback when the
    // clipboard API is blocked — the legacy textarea+execCommand
    // path runs invisibly instead.
    const ok = await writeClipboard(shareUrl)
    if (ok) setCopied(true)
  }, [shareUrl, writeClipboard])

  const pickPreset = useCallback((p: Preset) => {
    const now = new Date()
    setActivePreset(p)
    if (p === '1d') setExpiresDate(addDays(now, 1))
    else if (p === '1w') setExpiresDate(addDays(now, 7))
    else if (p === '1m') setExpiresDate(addMonths(now, 1))
  }, [])

  const handleCustomDate = useCallback((value: string) => {
    if (!value) {
      setExpiresDate(null)
      setActivePreset(null)
      return
    }
    // <input type="date"> emits YYYY-MM-DD; treat as end-of-day in
    // the user's local TZ so picking "today" doesn't expire instantly.
    const [y, m, d] = value.split('-').map((n) => parseInt(n, 10))
    if (!y || !m || !d) return
    const dt = new Date(y, m - 1, d, 23, 59, 59, 999)
    setExpiresDate(dt)
    setActivePreset('custom')
  }, [])

  const handleDone = useCallback(async () => {
    if (saving) return
    if (onSaveExpiration) {
      try {
        setSaving(true)
        const next = noExpiration
          ? null
          : expiresDate
            ? expiresDate.toISOString()
            : null
        await onSaveExpiration(next)
      } finally {
        setSaving(false)
      }
    }
    onOpenChange(false)
  }, [saving, onSaveExpiration, noExpiration, expiresDate, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold leading-6">
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 relative">
            <LinkIcon
              aria-hidden
              className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            />
            <Input
              value={shareUrl}
              readOnly
              onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
              className="pl-8 pr-2 truncate font-mono text-xs"
              aria-label="Share link"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant={copied ? 'outline' : 'default'}
            onClick={handleCopy}
            className={`shrink-0 ${copied ? 'border-emerald-500 text-emerald-500' : ''}`}
          >
            {copied ? (
              <>
                <Check className="mr-1 h-4 w-4" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-1 h-4 w-4" />
                Copy
              </>
            )}
          </Button>
        </div>

        <div className="mt-2 text-xs text-muted-foreground">
          {caption ?? 'Anyone with this link can view and leave comments.'}
        </div>

        {/* 1.4.x+: expiration controls. Hidden entirely when the caller
            doesn't pass `onSaveExpiration` so the modal still works
            for callers that don't yet wire it up. */}
        {onSaveExpiration && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            {/* Single-source-of-truth toggle (1.4.x+). The previous
                version wrapped a visible <span role="switch" onClick>
                AND a hidden <input type="checkbox"> in the same
                <label>. Any click on the visible switch fired BOTH
                the span's onClick AND a synthetic click on the
                checkbox (because the <label> bubbles to its bound
                input), so React received two state flips in the same
                tick and the toggle felt "stuck" / required multiple
                attempts. Replacing it with a real <button
                role="switch"> + plain label gives us one click → one
                flip, accessible focus ring, and Space/Enter for
                keyboard users — all for free. */}
            <div className="flex items-center justify-between gap-3 select-none">
              <span
                className="text-sm font-medium cursor-pointer"
                onClick={() => setNoExpiration((v) => !v)}
              >
                No expiration date
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={noExpiration}
                aria-label="No expiration date"
                onClick={() => setNoExpiration((v) => !v)}
                className={`relative z-[1] inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  noExpiration ? 'bg-primary' : 'bg-muted-foreground/40'
                }`}
              >
                <span
                  aria-hidden
                  className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${
                    noExpiration ? 'translate-x-[18px]' : 'translate-x-[2px]'
                  }`}
                />
              </button>
            </div>
            {!noExpiration && (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {(['1d', '1w', '1m'] as const).map((p) => {
                    const labels: Record<typeof p, string> = {
                      '1d': '1 day',
                      '1w': '1 week',
                      '1m': '1 month',
                    }
                    const active = activePreset === p
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => pickPreset(p)}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background hover:bg-muted border-border'
                        }`}
                      >
                        {labels[p]}
                      </button>
                    )
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <CalendarIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">
                    or pick a date:
                  </span>
                  <Input
                    type="date"
                    value={
                      expiresDate && activePreset === 'custom'
                        ? formatDateForInput(expiresDate)
                        : expiresDate
                          ? formatDateForInput(expiresDate)
                          : ''
                    }
                    min={formatDateForInput(addDays(new Date(), 0))}
                    onChange={(e) => handleCustomDate(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                {expiresDate && (
                  <div className="text-xs text-muted-foreground">
                    Expires{' '}
                    <span className="text-foreground font-medium">
                      {expiresDate.toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={handleDone}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Done'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
