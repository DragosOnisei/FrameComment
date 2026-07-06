'use client'

import * as React from 'react'
import { Loader2, Pencil } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'
import { Button } from './button'
import { Input } from './input'

/**
 * 1.7.9+: Themed prompt-like dialog for renaming entities. Replaces
 * `window.prompt(...)` so the app stays visually consistent
 * instead of falling back to the browser's native gray blob.
 *
 * Typical usage:
 *   <RenameDialog
 *     open={open}
 *     onOpenChange={setOpen}
 *     title='Rename project'
 *     initialValue={project.title}
 *     onSubmit={(next) => apiPatch(...)}
 *   />
 */
export interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: React.ReactNode
  description?: React.ReactNode
  initialValue: string
  /** Placeholder shown inside the input. */
  placeholder?: string
  /** Label on the primary action. Defaults to "Rename". */
  submitLabel?: string
  /** Async or sync. Modal stays open until the promise resolves; the
   *  submit button shows a spinner while pending. Returning false
   *  (or a thrown error) keeps the modal open so the caller can
   *  surface a validation message. */
  onSubmit: (next: string) => void | boolean | Promise<void | boolean>
}

export function RenameDialog({
  open,
  onOpenChange,
  title = 'Rename',
  description,
  initialValue,
  placeholder,
  submitLabel = 'Rename',
  onSubmit,
}: RenameDialogProps) {
  const [value, setValue] = React.useState(initialValue)
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Reset the input every time the modal opens — otherwise stale
  // text from a previous open would persist.
  React.useEffect(() => {
    if (open) {
      setValue(initialValue)
      // Focus + select the entire string on next tick so the user
      // can start typing immediately (or hit Backspace to clear).
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [open, initialValue])

  const handleSubmit = React.useCallback(async () => {
    const next = value.trim()
    if (!next) return
    if (next === initialValue) {
      onOpenChange(false)
      return
    }
    setBusy(true)
    try {
      const result = await onSubmit(next)
      if (result !== false) onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }, [value, initialValue, onSubmit, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      {/* 3.8.x: v2.5 frosted-glass surface — same recipe as ShareModal
          (translucent navy + accent radial + backdrop blur) instead of
          the default flat `bg-background` card. */}
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
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <Pencil className="w-4 h-4 text-white/60" />
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="text-white/60">{description}</DialogDescription>
          )}
        </DialogHeader>
        <form
          // 1.8.0+: stopPropagation on every click inside the dialog
          // form. The dialog is rendered as a React child of the
          // caller (e.g. ProjectCardKebab's wrapper, which calls
          // e.preventDefault() on every click to block the parent
          // card's <Link>). React synthetic events bubble through
          // the React tree even though Radix portals the dialog to
          // <body> in the DOM — so without this guard the wrapper's
          // preventDefault() would cancel the default action of the
          // type="submit" button (i.e. cancel the form submission)
          // and "Rename" would silently do nothing.
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <Input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            disabled={busy}
            autoComplete="off"
            className="bg-white/[0.06] ring-1 ring-white/10 border-0 text-white placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-[hsl(var(--spotlight-tint)/0.55)]"
          />
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="bg-white/[0.06] ring-1 ring-white/15 border-0 text-white hover:bg-white/[0.12] hover:ring-white/25 transition-colors"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
