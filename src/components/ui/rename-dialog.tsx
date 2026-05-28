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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-4 h-4 text-muted-foreground" />
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription>{description}</DialogDescription>
          )}
        </DialogHeader>
        <form
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
          />
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
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
