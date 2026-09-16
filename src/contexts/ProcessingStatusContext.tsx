'use client'

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
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
  /** 6.14.0: source size in bytes, so the banner can turn a percentage delta
   *  into MB/s. null on rows whose size wasn't recorded yet. */
  originalFileSize: number | null
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
  /**
   * 7.9.0: the ladder the worker will decide, for rows it has not reached
   * yet (null once `plannedTiers` is real). From the dimensions the browser
   * probed at upload when it could, else from the project cap.
   */
  plannedTiersPredicted: string[] | null
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
  /**
   * 7.10.0: true when the signed-in person uploaded this row
   * (`Video.createdById`), decided on the server. The bottom-right banners
   * show only these rows; the folder cards keep reading the whole list so
   * everyone still sees a colleague's upload progressing on its card.
   */
  isMine: boolean
}

type StatusResponse = {
  uploading: { count: number; mineCount?: number; videos: ProcessingVideo[] }
  processing: { count: number; mineCount?: number; videos: ProcessingVideo[] }
}

/**
 * 7.10.0: the signed-in person's own share of the in-flight work. This is
 * what the banners render. The counts come from the server (a true total,
 * not the length of the capped list) and the high-water marks are kept
 * separately from the company-wide ones, so "All uploads complete" appears
 * when MY uploads finish, not when the company's do.
 */
type MineStatus = {
  uploadingCount: number
  uploadingHwm: number
  uploadingVideos: ProcessingVideo[]
  processingCount: number
  processingHwm: number
  processingVideos: ProcessingVideo[]
}

type StatusValue = {
  /** Company-wide. Drives the per-card progress bars and the poll cadence. */
  uploadingCount: number
  uploadingHwm: number
  uploadingVideos: ProcessingVideo[]
  processingCount: number
  processingHwm: number
  processingVideos: ProcessingVideo[]
  /** 7.10.0: the viewer's own rows and counts — what the banners show. */
  mine: MineStatus
  /** Force a one-off refetch (e.g. right after the user uploads). */
  refetch: () => void
}

const ProcessingStatusCtx = createContext<StatusValue | null>(null)

const ACTIVE_INTERVAL_MS = 3_000
const IDLE_INTERVAL_MS = 15_000
/**
 * How long the "All uploads complete" / "All processing complete" state stays
 * on screen before the banner dismisses itself.
 *
 * This used to be 5s, but it was evaluated on the polling tick rather than on a
 * timer: the poll that first saw `count === 0` only noted the timestamp, and
 * the comparison ran on the NEXT poll 3s later, which was still under 5s, so
 * the banner actually lived 6–9s depending on how the ticks lined up. Real
 * elapsed time from "encode finished" to "banner gone" was 6–12s once you add
 * the poll latency that detects completion in the first place. It felt like it
 * was hanging around.
 *
 * Now it is a real timer, so the number here is the number you get.
 */
const HWM_RESET_DELAY_MS = 2_000

export function ProcessingStatusProvider({ children }: { children: ReactNode }) {
  const [uploadingCount, setUploadingCount] = useState(0)
  const [uploadingHwm, setUploadingHwm] = useState(0)
  const [uploadingVideos, setUploadingVideos] = useState<ProcessingVideo[]>([])
  const [processingCount, setProcessingCount] = useState(0)
  const [processingHwm, setProcessingHwm] = useState(0)
  const [processingVideos, setProcessingVideos] = useState<ProcessingVideo[]>([])
  // 7.10.0: the viewer's own counts + high-water marks, kept apart from the
  // company-wide ones above so the two banners answer to MY work only.
  const [mineUploadingCount, setMineUploadingCount] = useState(0)
  const [mineUploadingHwm, setMineUploadingHwm] = useState(0)
  const [mineProcessingCount, setMineProcessingCount] = useState(0)
  const [mineProcessingHwm, setMineProcessingHwm] = useState(0)

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
  const uploadingResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processingResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 7.10.0: and one clock each for the viewer's own banners.
  const mineUploadingResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mineProcessingResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)

  /**
   * Arm the dismissal, once. Re-arming on every poll while the count sits at
   * zero would push the deadline forward forever and the banner would never
   * leave — which is the trap the timestamp-on-poll version was avoiding, and
   * the reason it drifted past its own delay.
   */
  const armHwmReset = (
    timerRef: typeof uploadingResetTimerRef,
    setHwm: (v: number) => void,
  ) => {
    if (timerRef.current !== null) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (aliveRef.current) setHwm(0)
    }, HWM_RESET_DELAY_MS)
  }

  /** Work showed up again inside the grace window — call off the dismissal. */
  const cancelHwmReset = (timerRef: typeof uploadingResetTimerRef) => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const fetchStatus = async () => {
    const seq = ++fetchSeqRef.current
    try {
      // 2.3.2+: URL-level cache buster. The `cache: 'no-store'`
      // hint + server `Cache-Control: no-store` from 2.3.1
      // SHOULD be enough, but on prod (TrueNAS behind traefik,
      // CloudFlare tunnels, …) the banner kept showing the same
      // 75 % / HD+ snapshot across multiple polls — the in-video
      // Quality menu, which polls `/api/projects/[id]` and
      // therefore hits a different URL each render via the
      // project id segment, never had the issue.
      //
      // Adding a per-call `?t=<timestamp>` query mirrors the
      // "dynamic URL" trick the in-video poll relies on
      // implicitly: each request is a fresh resource as far as
      // every cache layer in the chain is concerned, so none of
      // them can serve a memoised response. Same pattern as the
      // `?_=${Date.now()}` we already use when reloading HLS
      // masters mid-session.
      const res = await apiFetch(`/api/processing-status?t=${Date.now()}`, {
        cache: 'no-store',
      })
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
      if (uc > 0) {
        cancelHwmReset(uploadingResetTimerRef)
        setUploadingHwm((prev) => Math.max(prev, uc))
      } else {
        armHwmReset(uploadingResetTimerRef, setUploadingHwm)
      }
      if (pc > 0) {
        cancelHwmReset(processingResetTimerRef)
        setProcessingHwm((prev) => Math.max(prev, pc))
      } else {
        armHwmReset(processingResetTimerRef, setProcessingHwm)
      }

      // 7.10.0: the same bookkeeping for the viewer's own share. A server
      // from before this field is treated as "nothing of mine" rather than
      // "everything is mine" — the banner then stays quiet until the image
      // is updated, which is the honest reading of a missing number.
      const muc = data.uploading?.mineCount ?? 0
      const mpc = data.processing?.mineCount ?? 0
      setMineUploadingCount(muc)
      setMineProcessingCount(mpc)
      if (muc > 0) {
        cancelHwmReset(mineUploadingResetTimerRef)
        setMineUploadingHwm((prev) => Math.max(prev, muc))
      } else {
        armHwmReset(mineUploadingResetTimerRef, setMineUploadingHwm)
      }
      if (mpc > 0) {
        cancelHwmReset(mineProcessingResetTimerRef)
        setMineProcessingHwm((prev) => Math.max(prev, mpc))
      } else {
        armHwmReset(mineProcessingResetTimerRef, setMineProcessingHwm)
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
      cancelHwmReset(uploadingResetTimerRef)
      cancelHwmReset(processingResetTimerRef)
      cancelHwmReset(mineUploadingResetTimerRef)
      cancelHwmReset(mineProcessingResetTimerRef)
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

  // 7.10.0: the viewer's rows, filtered once per poll. Memoised so the
  // banner's effects (which key on the array identity) do not re-run on
  // every unrelated render of the provider.
  const mineUploadingVideos = useMemo(
    () => uploadingVideos.filter((v) => v.isMine),
    [uploadingVideos],
  )
  const mineProcessingVideos = useMemo(
    () => processingVideos.filter((v) => v.isMine),
    [processingVideos],
  )
  const mine = useMemo<MineStatus>(
    () => ({
      uploadingCount: mineUploadingCount,
      uploadingHwm: mineUploadingHwm,
      uploadingVideos: mineUploadingVideos,
      processingCount: mineProcessingCount,
      processingHwm: mineProcessingHwm,
      processingVideos: mineProcessingVideos,
    }),
    [
      mineUploadingCount,
      mineUploadingHwm,
      mineUploadingVideos,
      mineProcessingCount,
      mineProcessingHwm,
      mineProcessingVideos,
    ],
  )

  return (
    <ProcessingStatusCtx.Provider
      value={{
        uploadingCount,
        uploadingHwm,
        uploadingVideos,
        processingCount,
        processingHwm,
        processingVideos,
        mine,
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
      mine: {
        uploadingCount: 0,
        uploadingHwm: 0,
        uploadingVideos: [],
        processingCount: 0,
        processingHwm: 0,
        processingVideos: [],
      },
      refetch: () => {},
    }
  }
  return ctx
}
