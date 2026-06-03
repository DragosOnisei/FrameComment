'use client'

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { apiFetch } from '@/lib/api-client'
import { logError } from '@/lib/logging'

/**
 * 2.0.x+: shared state for the bottom-right "Uploading X/Y" and
 * "Processing X/Y" banners. Polls /api/processing-status every
 * few seconds while the admin shell is open, and keeps a
 * high-water-mark (`hwm`) for the denominator so the banner can
 * read as "21 of 67 done" instead of "21 left to do, who knows
 * how many we started with".
 *
 * The HWM resets when both counts hit 0 for ~5 seconds. That
 * lets the banner show a brief "All done!" state, then disappear
 * cleanly. If a new batch starts within that window, we just
 * keep growing the HWM.
 *
 * Polling interval is fast (3 s) when there's any active work,
 * slower (15 s) when idle — to catch the "someone just started a
 * bulk-upload.mjs run on their Mac" case without hammering the
 * DB.
 */
export type ProcessingVideo = {
  id: string
  name: string
  versionLabel: string
  thumbnailPath: string | null
  /** Signed `/api/content/<token>` URL — null until the worker
   *  generates the instant thumbnail. Used by the banner's
   *  expanded list to show a small poster image per row. */
  thumbnailUrl: string | null
  /** Pixel dimensions written by the worker after ffprobe. Used
   *  client-side to render the thumbnail at the original aspect
   *  ratio (portrait vs landscape). null while the worker hasn't
   *  inspected the file yet — fall back to 16:9. */
  width: number | null
  height: number | null
  status: 'UPLOADING' | 'PROCESSING' | 'READY'
  createdAt: string
  projectId: string
  projectTitle: string
  folderId: string | null
  /** 0..100. Bytes-sent / total for UPLOADING rows (set by TUS clients). */
  uploadProgress: number
  /** 0..100. Overall transcode progress across all tiers for PROCESSING rows. */
  processingProgress: number
  /**
   * 2.2.6+: tier ladder snapshot.
   *
   *   - `plannedTiers` is what `prepare-video` decided based on
   *     the source resolution + project's previewResolution cap
   *     (eg `["480p","720p","1080p"]`).
   *   - `completedTiers` is the subset the worker has actually
   *     finished encoding so far (eg `["480p"]`).
   *
   * Subtracting completedTiers from plannedTiers and taking the
   * first remaining entry gives the tier currently being worked
   * on — which is what the banner pip surfaces as SD/HD/HD+/4K.
   * Both null on legacy rows produced before the 2.2.0 schema
   * migration; the pip falls back to a generic pulse for those.
   */
  plannedTiers: string[] | null
  completedTiers: string[] | null
  /**
   * 2.2.6+: per-tier ffmpeg progress, eg `{ "720p": 50 }`.
   * Updated atomically by the worker on every ffmpeg progress
   * tick. The banner reads this to paint a smooth overall
   * progress; without it the bar stayed at 0% until the row
   * flipped to READY and jumped straight to 100. NULL for
   * pre-2.2.0 rows / freshly-uploaded rows the worker hasn't
   * touched yet.
   */
  transcodeProgressByTier: Record<string, unknown> | null
  /**
   * True when this video is currently being worked on by a BullMQ
   * processor (vs sitting in `wait` waiting for a free slot).
   * Derived from `queue.getActive()` on the server.
   */
  isActive: boolean
}

type StatusResponse = {
  uploading: { count: number; videos: ProcessingVideo[] }
  processing: { count: number; videos: ProcessingVideo[] }
}

type StatusValue = {
  uploadingCount: number
  uploadingHwm: number
  uploadingVideos: ProcessingVideo[]
  processingCount: number
  processingHwm: number
  processingVideos: ProcessingVideo[]
  /** Force a one-off refetch (e.g. right after the user uploads). */
  refetch: () => void
}

const ProcessingStatusCtx = createContext<StatusValue | null>(null)

const ACTIVE_INTERVAL_MS = 3_000
const IDLE_INTERVAL_MS = 15_000
const HWM_RESET_DELAY_MS = 5_000

export function ProcessingStatusProvider({ children }: { children: ReactNode }) {
  const [uploadingCount, setUploadingCount] = useState(0)
  const [uploadingHwm, setUploadingHwm] = useState(0)
  const [uploadingVideos, setUploadingVideos] = useState<ProcessingVideo[]>([])
  const [processingCount, setProcessingCount] = useState(0)
  const [processingHwm, setProcessingHwm] = useState(0)
  const [processingVideos, setProcessingVideos] = useState<ProcessingVideo[]>([])

  // Track the most recent fetch sequence so an in-flight poll
  // can't clobber a newer one when the user mashes refetch().
  const fetchSeqRef = useRef(0)
  // 2.1.7+: Each banner gets its OWN HWM reset clock so the
  // upload banner can disappear the moment uploads finish even
  // if processing is still chewing through the queue. Previously
  // a single shared `idleSinceRef` waited for upload+processing
  // to BOTH hit zero — so when a user finished uploading a 50-
  // file batch, the "All uploads complete" banner stuck around
  // for the next 5+ minutes of NVENC encoding. Splitting the
  // clocks lets each banner dismiss independently.
  const uploadingIdleSinceRef = useRef<number | null>(null)
  const processingIdleSinceRef = useRef<number | null>(null)
  const aliveRef = useRef(true)

  const fetchStatus = async () => {
    const seq = ++fetchSeqRef.current
    try {
      // 2.3.1+: `cache: 'no-store'` mirrors the server-side
      // `Cache-Control: no-store` on /api/processing-status. The
      // production-only freeze where the banner sat on the same
      // 75% / HD+ snapshot across multiple polls was traced to
      // the browser's heuristic GET cache returning the first
      // response to every subsequent fetch. Local dev was
      // immune because Next.js dev mode disables route caching
      // and emits no-cache headers automatically.
      const res = await apiFetch('/api/processing-status', { cache: 'no-store' })
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      if (!res.ok) {
        // 401 means we got logged out — don't spam the console
        // with errors. Just silently bail; the AdminHeader will
        // bounce the user to /login soon enough.
        if (res.status !== 401) {
          logError(`[ProcessingStatus] fetch failed: ${res.status}`)
        }
        return
      }
      const data = (await res.json()) as StatusResponse
      if (seq !== fetchSeqRef.current || !aliveRef.current) return

      const uc = data.uploading?.count ?? 0
      const pc = data.processing?.count ?? 0
      setUploadingCount(uc)
      setUploadingVideos(data.uploading?.videos || [])
      setProcessingCount(pc)
      setProcessingVideos(data.processing?.videos || [])

      // HWM bookkeeping (2.1.7+). Per-banner clocks so each
      // surface dismisses independently — the upload banner
      // doesn't wait for processing to finish before fading out.
      const now = Date.now()
      if (uc > 0) {
        uploadingIdleSinceRef.current = null
        setUploadingHwm((prev) => Math.max(prev, uc))
      } else {
        if (uploadingIdleSinceRef.current === null) {
          uploadingIdleSinceRef.current = now
        } else if (now - uploadingIdleSinceRef.current > HWM_RESET_DELAY_MS) {
          setUploadingHwm(0)
        }
      }
      if (pc > 0) {
        processingIdleSinceRef.current = null
        setProcessingHwm((prev) => Math.max(prev, pc))
      } else {
        if (processingIdleSinceRef.current === null) {
          processingIdleSinceRef.current = now
        } else if (now - processingIdleSinceRef.current > HWM_RESET_DELAY_MS) {
          setProcessingHwm(0)
        }
      }
    } catch (err) {
      if (seq !== fetchSeqRef.current || !aliveRef.current) return
      logError('[ProcessingStatus] fetch threw:', err)
    }
  }

  useEffect(() => {
    aliveRef.current = true
    // Initial fetch on mount so the banners can appear instantly
    // for already-in-flight work (e.g. user reloads the tab).
    fetchStatus()
    return () => {
      aliveRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Adaptive interval: faster when something is happening, slower
  // when idle. We re-create the interval whenever the active flag
  // flips so we don't have to manually tear down + rebuild on
  // every count change.
  const hasWork = uploadingCount > 0 || processingCount > 0 ||
    uploadingHwm > 0 || processingHwm > 0
  useEffect(() => {
    const intervalMs = hasWork ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
    const id = setInterval(fetchStatus, intervalMs)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWork])

  return (
    <ProcessingStatusCtx.Provider
      value={{
        uploadingCount,
        uploadingHwm,
        uploadingVideos,
        processingCount,
        processingHwm,
        processingVideos,
        refetch: fetchStatus,
      }}
    >
      {children}
    </ProcessingStatusCtx.Provider>
  )
}

export function useProcessingStatus(): StatusValue {
  const ctx = useContext(ProcessingStatusCtx)
  if (!ctx) {
    // Safe no-op fallback for components rendered outside the
    // provider (e.g. a stray sidebar widget on the public share
    // page) — they just see 0/0 and render nothing.
    return {
      uploadingCount: 0,
      uploadingHwm: 0,
      uploadingVideos: [],
      processingCount: 0,
      processingHwm: 0,
      processingVideos: [],
      refetch: () => {},
    }
  }
  return ctx
}
