'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bug, Lightbulb, Loader2, Check, RefreshCw, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { logError } from '@/lib/logging'
import { InitialsAvatar } from '@/components/InitialsAvatar'
import { formatDateTime } from '@/lib/utils'
import ClientBadge from '@/components/founder/ClientBadge'
import FeedbackAttachment from '@/components/founder/FeedbackAttachment'
import FeedbackReplyDialog, { type ReplyTarget } from '@/components/founder/FeedbackReplyDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

/**
 * 7.3.0 — the founder's feedback inbox.
 *
 * One list across every organisation, because that is the whole point of
 * collecting it: the tenth report of the same broken thing is only recognisable
 * as the tenth if they sit together. The API this reads is the only place these
 * rows are exposed, and it is founder-gated — see requirePlatformAdmin.
 *
 * Deliberately plain. There is no triage board, no assignment, no tags: a list
 * with three states is the smallest thing that answers "what is waiting for me",
 * and inventing a workflow before there is any traffic would be furniture for a
 * room nobody has walked into yet.
 */
type Attachment = {
  id: string
  fileName: string
  fileType: string
  fileSize: string
}

type FeedbackRow = {
  id: string
  kind: 'BUG' | 'IDEA' | string
  message: string
  status: 'NEW' | 'READ' | 'DONE' | string
  userId: string | null
  userName: string | null
  userEmail: string | null
  organizationName: string | null
  appVersion: string | null
  pageUrl: string | null
  client: string | null
  createdAt: string
  attachments: Attachment[]
}

export default function FounderFeedbackPage() {
  const [items, setItems] = useState<FeedbackRow[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  // 7.3.1: marking a report handled goes through a dialog now, so this holds
  // the one being answered. Deleting holds the one being confirmed.
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FeedbackRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/feedback')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(Array.isArray(data?.items) ? data.items : [])
      setUnread(typeof data?.unread === 'number' ? data.unread : 0)
    } catch (err) {
      logError('[founder] loading feedback failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setStatus = async (id: string, status: FeedbackRow['status'], note?: string) => {
    setBusyId(id)
    try {
      const res = await apiFetch(`/api/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // An empty note is left out entirely rather than sent as "": the route
        // reads its absence as "tell nobody", which is what an empty box means.
        body: JSON.stringify(note ? { status, note } : { status }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Patch locally AND recount, so the badge and the row never disagree.
      setItems((cur) => cur.map((r) => (r.id === id ? { ...r, status } : r)))
      setUnread((cur) =>
        status === 'NEW' ? cur + 1 : Math.max(0, cur - 1),
      )
    } catch (err) {
      logError('[founder] changing feedback status failed:', err, id)
      void load()
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 7.3.1: throwing a report away, files and all.
   *
   * Removed from the list here rather than by reloading, so the row does not
   * flash back in for the length of a round trip. The unread badge is corrected
   * in the same breath — deleting the last NEW report has to leave the count at
   * zero, or the header keeps promising something that is no longer there.
   */
  const deleteFeedback = async (row: FeedbackRow) => {
    setBusyId(row.id)
    try {
      const res = await apiFetch(`/api/feedback/${row.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setItems((cur) => cur.filter((r) => r.id !== row.id))
      if (row.status === 'NEW') setUnread((cur) => Math.max(0, cur - 1))
    } catch (err) {
      logError('[founder] deleting feedback failed:', err, row.id)
      void load()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex-1 min-h-0">
      <div className="max-w-screen-lg mx-auto px-3 sm:px-4 lg:px-6 py-4 sm:py-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl sm:text-3xl font-bold">
            Feedback
            {unread > 0 && (
              <span className="ml-2 align-middle inline-flex items-center rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                {unread} new
              </span>
            )}
          </h1>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-sm text-white/80 ring-1 ring-white/10 hover:bg-white/[0.12]"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        {loading && items.length === 0 && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="rounded-xl bg-white/[0.03] ring-1 ring-white/10 px-6 py-8 text-center">
            <p className="text-sm font-medium text-foreground/85">Nothing yet</p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Reports and ideas sent from inside the app land here.
            </p>
          </div>
        )}

        {items.map((row) => {
          const isBug = row.kind === 'BUG'
          return (
            <article
              key={row.id}
              className={`rounded-xl p-4 ring-1 transition-colors ${
                row.status === 'NEW'
                  ? 'bg-white/[0.06] ring-primary/40'
                  : 'bg-white/[0.03] ring-white/10'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    isBug
                      ? 'bg-destructive/15 text-destructive ring-1 ring-destructive/30'
                      : 'bg-primary/15 text-primary ring-1 ring-primary/30'
                  }`}
                  title={isBug ? 'Bug' : 'Idea'}
                >
                  {isBug ? <Bug className="h-4 w-4" /> : <Lightbulb className="h-4 w-4" />}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                    <InitialsAvatar name={row.userName} size="sm" />
                    <span className="font-medium text-foreground/90">
                      {row.userName || 'Unknown'}
                    </span>
                    {row.organizationName && <span>· {row.organizationName}</span>}
                    <span>· {formatDateTime(new Date(row.createdAt))}</span>
                    {row.appVersion && <span>· v{row.appVersion}</span>}
                  </div>

                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground/90">
                    {row.message}
                  </p>

                  <ClientBadge
                    client={row.client}
                    className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
                  />

                  {row.attachments.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {row.attachments.map((a) => (
                        <FeedbackAttachment
                          key={a.id}
                          feedbackId={row.id}
                          attachmentId={a.id}
                          fileName={a.fileName}
                          fileType={a.fileType}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-col gap-1.5">
                  {row.status !== 'DONE' ? (
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      /* 7.3.1: the dialog, not the change. Closing a report is
                         the moment the sender hears back, so it is worth one
                         extra click. */
                      onClick={() =>
                        setReplyTarget({
                          id: row.id,
                          kind: row.kind,
                          message: row.message,
                          userId: row.userId,
                          userName: row.userName,
                        })
                      }
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-xs text-white/80 ring-1 ring-white/10 hover:bg-white/[0.12] disabled:opacity-40"
                    >
                      {busyId === row.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Done
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      /* Straight through, no dialog: putting a report back in
                         the list corrects my own bookkeeping and is not news
                         to the person who sent it. */
                      onClick={() => void setStatus(row.id, 'NEW')}
                      className="inline-flex h-8 items-center rounded-lg bg-emerald-500/15 px-2.5 text-xs text-emerald-300 ring-1 ring-emerald-400/30 hover:bg-emerald-500/25 disabled:opacity-40"
                      title="Put it back in the list"
                    >
                      Done
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => setPendingDelete(row)}
                    title="Delete this report"
                    aria-label="Delete this report"
                    className="inline-flex h-8 items-center justify-center rounded-lg bg-white/[0.04] px-2.5 text-xs text-white/45 ring-1 ring-white/10 hover:bg-destructive/15 hover:text-destructive hover:ring-destructive/30 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </div>

      <FeedbackReplyDialog
        target={replyTarget}
        onCancel={() => setReplyTarget(null)}
        onConfirm={async (note) => {
          const id = replyTarget?.id
          setReplyTarget(null)
          if (id) await setStatus(id, 'DONE', note)
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        variant="destructive"
        title="Delete this report?"
        description={
          pendingDelete?.attachments.length
            ? `The report and its ${pendingDelete.attachments.length === 1 ? 'attachment' : `${pendingDelete.attachments.length} attachments`} are removed for good. This cannot be undone.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={async () => {
          const row = pendingDelete
          setPendingDelete(null)
          if (row) await deleteFeedback(row)
        }}
      />
    </div>
  )
}
