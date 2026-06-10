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
      <DialogContent
        // 2.5.1+: v2.5 frosted glass treatment for the confirm
        // dialog. The base `bg-background` + solid border are
        // replaced by a translucent navy + spotlight-tinted radial
        // wash + backdrop blur — same vocabulary as Project
        // Settings panels, EmojiPicker, GlassCalendar etc. so the
        // confirmation feels native to the v2.5 system instead of
        // a flat grey box. Overlay scrim is also softened (50% black
        // + 4px blur) so the page glass behind stays partially
        // visible, reinforcing the "lifted off the page" feel.
        overlayClassName="bg-black/50 backdrop-blur-[4px]"
        className="max-w-md border-0 bg-transparent shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] ring-1 ring-white/15 text-white"
        style={{
          backgroundColor: 'rgba(22, 37, 51, 0.62)',
          backgroundImage:
            'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          transform: 'translate3d(-50%, -50%, 0)',
          willChange: 'backdrop-filter, transform',
          isolation: 'isolate',
        }}
        hideClose
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full ring-1',
                isDestructive
                  ? 'text-red-300 ring-red-400/30'
                  : 'text-primary ring-primary/30',
              )}
              style={{
                backgroundColor: isDestructive
                  ? 'rgba(248, 113, 113, 0.12)'
                  : 'hsl(var(--spotlight-tint) / 0.18)',
              }}
              aria-hidden="true"
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base sm:text-lg text-white">{title}</DialogTitle>
              {description && (
                <DialogDescription className="mt-1.5 leading-relaxed text-white/65">
                  {description}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="sm:w-auto ring-1 ring-white/15 hover:ring-white/25 text-white hover:text-white shadow-none"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              backdropFilter: 'blur(12px) saturate(140%)',
              WebkitBackdropFilter: 'blur(12px) saturate(140%)',
            }}
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
