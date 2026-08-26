'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, Lightbulb, MessageSquarePlus, Paperclip, X, Loader2, Check } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { logError } from '@/lib/logging'
import { cn } from '@/lib/utils'

/**
 * 7.3.0 — a way to say "this is broken" or "this should exist" from inside the
 * product, at the moment of noticing.
 *
 * Feedback that has to be written in an email later is feedback that mostly is
 * not written. The button sits out of the way, bottom right, and the panel asks
 * for two things: which kind, and what happened. Everything else — who, which
 * build, which page, which browser — is collected without asking, because a
 * report is far more useful with that context and nobody types it voluntarily.
 *
 * Attachments matter more than the text for a visual bug: a screenshot of the
 * wrong layout, or a recording of a glitch that only exists in motion. They are
 * uploaded after the report exists, one at a time, so a failed file leaves a
 * report that still says something rather than losing the lot.
 *
 * Admin chrome only — mounted from the admin layout, so a client on a share
 * link never sees it. That was a deliberate scoping decision, not an oversight:
 * opening it to the public share would be a public write endpoint with the spam
 * surface that implies.
 */
type Kind = 'BUG' | 'IDEA'

const MAX_FILES = 4
const MAX_BYTES = 25 * 1024 * 1024

export default function FeedbackButton() {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<Kind>('BUG')
  const [message, setMessage] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, sending])

  const reset = () => {
    setKind('BUG')
    setMessage('')
    setFiles([])
    setError(null)
    setSent(false)
  }

  const addFiles = (picked: FileList | null) => {
    if (!picked) return
    const next: File[] = []
    for (const f of Array.from(picked)) {
      if (f.size > MAX_BYTES) {
        setError(`${f.name} is over 25MB`)
        continue
      }
      next.push(f)
    }
    setFiles((cur) => [...cur, ...next].slice(0, MAX_FILES))
  }

  const submit = async () => {
    if (sending || message.trim().length < 3) return
    setSending(true)
    setError(null)
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          message: message.trim(),
          pageUrl: typeof window !== 'undefined' ? window.location.href.slice(0, 2000) : undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const { id } = await res.json()

      // One at a time, and never fatal. A report that arrived without its
      // screenshot is still a report; losing the words because an upload timed
      // out would be the worse trade.
      for (const file of files) {
        try {
          const form = new FormData()
          form.append('file', file)
          const up = await apiFetch(`/api/feedback/${id}/attachments`, {
            method: 'POST',
            body: form,
          })
          if (!up.ok) throw new Error(`HTTP ${up.status}`)
        } catch (err) {
          logError('[feedback] one attachment did not upload:', err, file.name)
          setError(`Sent, but ${file.name} did not upload.`)
        }
      }

      setSent(true)
      setMessage('')
      setFiles([])
      // Long enough to read the confirmation, short enough not to sit there.
      setTimeout(() => {
        setOpen(false)
        reset()
      }, 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send feedback')
    } finally {
      setSending(false)
    }
  }

  if (!mounted) return null

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Send feedback"
          aria-label="Send feedback"
          className="fixed bottom-4 right-4 z-[2147483500] inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)] ring-1 ring-white/15 transition-transform hover:scale-105 active:scale-95"
        >
          <MessageSquarePlus className="h-5 w-5" />
        </button>
      )}

      {open && (
        <div className="brand-menu-surface fixed bottom-4 right-4 z-[2147483500] w-[min(380px,calc(100vw-2rem))] rounded-xl p-3 text-white ring-1 ring-white/10 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">Send feedback</span>
            <button
              type="button"
              onClick={() => !sending && setOpen(false)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {sent ? (
            <div className="flex items-center gap-2 py-6 text-sm text-emerald-300">
              <Check className="h-4 w-4" />
              Thank you — it reached the founder.
            </div>
          ) : (
            <>
              <div className="mt-3 flex gap-2">
                {(
                  [
                    { k: 'BUG' as const, label: 'Something is broken', Icon: Bug },
                    { k: 'IDEA' as const, label: 'An idea', Icon: Lightbulb },
                  ]
                ).map(({ k, label, Icon }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn(
                      'flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium ring-1 transition-colors',
                      kind === k
                        ? 'bg-primary text-primary-foreground ring-primary'
                        : 'bg-white/[0.06] text-white/75 ring-white/10 hover:bg-white/[0.12]',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={5000}
                placeholder={
                  kind === 'BUG'
                    ? 'What did you do, and what happened instead?'
                    : 'What would you like to be able to do?'
                }
                className="mt-2 w-full resize-none rounded-lg bg-black/25 px-2.5 py-2 text-sm text-white placeholder:text-white/35 ring-1 ring-white/10 outline-none focus:ring-white/25"
              />

              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((f, i) => (
                    <li
                      key={`${f.name}-${i}`}
                      className="flex items-center gap-2 rounded-md bg-white/[0.06] px-2 py-1 text-[11px] text-white/75"
                    >
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                        className="text-white/50 hover:text-white"
                        aria-label={`Remove ${f.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}

              <div className="mt-3 flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={files.length >= MAX_FILES}
                  title="Attach a screenshot or a short recording"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-xs text-white/75 ring-1 ring-white/10 hover:bg-white/[0.12] disabled:opacity-40"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Attach
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={sending || message.trim().length < 3}
                  className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                >
                  {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>,
    document.body,
  )
}
