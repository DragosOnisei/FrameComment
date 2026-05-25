'use client'

/**
 * ConfirmModal (1.0.8+).
 *
 * Frame.io-style confirmation dialog replacing the OS `window.confirm`
 * prompts we used for Delete actions. Built on top of the existing
 * Radix-based `Dialog` primitive so it inherits focus trapping,
 * overlay, escape-to-close, and accessible roles for free.
 *
 * Variants:
 *   - `default` — neutral primary button (e.g. Restore, Move).
 *   - `destructive` — red Confirm button + warning glyph in the
 *     header. Used for Delete / Empty Trash flows.
 *
 * The caller controls the modal's open state. Bind `onConfirm` /
 * `onCancel` to your handler; the modal closes itself automatically
 * after each so the caller just toggles `open` for re-open.
 *
 * 1.4.x mobile polish — the layout used to feel cramped on phones:
 *   - the default Radix X close button competed with the warning
 *     glyph and the title in the same row
 *   - the action buttons sat at the right edge in a thin justify-end
 *     row, which read as squashed in a 360 px viewport
 * Now the X is hidden (Cancel is the explicit close), the buttons
 * stack full-width on phones and only revert to the side-by-side
 * right-aligned row at `sm:+`, and the icon is always shown (default
 * variant uses an info-tinted circle instead of an empty header).
 */

import { AlertTriangle, Info, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface ConfirmModalProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: string
  description?: React.ReactNode
  /** Label for the primary action button. Defaults to "Confirm". */
  confirmLabel?: string
  /** Label for the secondary button. Defaults to "Cancel". */
  cancelLabel?: string
  /** Destructive => red Confirm button + warning icon. */
  variant?: 'default' | 'destructive'
  /** Show a spinner inside Confirm + disable both buttons. */
  busy?: boolean
  /** Fired when the user clicks Confirm. */
  onConfirm: () => void | Promise<void>
  /** Fired when the user clicks Cancel or dismisses the modal. */
  onCancel?: () => void
}

export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const destructive = variant === 'destructive'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        onOpenChange(next)
        if (!next) onCancel?.()
      }}
    >
      <DialogContent
        className="sm:max-w-md p-5 sm:p-6 gap-0"
        hideClose
      >
        <DialogHeader className="text-left">
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                destructive
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-primary/15 text-primary'
              }`}
              aria-hidden="true"
            >
              {destructive ? (
                <AlertTriangle className="h-5 w-5" />
              ) : (
                <Info className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <DialogTitle className="text-base sm:text-lg font-semibold leading-tight">
                {title}
              </DialogTitle>
              {description && (
                <div className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                  {description}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Stack buttons full-width on phones; revert to side-by-side
            right-aligned at sm+. Confirm sits on TOP on mobile so the
            primary action is the easiest thumb-reach target — matches
            standard iOS/Android sheet conventions. */}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              onOpenChange(false)
              onCancel?.()
            }}
            className="w-full sm:w-auto"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              await onConfirm()
            }}
            className="w-full sm:w-auto"
            autoFocus
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
