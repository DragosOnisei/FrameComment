'use client'

import { useEffect, useRef, useState } from 'react'
import { X, FolderPlus, FolderLock, Loader2, Eye, EyeOff } from 'lucide-react'
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

  // Reset state when the dialog opens so a previous error / value
  // doesn't bleed into the next open.
  useEffect(() => {
    if (open) {
      setName(defaultName)
      setPassword('')
      setShowPassword(false)
      setError(null)
      setSubmitting(false)
      // Focus the input + select all so the user can just start typing.
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Only close on backdrop click — not on dialog content click.
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl bg-card text-card-foreground border border-border shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-lg font-semibold inline-flex items-center gap-2">
            {restricted ? (
              <FolderLock className="w-5 h-5 text-primary" />
            ) : (
              <FolderPlus className="w-5 h-5 text-primary" />
            )}
            {restricted ? 'New Restricted Folder' : 'New Folder'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5">
          <label className="block text-sm font-medium text-foreground/90 mb-1.5">
            Name
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="01_Brand_Spots"
            maxLength={255}
            disabled={submitting}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          {restricted && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-foreground/90 mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter a password"
                  disabled={submitting}
                  className="w-full rounded-md border border-border bg-background pl-3 pr-10 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground"
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
          <p className="mt-2 text-[11px] text-muted-foreground">
            {restricted
              ? 'Viewers will need this password to open the folder share link. You can change or remove it later.'
              : 'Folder is created with no share password. You can change that later from the folder settings.'}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20 rounded-b-xl">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !name.trim()}>
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
