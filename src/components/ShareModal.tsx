'use client'

/**
 * ShareModal (1.0.8+).
 *
 * Frame.io-style modal that replaces the legacy "Link copied to
 * clipboard" alert. Shows the share URL prominently with a Copy
 * button, a short "Anyone with the link can view + comment" caption,
 * and a primary Done action. Future expansion: permission scope
 * (Public / Restricted), recipient input, etc. — wired in incrementally
 * as those features land on the API.
 */

import { useEffect, useState } from 'react'
import { Check, Copy, Link as LinkIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
}

export function ShareModal({
  open,
  onOpenChange,
  title,
  shareUrl,
  caption,
}: ShareModalProps) {
  const [copied, setCopied] = useState(false)

  // Reset the green check after a couple of seconds so the user can
  // re-copy without the modal needing to be re-opened.
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])

  // Drop the "copied" state whenever the modal closes so the next
  // open is always pristine.
  useEffect(() => {
    if (!open) setCopied(false)
  }, [open])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      // clipboard API blocked — fall back to a plain prompt so the
      // user can still copy manually.
      window.prompt('Copy this share link:', shareUrl)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold leading-6">
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 relative">
            <LinkIcon
              aria-hidden
              className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            />
            <Input
              value={shareUrl}
              readOnly
              onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
              className="pl-8 pr-2 truncate font-mono text-xs"
              aria-label="Share link"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant={copied ? 'outline' : 'default'}
            onClick={handleCopy}
            className="shrink-0"
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

        <div className="mt-2 text-xs text-muted-foreground">
          {caption ?? 'Anyone with this link can view and leave comments.'}
        </div>

        <div className="mt-4 flex items-center justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
