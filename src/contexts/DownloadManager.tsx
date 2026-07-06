'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'

/**
 * 2.0.x+: in-app download manager.
 *
 * Wraps every long-running download in a job entry so the user can see
 * a percentage + Cancel button in the bottom-right banner stack
 * (`<DownloadBanners />`). Three call sites use it today:
 *
 *   - admin folder ZIP download (`/api/folders/[id]/download`)
 *   - public share folder ZIP download (`/api/share/folder/[slug]/download`)
 *   - bulk multi-video download (loops single-video saves)
 *
 * Two modes:
 *
 *   - `kind: 'stream'` — single streamed response (the folder ZIPs).
 *     Caller supplies `url`, optionally `statUrl` for the total size,
 *     and an `apiFetch`-like requester. The manager fetches, reads the
 *     body chunk-by-chunk, accumulates a blob, and triggers an
 *     `<a download>` save when the stream ends. Progress comes from
 *     `bytesReceived / totalBytes`.
 *
 *   - `kind: 'manual'` — caller controls iteration (e.g. multi-video
 *     download iterating per-clip endpoints). The job tracks
 *     `completed / total` items instead of bytes. Caller calls
 *     `bumpItem(jobId)` after each item finishes; the cancel signal is
 *     surfaced via `signal` so the caller can break the loop.
 *
 * Multiple jobs run in parallel and stack vertically in the banner.
 */

export type DownloadJobStatus =
  | 'pending'   // fetching stats / waiting for first byte
  | 'active'    // bytes / items flowing
  | 'success'   // done — banner fades + auto-removes after a beat
  | 'error'     // failed — banner shows error, user dismisses manually
  | 'cancelled' // user hit Cancel — banner fades + auto-removes

export type DownloadJob = {
  id: string
  label: string
  // 3.9.x: 'task' is an indeterminate, server-driven job (e.g. a
  // single-video thumbnail regenerate). No byte/item totals — the
  // banner shows a spinner + `sublabel` status line and the caller
  // resolves it with `finish()` once it observes completion.
  kind: 'stream' | 'manual' | 'task'
  status: DownloadJobStatus
  /** Bytes received from server (kind='stream'). */
  bytesReceived?: number
  /** Total bytes estimate from /stat endpoint (kind='stream'). */
  totalBytes?: number
  /** Items completed (kind='manual'). */
  completedItems?: number
  /** Total items (kind='manual'). */
  totalItems?: number
  /** 3.3.x: unit noun for the progress label (kind='manual').
   *  Defaults to "files"; the Trash flow passes "items". */
  unit?: string
  /** 3.3.x: which glyph the banner shows. Defaults to a download
   *  arrow; the Trash flow passes 'trash'. 3.9.x adds 'refresh' for
   *  the thumbnail-regenerate task. */
  icon?: 'download' | 'trash' | 'refresh'
  /** 3.9.x: status line for `kind='task'` jobs (e.g.
   *  "Regenerating thumbnail…" → "Thumbnail updated"). Ignored for
   *  stream/manual jobs, which derive their status from progress. */
  sublabel?: string
  /** Error message — set when status='error'. */
  error?: string
  /** Stable reference to the underlying controller so the banner can
   *  call `cancel(id)` without us re-instantiating one per render. */
  abortController: AbortController
}

type StartStreamOpts = {
  /** Short label shown in the banner (e.g. "Folder.zip"). */
  label: string
  /** Endpoint to fetch. */
  url: string
  /** Optional stat endpoint hit BEFORE the main download. Should
   *  respond with `{ totalBytes: string|number, fileCount?: number,
   *  folderName?: string }`. */
  statUrl?: string
  /** Custom fetch (e.g. apiFetch adds Bearer auth). Defaults to
   *  `window.fetch`. */
  fetcher?: (input: RequestInfo, init?: RequestInit) => Promise<Response>
  /** Optional fallback filename if Content-Disposition isn't set. */
  fallbackFilename?: string
}

type StartManualOpts = {
  label: string
  totalItems: number
  /** 3.3.x: unit noun shown in the banner ("files" default, "items"
   *  for the Trash flow). */
  unit?: string
  /** 3.3.x: banner glyph. Defaults to the download arrow. */
  icon?: 'download' | 'trash'
}

type StartTaskOpts = {
  /** Title line (e.g. the video name). */
  label: string
  /** Initial status line (e.g. "Regenerating thumbnail…"). */
  sublabel?: string
  /** Banner glyph. Defaults to the download arrow; the thumbnail
   *  regenerate flow passes 'refresh' for a spinning icon. */
  icon?: 'download' | 'trash' | 'refresh'
}

type DownloadManagerCtx = {
  jobs: DownloadJob[]
  /** Start a streamed ZIP download. Returns the jobId. */
  startStreamDownload: (opts: StartStreamOpts) => string
  /** Start a manual job (caller drives item iteration). Returns
   *  { jobId, signal, bumpItem, finish } so the caller can wire
   *  cancel + per-item progress + final result. */
  startManualDownload: (opts: StartManualOpts) => {
    jobId: string
    signal: AbortSignal
    bumpItem: () => void
    finish: (status: 'success' | 'error', errorMsg?: string) => void
  }
  /** 3.9.x: start an indeterminate task banner (no progress bar %).
   *  Returns { jobId, update, finish } so the caller can retitle the
   *  status line while it runs and resolve it when done. */
  startTask: (opts: StartTaskOpts) => {
    jobId: string
    update: (sublabel: string) => void
    finish: (status: 'success' | 'error', sublabelOrError?: string) => void
  }
  /** User-initiated cancel. Aborts the underlying controller, marks
   *  the job cancelled, and schedules its removal. */
  cancel: (jobId: string) => void
  /** Manually dismiss a finished/errored banner. */
  dismiss: (jobId: string) => void
}

const Ctx = createContext<DownloadManagerCtx | null>(null)

export function DownloadManagerProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  // We keep the jobs map in a ref too so the streaming reader (which
  // captures the jobId at start) can patch the entry without depending
  // on the React state closure. Single source of truth for reads is
  // still `jobs`; the ref just lets the producer write through.
  const jobsRef = useRef<Map<string, DownloadJob>>(new Map())

  const patchJob = useCallback((jobId: string, patch: Partial<DownloadJob>) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, ...patch } : j)),
    )
    const current = jobsRef.current.get(jobId)
    if (current) {
      jobsRef.current.set(jobId, { ...current, ...patch })
    }
  }, [])

  const removeJob = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId))
    jobsRef.current.delete(jobId)
  }, [])

  const dismiss = useCallback((jobId: string) => {
    removeJob(jobId)
  }, [removeJob])

  const cancel = useCallback(
    (jobId: string) => {
      const job = jobsRef.current.get(jobId)
      if (!job) return
      try {
        job.abortController.abort()
      } catch {
        // ignore — already aborted
      }
      patchJob(jobId, { status: 'cancelled' })
      // Give the user a beat to register the cancel state in the UI
      // before the banner pops.
      setTimeout(() => removeJob(jobId), 1500)
    },
    [patchJob, removeJob],
  )

  const startStreamDownload = useCallback(
    (opts: StartStreamOpts) => {
      const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const abortController = new AbortController()
      const fetcher = opts.fetcher || ((input, init) => window.fetch(input, init))
      const job: DownloadJob = {
        id: jobId,
        label: opts.label,
        kind: 'stream',
        status: 'pending',
        bytesReceived: 0,
        abortController,
      }
      jobsRef.current.set(jobId, job)
      setJobs((prev) => [...prev, job])

      ;(async () => {
        try {
          // 1) Hit /stat for a total — non-blocking if it fails.
          if (opts.statUrl) {
            try {
              const statRes = await fetcher(opts.statUrl, {
                signal: abortController.signal,
              })
              if (statRes.ok) {
                const stat = await statRes.json()
                const total = parseInt(String(stat.totalBytes || 0), 10) || 0
                patchJob(jobId, {
                  totalBytes: total,
                  // Use the server-reported name if richer than what
                  // the caller passed.
                  label: stat.folderName ? `${stat.folderName}.zip` : opts.label,
                })
              }
            } catch {
              // ignore — we'll just show a spinner without a percentage
            }
          }
          if (abortController.signal.aborted) return

          // 2) Stream the ZIP. We read chunks manually so we can bump
          // bytesReceived as bytes arrive.
          const res = await fetcher(opts.url, {
            signal: abortController.signal,
          })
          if (!res.ok) {
            let msg = `HTTP ${res.status}`
            try {
              const body = await res.json()
              if (body?.error) msg = body.error
            } catch {
              /* ignore */
            }
            patchJob(jobId, { status: 'error', error: msg })
            return
          }

          patchJob(jobId, { status: 'active' })

          const reader = res.body?.getReader()
          if (!reader) {
            patchJob(jobId, { status: 'error', error: 'Browser doesn\'t support streaming' })
            return
          }

          const chunks: Uint8Array[] = []
          let received = 0
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              chunks.push(value)
              received += value.byteLength
              // Throttle UI updates to ~10 Hz to keep React happy
              // when the network is fast (gigabit local).
              patchJob(jobId, { bytesReceived: received })
            }
            if (abortController.signal.aborted) {
              try { await reader.cancel() } catch {}
              return
            }
          }

          // 3) Build the blob + trigger save.
          const blob = new Blob(chunks as BlobPart[], {
            type: res.headers.get('content-type') || 'application/zip',
          })
          const cd = res.headers.get('content-disposition') || ''
          const match = cd.match(/filename\*?="?([^";]+)"?/i)
          const filename = match?.[1] || opts.fallbackFilename || 'download.zip'
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = filename
          a.rel = 'noopener'
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1500)

          patchJob(jobId, { status: 'success' })
          // Auto-fade success banners.
          setTimeout(() => removeJob(jobId), 2500)
        } catch (err: any) {
          if (err?.name === 'AbortError') {
            // Cancel path already updates status; nothing to do.
            return
          }
          patchJob(jobId, {
            status: 'error',
            error: err?.message || 'Download failed',
          })
        }
      })()

      return jobId
    },
    [patchJob, removeJob],
  )

  const startManualDownload = useCallback(
    (opts: StartManualOpts) => {
      const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const abortController = new AbortController()
      const job: DownloadJob = {
        id: jobId,
        label: opts.label,
        kind: 'manual',
        status: 'active',
        completedItems: 0,
        totalItems: opts.totalItems,
        unit: opts.unit,
        icon: opts.icon,
        abortController,
      }
      jobsRef.current.set(jobId, job)
      setJobs((prev) => [...prev, job])

      const bumpItem = () => {
        const current = jobsRef.current.get(jobId)
        if (!current) return
        const next = (current.completedItems ?? 0) + 1
        patchJob(jobId, { completedItems: next })
      }
      const finish = (status: 'success' | 'error', errorMsg?: string) => {
        patchJob(jobId, { status, error: errorMsg })
        const delay = status === 'success' ? 2500 : 5000
        setTimeout(() => removeJob(jobId), delay)
      }
      return { jobId, signal: abortController.signal, bumpItem, finish }
    },
    [patchJob, removeJob],
  )

  const startTask = useCallback(
    (opts: StartTaskOpts) => {
      const jobId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      // Tasks don't stream anything, but the job shape wants a
      // controller — we keep a dummy one so the banner's Cancel/
      // dismiss plumbing stays uniform.
      const abortController = new AbortController()
      const job: DownloadJob = {
        id: jobId,
        label: opts.label,
        kind: 'task',
        status: 'active',
        sublabel: opts.sublabel,
        icon: opts.icon,
        abortController,
      }
      jobsRef.current.set(jobId, job)
      setJobs((prev) => [...prev, job])

      const update = (sublabel: string) => patchJob(jobId, { sublabel })
      const finish = (
        status: 'success' | 'error',
        sublabelOrError?: string,
      ) => {
        if (status === 'error') {
          patchJob(jobId, { status, error: sublabelOrError })
        } else {
          patchJob(jobId, {
            status,
            sublabel: sublabelOrError ?? job.sublabel,
          })
        }
        const delay = status === 'success' ? 2500 : 5000
        setTimeout(() => removeJob(jobId), delay)
      }
      return { jobId, update, finish }
    },
    [patchJob, removeJob],
  )

  const value = useMemo<DownloadManagerCtx>(
    () => ({
      jobs,
      startStreamDownload,
      startManualDownload,
      startTask,
      cancel,
      dismiss,
    }),
    [jobs, startStreamDownload, startManualDownload, startTask, cancel, dismiss],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDownloadManager() {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error('useDownloadManager must be used within DownloadManagerProvider')
  }
  return ctx
}
