'use client'

import * as React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'
import { Button } from './button'
import { cn } from '@/lib/utils'

/**
 * 1.2.0+: Reusable confirmation dialog. Replaces the native
 * `window.confirm()` for destructive / important actions so the app
 * stays visually consistent (Radix Dialog + theme tokens) instead of
 * relying on the browser's locale-flavoured grey blob.
 *
 * Typical flow:
 *   const [open, setOpen] = useState(false)
 *   <ConfirmDialog
 *     open={open}
 *     onOpenChange={setOpen}
 *     variant="destructive"
 *     title='Delete project "Foo"?'
 *     description="This is permanent — all folders, videos, and comments are removed."
 *     confirmLabel="Delete"
 *     onConfirm={async () => { await api(...) }}
 *   />
 */
export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  /** Tone of the primary button. `destructive` paints it red and tints
   *  the icon to red as well. */
  variant?: 'default' | 'destructive'
  confirmLabel?: string
  cancelLabel?: string
  /** Async or sync action. The dialog stays open until the promise
   *  resolves; the confirm button shows a spinner while pending. */
  onConfirm: () => void | Promise<void>
  /** Auto-close on confirm success. Defaults to true. Set false when
   *  the caller wants to keep the dialog open (e.g. to surface an
   *  error inline before allowing retry). */
  closeOnConfirm?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  variant = 'default',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  closeOnConfirm = true,
}: ConfirmDialogProps) {
  const [busy, setBusy] = React.useState(false)

  // Reset busy state any time the dialog closes externally so a future
  // re-open starts in a clean state.
  React.useEffect(() => {
    if (!open) setBusy(false)
  }, [open])

  const handleConfirm = async () => {
    if (busy) return
    try {
      setBusy(true)
      await onConfirm()
      if (closeOnConfirm) onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const isDestructive = variant === 'destructive'

  return (
    <Dialog open={open} onOpenChange={(next) => (!busy ? onOpenChange(next) : null)}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full',
                isDestructive
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-primary/15 text-primary',
              )}
              aria-hidden="true"
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base sm:text-lg">{title}</DialogTitle>
              {description && (
                <DialogDescription className="mt-1.5 leading-relaxed">
                  {description}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="sm:w-auto"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={isDestructive ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={busy}
            className="sm:w-auto"
            autoFocus
          >
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
