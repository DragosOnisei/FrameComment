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
import { GlassCalendar } from '@/components/GlassCalendar'
import { apiFetch } from '@/lib/api-client'
import { logError } from '@/lib/logging'

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
  // 3.2.3+: ref to the visible share-URL input. The insecure-context
  // (HTTP) clipboard fallback in `writeClipboard` copies directly from
  // this field, which Chrome honours far more reliably than a hidden
  // detached textarea.
  const inputRef = useRef<HTMLInputElement>(null)
  const initialExpiresDate = useMemo(() => {
    if (!initialExpiresAt) return null
    const d =
      initialExpiresAt instanceof Date
        ? initialExpiresAt
        : new Date(initialExpiresAt)
    // 3.2.x: treat the epoch-0 "revoked" sentinel (and any invalid /
    // pre-2000 timestamp) as "no expiration". Folders that were once
    // revoked via Project Settings → Delete link keep `shareExpiresAt`
    // pinned to 1970-01-01; without this guard the modal opened with
    // the toggle OFF and showed "Expires Thu, 1 Jan 1970". Real
    // expirations always live in the present/future, so a year-2000
    // floor cleanly separates them from the sentinel — anything below
    // it defaults the share to "No expiration date" (toggle ON).
    const MIN_VALID_EXPIRY_MS = Date.UTC(2000, 0, 1)
    if (Number.isNaN(d.getTime()) || d.getTime() < MIN_VALID_EXPIRY_MS) {
      return null
    }
    return d
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
    // 3.2.3+ FIX: insecure-context copy (TrueNAS LAN over plain HTTP,
    // where `navigator.clipboard` is undefined). Copy from the VISIBLE,
    // focused share <input> instead of a detached off-screen textarea.
    // The opacity:0 / off-screen textarea was the reason auto-copy
    // "worked" visually but left the clipboard empty: on HTTP, Chrome
    // returned `true` from `execCommand('copy')` while silently refusing
    // to populate the clipboard from a hidden, unfocused element. A
    // real, on-screen, focusable field that already holds the exact
    // text is honoured reliably. The detached textarea stays as a
    // last-resort fallback (e.g. if the input ref isn't mounted yet).
    try {
      const el = inputRef.current
      if (el && el.value === text) {
        const activeBefore = document.activeElement as HTMLElement | null
        el.focus()
        el.setSelectionRange(0, el.value.length)
        const ok = document.execCommand('copy')
        // Collapse the selection and restore prior focus so we don't
        // leave the URL highlighted or steal focus from the dialog.
        el.setSelectionRange(el.value.length, el.value.length)
        if (activeBefore && activeBefore !== el && typeof activeBefore.focus === 'function') {
          activeBefore.focus()
        }
        if (ok) return true
      }
    } catch {
      /* fall through to detached textarea */
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '0'
      ta.style.left = '0'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }, [])

  // 2.4.0+: Frame.io-style short link.
  //
  // When the modal opens, we ask the server to generate a tidy
  // `https://<shortLinkDomain>/<slug>` URL that aliases the long
  // `shareUrl`. If the admin has configured `Settings.shortLinkDomain`,
  // we render and copy the short URL; otherwise we silently fall
  // back to the long URL (no UX regression vs pre-2.4.0).
  //
  // The short link's expiration mirrors `initialExpiresAt` so a
  // 7-day share also yields a 7-day short link. If the admin
  // changes the expiration via this modal's toggle, the SHARE
  // updates but the short link keeps its original expiry — matches
  // Frame.io's own behaviour and avoids confusing slug churn.
  //
  // 2.4.0+ FIX: we use `shortResolved` (not `shortLoading`) as the
  // "auto-copy may proceed" gate. Earlier draft started with
  // `shortLoading = false`, which made the auto-copy effect run
  // BEFORE the fetch effect had set it to true — clipboard got the
  // long URL even though the modal eventually showed the short
  // one. Flipping the polarity (start false → set true after the
  // POST resolves, success OR failure) closes that race.
  const [shortUrl, setShortUrl] = useState<string | null>(null)
  // 3.5.x: whether a short-link DOMAIN is configured server-side.
  //   null  → we don't know yet (POST in flight) → show "Generating…",
  //           never reveal/copy the long URL.
  //   true  → a domain IS configured → we MUST show the short URL and
  //           never the long one (the whole point of this fix).
  //   false → no domain configured → the long URL is correct.
  // We learn this from the POST response, so the long URL can only
  // appear once we KNOW no domain is set (or on a hard failure).
  const [shortDomainConfigured, setShortDomainConfigured] = useState<
    boolean | null
  >(null)
  // 3.5.x: anti-hang safety net ONLY. Previously this was a 600ms grace
  // that revealed the long URL — but that lost the race against a
  // slightly-slow short-link POST, so auto-copy grabbed the LONG link
  // and the short one swapped in too late (the reported bug). Now it's
  // a long fallback that fires only if the POST never answers at all,
  // so a configured short domain effectively always wins.
  const [graceElapsed, setGraceElapsed] = useState(false)
  const shortRequestedRef = useRef<string | null>(null)
  // 2.5.1+: ref + open state for the custom GlassCalendar popover.
  // We dropped the native `<input type="date">` calendar (OS-rendered,
  // unstyleable) in favour of the v2.5 glass picker that lives at
  // the bottom of this file. The button below is the trigger.
  const dateButtonRef = useRef<HTMLButtonElement>(null)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calendarAnchor, setCalendarAnchor] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!calendarOpen) return
    const compute = () => {
      const el = dateButtonRef.current
      if (!el) return
      setCalendarAnchor(el.getBoundingClientRect())
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [calendarOpen])
  useEffect(() => {
    if (!open) {
      shortRequestedRef.current = null
      setShortUrl(null)
      setShortDomainConfigured(null)
      return
    }
    if (!shareUrl) return
    // Guard against double-fires on the same shareUrl — React strict
    // mode + the modal's open-state effect would otherwise call this
    // twice and create two slugs for the same link.
    if (shortRequestedRef.current === shareUrl) return
    shortRequestedRef.current = shareUrl

    void (async () => {
      try {
        const res = await apiFetch('/api/short-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: shareUrl,
            expiresAt: initialExpiresDate
              ? initialExpiresDate.toISOString()
              : null,
          }),
        })
        if (!res.ok) {
          // Endpoint disabled, bad config, or auth issue — we can't
          // mint a short link, so the long URL is the only working
          // option. Treat as "no domain" for display purposes.
          setShortDomainConfigured(false)
          return
        }
        const data = (await res.json()) as {
          shortUrl: string
          shortDomainConfigured: boolean
        }
        // Record whether a real short-link domain is configured. When
        // it IS, the modal shows ONLY the short URL (never the long
        // one). When it is NOT, the server's `<appDomain>/s/<slug>`
        // would be LONGER than the original share URL, so we keep the
        // original long URL instead (no regression vs pre-2.4.0).
        setShortDomainConfigured(!!data.shortDomainConfigured)
        if (data.shortDomainConfigured && data.shortUrl) {
          setShortUrl(data.shortUrl)
        }
      } catch (err) {
        logError('[ShareModal] short link creation failed:', err)
        // Hard failure — no short link possible; fall back to long.
        setShortDomainConfigured(false)
      }
    })()
    // We intentionally exclude `initialExpiresDate` from the dep
    // array — we only want to fire once per modal open. The user
    // changing expiration mid-session doesn't regenerate the slug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shareUrl])

  // 3.5.x: anti-hang safety net ONLY. If the short-link POST never
  // answers (server down / network black hole), reveal the long URL
  // after a generous window so the modal isn't stuck on "Generating
  // link…" forever.
  // 3.8.x: bumped 8s → 15s. A merely-slow POST (busy DB / cold route)
  // was occasionally answering just AFTER the 8s grace fired, so the
  // long URL flashed in first and the short link swapped in a moment
  // later — exactly the "long then short" bug. On the normal path the
  // POST resolves in well under a second and this timer never matters;
  // it only guards a genuine no-response hang, which apiFetch would
  // otherwise turn into a rejection (→ fall back to long via `catch`).
  useEffect(() => {
    if (!open) {
      setGraceElapsed(false)
      return
    }
    const t = setTimeout(() => setGraceElapsed(true), 15_000)
    return () => clearTimeout(t)
  }, [open])

  // The URL the user actually sees + copies.
  //   - Short-link domain configured → ALWAYS the short URL (never the
  //     long one). This is the core guarantee the admin asked for.
  //   - No domain configured → the original long URL.
  const displayUrl =
    shortDomainConfigured && shortUrl ? shortUrl : shareUrl
  // Ready to show/copy once we KNOW the outcome:
  //   - domain configured AND the short URL has arrived, OR
  //   - domain not configured (long URL is correct), OR
  //   - anti-hang elapsed (last-resort fallback so we never hang).
  // While the POST is still in flight (`shortDomainConfigured === null`)
  // we show "Generating link…" and DON'T auto-copy — so the long URL
  // can never be copied ahead of a short link that's on its way.
  const hasUsableUrl =
    (shortDomainConfigured === true && !!shortUrl) ||
    shortDomainConfigured === false ||
    graceElapsed

  const autoCopiedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      autoCopiedRef.current = false
      return
    }
    if (autoCopiedRef.current) return
    // 3.3.x: auto-copy as soon as there's a usable URL — the short link
    // when it resolves quickly, otherwise the long URL once the grace
    // window elapses. Previously this waited for `shortResolved` only,
    // so a slow short-link round-trip left the clipboard empty for many
    // seconds. `displayUrl` is the short URL when available, the long
    // URL otherwise, so we always copy the best link currently shown.
    if (!hasUsableUrl) return
    autoCopiedRef.current = true
    void writeClipboard(displayUrl).then((ok) => {
      if (ok) setCopied(true)
    })
  }, [open, displayUrl, hasUsableUrl, writeClipboard])

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
    // 2.4.0+: copies the SHORT URL when one was successfully
    // minted, falls back to the long URL otherwise.
    const ok = await writeClipboard(displayUrl)
    if (ok) setCopied(true)
  }, [displayUrl, writeClipboard])

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
      {/* 2.5.1+: frosted-glass modal surface — same recipe as every
          other v2.5 popover (mic picker, PlayerTopMenu, All comments
          filter, emoji picker). Dialog already portals to body so
          backdrop-filter samples the page underneath. */}
      <DialogContent
        className="sm:max-w-md border-0 ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85)] text-white"
        style={{
          backgroundColor: 'rgba(22, 37, 51, 0.55)',
          backgroundImage:
            'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          transform: 'translate3d(-50%, -50%, 0)',
          willChange: 'backdrop-filter, transform',
          isolation: 'isolate',
        }}
        // 2.5.1+: while the GlassCalendar is open, completely
        // disable Radix's outside-click dismiss. Any click — inside
        // OR outside the dialog — won't close the share modal as
        // long as the calendar is up. The calendar's own outside-
        // click handler still closes IT when the user clicks
        // elsewhere; once the calendar is gone, Radix's dismiss
        // behaviour returns to normal.
        //
        // This sidesteps every event-ordering / portal / React-tree
        // edge case we tried to plug, because we simply tell Radix
        // "ignore everything for now".
        onPointerDownOutside={(e) => {
          if (calendarOpen) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (calendarOpen) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-semibold leading-6 text-white">
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 relative">
            <LinkIcon
              aria-hidden
              className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-white/55"
            />
            {/* 3.2.3+ UX fix: until the short-link round-trip resolves,
                show a placeholder instead of the long URL. Previously
                the input flashed the long `framecomment.com/share/<slug>`
                URL for the ~200ms it took the POST to come back, then
                swapped to the short `fcmt.io/<slug>` — confusing and
                meant the user copying mid-flight could end up with
                the wrong URL in their clipboard. Now the URL only
                appears once we know which one to show (short if
                configured, long as fallback). The auto-copy effect
                below already gates on `shortResolved` so the
                clipboard side was correct — just the visual was off.
                On the loading state the input is disabled + shows a
                discreet "Generating link…" placeholder; once resolved
                the real URL slides in. */}
            {/* 3.2.3+: `readOnly` (NOT `disabled`) while the short link
                resolves. A `disabled` input cannot be focused or
                selected, which broke the execCommand copy fallback on
                HTTP deployments — the button flashed "Copied" but the
                clipboard stayed empty. `readOnly` keeps the field
                non-editable yet focusable/selectable so the copy works,
                while the empty value + "Generating link…" placeholder
                still conveys the loading state. `ref` lets
                `writeClipboard` select this field directly. */}
            <Input
              ref={inputRef}
              value={hasUsableUrl ? displayUrl : ''}
              placeholder={hasUsableUrl ? undefined : 'Generating link…'}
              readOnly
              onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
              className="pl-8 pr-2 truncate font-mono text-xs bg-white/[0.06] ring-1 ring-white/10 border-0 text-white placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-[hsl(var(--spotlight-tint)/0.55)]"
              aria-label="Share link"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant={copied ? 'outline' : 'default'}
            onClick={handleCopy}
            disabled={!hasUsableUrl}
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

        <div className="mt-2 text-xs text-white/55">
          {caption ?? 'Anyone with this link can view and leave comments.'}
        </div>

        {/* 1.4.x+: expiration controls. Hidden entirely when the caller
            doesn't pass `onSaveExpiration` so the modal still works
            for callers that don't yet wire it up.
            2.5.1+ glass panel. */}
        {onSaveExpiration && (
          <div className="mt-4 rounded-lg bg-white/[0.05] ring-1 ring-white/10 p-3">
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
                className="text-sm font-medium cursor-pointer text-white"
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
                className="relative z-[1] inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--spotlight-tint)/0.55)]"
                style={{
                  backgroundColor: noExpiration
                    ? 'hsl(var(--spotlight-tint))'
                    : 'rgba(255,255,255,0.18)',
                }}
              >
                <span
                  aria-hidden
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
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
                        className="px-3 py-1.5 rounded-md text-xs font-medium ring-1 transition-colors text-white"
                        style={
                          active
                            ? {
                                backgroundColor:
                                  'hsl(var(--spotlight-tint) / 0.25)',
                                boxShadow:
                                  'inset 0 0 0 1px hsl(var(--spotlight-tint) / 0.55)',
                              }
                            : {
                                backgroundColor: 'rgba(255,255,255,0.06)',
                                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
                              }
                        }
                      >
                        {labels[p]}
                      </button>
                    )
                  })}
                </div>
                <div className="flex items-center gap-2 flex-nowrap">
                  <span className="text-xs text-white/55 whitespace-nowrap shrink-0">
                    or pick a date:
                  </span>
                  {/*
                    2.5.1+: glass trigger button that opens the
                    custom GlassCalendar popover (see component at
                    the bottom of this file). Flips to an accent-
                    tinted pill once a date is set so the user
                    always sees their selection at a glance. The
                    tooltip surfaces the formatted date.
                  */}
                  <button
                    ref={dateButtonRef}
                    type="button"
                    data-glass-calendar-trigger
                    onClick={() => setCalendarOpen((v) => !v)}
                    aria-label="Pick expiration date"
                    aria-expanded={calendarOpen}
                    title={
                      expiresDate
                        ? expiresDate.toLocaleDateString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })
                        : 'Pick a date'
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--spotlight-tint)/0.55)] shrink-0"
                    style={
                      expiresDate
                        ? {
                            backgroundColor:
                              'hsl(var(--spotlight-tint) / 0.22)',
                            boxShadow:
                              'inset 0 0 0 1px hsl(var(--spotlight-tint) / 0.45)',
                            color: '#fff',
                          }
                        : {
                            backgroundColor: 'rgba(255,255,255,0.06)',
                            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
                            color: 'rgba(255,255,255,0.75)',
                          }
                    }
                  >
                    <CalendarIcon className="h-4 w-4" />
                  </button>
                  <GlassCalendar
                    open={calendarOpen}
                    anchorRect={calendarAnchor}
                    value={expiresDate}
                    min={new Date()}
                    inDialog
                    onChange={(next) => {
                      if (next) {
                        setExpiresDate(next)
                        setActivePreset('custom')
                      } else {
                        setExpiresDate(null)
                        setActivePreset(null)
                      }
                    }}
                    onClose={() => setCalendarOpen(false)}
                  />
                </div>
                {expiresDate && (
                  <div className="text-xs text-white/55">
                    Expires{' '}
                    <span className="text-white font-medium">
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
            className="bg-white/[0.06] ring-1 ring-white/15 border-0 text-white hover:bg-white/[0.12] hover:ring-white/25 transition-colors"
          >
            {saving ? 'Saving…' : 'Done'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
