'use client'

import { useEffect, useState } from 'react'
import { Bug, Lightbulb, Loader2, Send } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * 7.3.1 — what the sender is told when their report is marked handled.
 *
 * Closing a report used to be a single click that told nobody anything. Someone
 * who takes the trouble to describe a bug and attach a recording has no way of
 * knowing whether it landed on a desk or in a bin, and the second time they
 * wonder that, they stop reporting. So marking one done now goes through here:
 * the report is shown again so I am answering the right one, and the note I
 * write is delivered to the sender's own notification bell.
 *
 * The note is PREFILLED but editable, which is the whole design. A blank box
 * asks a question I would answer the same way forty times; a fixed canned
 * message would be worth nothing to read. A sensible default that can be
 * rewritten in five seconds gets a real answer sent most of the time.
 *
 * Leaving the note empty is a deliberate escape hatch: the report is still
 * marked handled, and nobody is pinged. That is the right behaviour for the
 * ones I file against my own app while testing, which would otherwise ring my
 * own bell.
 *
 * NOT built on ConfirmDialog, though it looks like it. That component renders
 * its description through Radix's DialogDescription, which is a <p> — putting a
 * textarea inside one is invalid HTML and the browser closes the paragraph
 * early, which wrecks the layout. The glass treatment below is copied from it
 * deliberately so the two read as the same dialog.
 */
export type ReplyTarget = {
  id: string
  kind: string
  message: string
  userId: string | null
  userName: string | null
}

function defaultNote(kind: string, name: string | null): string {
  const who = name ? name.split(' ')[0] : 'Hi'
  return kind === 'BUG'
    ? `${who} — thank you for reporting this. It is fixed and the fix is live.`
    : `${who} — thank you for the idea. It is on the list and I will let you know when it ships.`
}

export default function FeedbackReplyDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: ReplyTarget | null
  onCancel: () => void
  onConfirm: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Re-seed every time a different report is opened, so the box never carries
  // the previous answer over to the next one.
  useEffect(() => {
    if (target) {
      setNote(target.userId ? defaultNote(target.kind, target.userName) : '')
      setBusy(false)
    }
  }, [target])

  const isBug = target?.kind === 'BUG'
  const canNotify = Boolean(target?.userId)
  const willNotify = canNotify && note.trim().length > 0

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm(willNotify ? note.trim() : '')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      <DialogContent
        overlayClassName="bg-black/50 backdrop-blur-[4px]"
        className="max-w-lg border-0 bg-transparent shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] ring-1 ring-white/15 text-white"
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
              className={`shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full ring-1 ${
                isBug ? 'text-red-300 ring-red-400/30' : 'text-primary ring-primary/30'
              }`}
              style={{
                backgroundColor: isBug
                  ? 'rgba(248, 113, 113, 0.12)'
                  : 'hsl(var(--spotlight-tint) / 0.18)',
              }}
              aria-hidden="true"
            >
              {isBug ? <Bug className="w-5 h-5" /> : <Lightbulb className="w-5 h-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base sm:text-lg text-white">
                Mark this handled
              </DialogTitle>
              <p className="mt-1.5 text-sm leading-relaxed text-white/65">
                {canNotify
                  ? `${target?.userName || 'The sender'} gets this in their notifications.`
                  : 'This report has no account attached, so nobody can be told.'}
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* What they actually wrote, so the reply is not being written blind. */}
        <div className="max-h-32 overflow-y-auto rounded-lg bg-black/25 px-3 py-2 text-sm text-white/70 ring-1 ring-white/10 [overflow-wrap:anywhere] whitespace-pre-wrap">
          {target?.message}
        </div>

        {canNotify && (
          <div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="Leave empty to close it without telling anyone"
              className="w-full resize-none rounded-lg bg-black/25 px-3 py-2 text-sm text-white placeholder:text-white/35 ring-1 ring-white/10 outline-none focus:ring-white/25"
            />
            <p className="mt-1.5 text-[11px] text-white/45">
              {willNotify
                ? `Sent to ${target?.userName || 'the sender'} as a notification.`
                : 'Nothing will be sent — the report is just marked handled.'}
            </p>
          </div>
        )}

        <DialogFooter className="mt-1">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
            className="sm:w-auto ring-1 ring-white/15 hover:ring-white/25 text-white hover:text-white shadow-none"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              backdropFilter: 'blur(12px) saturate(140%)',
              WebkitBackdropFilter: 'blur(12px) saturate(140%)',
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="sm:w-auto"
            autoFocus
          >
            {busy ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : willNotify ? (
              <Send className="w-4 h-4 mr-2" />
            ) : null}
            {willNotify ? 'Send and mark done' : 'Mark done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
