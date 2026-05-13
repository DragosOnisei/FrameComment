'use client'

/**
 * SplitVersionsModal (1.0.8+).
 *
 * Opens from the VideoCard kebab when a video group has more than
 * one version. Lets the admin tick the versions they want to extract
 * back out into their own standalone cards — undoes an accidental
 * drag-to-stack without having to re-upload anything.
 *
 * Each extracted version takes its own original filename (without
 * extension) as the new group name. The server suffixes "(2)",
 * "(3)" etc. when that name already exists in the project, then
 * renumbers what's left of the original group so its `v1..vN`
 * sequence stays contiguous.
 */

import { useEffect, useState } from 'react'
import { Loader2, Scissors } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface SplitVersionRow {
  id: string
  versionLabel?: string | null
  version?: number
  originalFileName?: string | null
  thumbnailUrl?: string | null
  createdAt?: string | Date
}

export interface SplitVersionsModalProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Display name of the version group the user is splitting. */
  groupName: string
  /** Every version row in the group, latest first. */
  versions: SplitVersionRow[]
  /** Fired with the ids the user wants to extract. */
  onSubmit: (selectedIds: string[]) => Promise<void> | void
}

function formatDate(d?: string | Date): string {
  if (!d) return ''
  try {
    const date = new Date(d)
    return date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

function stripExtension(name: string | null | undefined): string {
  if (!name) return ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function SplitVersionsModal({
  open,
  onOpenChange,
  groupName,
  versions,
  onSubmit,
}: SplitVersionsModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // Reset selection whenever the modal opens fresh so a previous
  // half-completed pick doesn't bleed into the new session.
  useEffect(() => {
    if (open) setSelected(new Set())
  }, [open])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSplit = async () => {
    if (selected.size === 0 || busy) return
    setBusy(true)
    try {
      await onSubmit(Array.from(selected))
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const allSelected =
    versions.length > 0 && selected.size === versions.length

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold leading-6 flex items-center gap-2">
            <Scissors className="w-4 h-4" />
            Split versions
          </DialogTitle>
        </DialogHeader>

        <div className="mt-2 text-sm text-muted-foreground">
          Pick the versions to extract from{' '}
          <span className="font-medium text-foreground">{groupName}</span>.
          Each one becomes its own card.
        </div>

        <div className="mt-3 max-h-[320px] overflow-y-auto -mx-1 px-1">
          <div className="rounded-lg border border-border/50 divide-y divide-border/40">
            {versions.map((v) => {
              const isOn = selected.has(v.id)
              const fileBase = stripExtension(v.originalFileName)
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => toggle(v.id)}
                  className={`w-full flex items-center gap-3 p-2.5 text-left transition-colors ${
                    isOn ? 'bg-primary/10' : 'hover:bg-muted/40'
                  }`}
                >
                  <span
                    className={`inline-flex items-center justify-center w-4 h-4 shrink-0 rounded border ${
                      isOn
                        ? 'bg-primary border-primary text-primary-foreground'
                        : 'border-border bg-background'
                    }`}
                  >
                    {isOn && (
                      <svg
                        viewBox="0 0 16 16"
                        className="w-3 h-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3 8 6.5 11.5 13 5" />
                      </svg>
                    )}
                  </span>

                  <div className="relative w-14 h-9 rounded-md bg-muted/40 ring-1 ring-border/30 overflow-hidden flex items-center justify-center shrink-0">
                    {v.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={v.thumbnailUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        {v.versionLabel ||
                          (typeof v.version === 'number' ? `v${v.version}` : '')}
                      </span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {v.versionLabel ||
                        (typeof v.version === 'number'
                          ? `v${v.version}`
                          : 'Version')}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {fileBase || '—'}
                      {v.createdAt && (
                        <span className="ml-2 tabular-nums">
                          · {formatDate(v.createdAt)}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {allSelected && versions.length > 1 && (
          <div className="mt-2 text-xs text-muted-foreground">
            You picked every version — the original group will no longer
            exist; each version becomes its own card.
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={handleSplit}
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Split {selected.size > 0 ? `(${selected.size})` : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
