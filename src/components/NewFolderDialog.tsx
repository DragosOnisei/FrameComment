'use client'

import { useEffect, useRef, useState } from 'react'
import { FolderPlus, FolderLock, Loader2, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Lightweight modal for creating a folder.
 *
 * Two flavours:
 *  - `restricted = false` (default) → just a name input; the folder
 *    is created with `authMode = NONE`.
 *  - `restricted = true` → also asks for a password and creates the
 *    folder with `authMode = PASSWORD`. The dialog raises
 *    `onSubmit(name, password)`; the parent makes both API calls
 *    (POST folder, PATCH folder with password) — see FolderBrowser.
 *
 * The component does NOT call the API itself, so it stays reusable
 * across the project-root page and the folder-drill page.
 */
export interface NewFolderDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the trimmed name and, when `restricted = true`,
   *  the plaintext password. Caller is responsible for the API call. */
  onSubmit: (name: string, password?: string) => Promise<void> | void
  /** Optional default name (e.g. "New Folder"). */
  defaultName?: string
  /** When true, ask for a password and label the dialog "New
   *  Restricted Folder". Used by the right-click context menu's
   *  "New Restricted Folder" action. */
  restricted?: boolean
}

export default function NewFolderDialog({
  open,
  onClose,
  onSubmit,
  defaultName = '',
  restricted = false,
}: NewFolderDialogProps) {
  const [name, setName] = useState(defaultName)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 3.3.x: tracks whether a backdrop dismiss gesture actually STARTED
  // on the backdrop, so we only close on a deliberate click-outside —
  // not on a stray release from the opening click.
  const backdropDownRef = useRef(false)

  // Reset state when the dialog opens so a previous error / value
  // doesn't bleed into the next open.
  useEffect(() => {
    if (!open) return
    setName(defaultName)
    setPassword('')
    setShowPassword(false)
    setError(null)
    setSubmitting(false)
    // Focus the name field + select-all so the user can type the
    // folder name immediately — no extra click. A single rAF wasn't
    // reliable: when the dialog is opened by clicking a "New Folder"
    // button/tile, the browser hands focus back to that trigger on
    // mouseup AFTER the rAF ran, so the input quietly lost focus. A
    // short timeout focuses once the opening click has fully settled,
    // which wins. (`autoFocus` on the input is the first-line grab;
    // this is the fallback that survives the trigger steal.)
    const id = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 60)
    return () => clearTimeout(id)
  }, [open, defaultName])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting])

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Folder name is required.')
      return
    }
    if (trimmed.length > 255) {
      setError('Folder name is too long (max 255 characters).')
      return
    }
    if (restricted && password.trim().length === 0) {
      setError('Password is required for a restricted folder.')
      return
    }
    try {
      setSubmitting(true)
      setError(null)
      await onSubmit(trimmed, restricted ? password : undefined)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder')
      setSubmitting(false)
    }
  }

  return (
    <div
      // 2.5.0+: transparent backdrop — no black tint or extra blur on
      // the page behind the dialog. The dialog itself is the visible
      // surface, frosted-glass like all other v2.5 modals.
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        // 3.3.x: record that the press began on the backdrop. We only
        // dismiss if BOTH the press and the release land on the
        // backdrop. Closing on a bare mousedown meant the dialog could
        // vanish the moment it opened: the backdrop mounts right under
        // the cursor on the opening click, and the trailing
        // mouseup/re-dispatched event was treated as an outside click —
        // so a single click "flashed" the popup and it disappeared on
        // release. Now a single click reliably opens it and it stays.
        backdropDownRef.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        const startedOnBackdrop = backdropDownRef.current
        backdropDownRef.current = false
        if (startedOnBackdrop && e.target === e.currentTarget && !submitting) {
          onClose()
        }
      }}
    >
      <form
        onSubmit={handleSubmit}
        // Frosted-glass shell, same recipe as TemplateModal /
        // GlobalSearchOverlay / Appearance pane: 6% white tint, hairline
        // white-10 ring, soft outward shadow, explicit inline
        // backdrop-filter so the blur survives any Tailwind purging.
        className="w-full max-w-md rounded-xl bg-white/[0.06] ring-1 ring-white/10 text-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.65)]"
        style={{
          backdropFilter: 'blur(20px) saturate(140%)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        {/* 2.5.0+: header is just the title — close (X) was dropped
            since Cancel in the footer already covers that affordance
            and Esc still closes the dialog. */}
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-lg font-semibold inline-flex items-center gap-2">
            {restricted ? (
              <FolderLock className="w-5 h-5 text-primary" />
            ) : (
              <FolderPlus className="w-5 h-5 text-primary" />
            )}
            {restricted ? 'New Restricted Folder' : 'New Folder'}
          </h2>
        </div>

        <div className="px-5 pb-5">
          <label className="block text-sm font-medium text-white mb-1.5">
            Name
          </label>
          <input
            ref={inputRef}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="01_Brand_Spots"
            maxLength={255}
            disabled={submitting}
            className="w-full rounded-lg bg-white/[0.04] ring-1 ring-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          {restricted && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-white mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter a password"
                  disabled={submitting}
                  className="w-full rounded-lg bg-white/[0.04] ring-1 ring-white/10 pl-3 pr-10 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-white/55 hover:text-white"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="mt-2 text-xs text-destructive">{error}</p>
          )}
          {/* 2.5.0+: helper text for the non-restricted case was
              dropped — the default flow is "just create with no
              password" and the share password lives in folder
              settings, which the user can discover from there.
              For the restricted variant we keep the hint because
              the password is being entered RIGHT HERE. */}
          {restricted && (
            <p className="mt-2 text-[11px] text-white/55">
              Viewers will need this password to open the folder share link. You can change or remove it later.
            </p>
          )}
        </div>

        {/* 2.5.0+: dropped the footer's own glass tile / ring /
            shadow — the buttons sit directly on the dialog surface
            now, so the visual hierarchy is just popup → button →
            text. Less chrome, less competing layers. */}
        <div className="px-5 pb-5 flex items-center justify-center gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
            // Cancel gets its own glass tile + ring so it reads as a
            // proper sibling button next to Create folder instead of
            // plain text. Layered shadow recipe mirrors the primary
            // button (minus the brand-blue tint) so the hierarchy
            // stays popup → footer → button → text.
            className="text-white/90 bg-white/[0.06] hover:bg-white/[0.12] hover:text-white ring-1 ring-white/15 hover:ring-white/25 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.08)] hover:shadow-[0_4px_12px_-2px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.12)] border-0"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting || !name.trim()}
            // Inline `color` wins over the `.btn-primary` rule in
            // globals.css that pins text to `hsl(var(--primary-
            // foreground))`. On dark theme that's already white, but
            // depending on browser composition + opacity layering it
            // can read as a muted gray. Forcing #fff inline guarantees
            // the topmost-layer feel the layered shadow stack is
            // building up to.
            style={{ color: '#ffffff' }}
            className="font-semibold shadow-[0_4px_12px_-2px_hsl(var(--primary)/0.55),0_0_0_1px_hsl(var(--primary)/0.5),inset_0_1px_0_rgba(255,255,255,0.18)] hover:shadow-[0_6px_18px_-2px_hsl(var(--primary)/0.65),0_0_0_1px_hsl(var(--primary)/0.6),inset_0_1px_0_rgba(255,255,255,0.22)] disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating…
              </>
            ) : (
              'Create folder'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
