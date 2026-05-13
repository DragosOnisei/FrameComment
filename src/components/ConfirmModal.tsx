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
 */

import { AlertTriangle, Loader2 } from 'lucide-react'
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            {destructive && (
              <div className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-semibold leading-6">
                {title}
              </DialogTitle>
              {description && (
                <div className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {description}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              onOpenChange(false)
              onCancel?.()
            }}
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
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
