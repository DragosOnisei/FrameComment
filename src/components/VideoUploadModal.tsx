'use client'

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Upload, Video, X, Pause, Play, CheckCircle2, Loader2 } from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import * as tus from 'tus-js-client'
import { apiPost, apiDelete } from '@/lib/api-client'
import { logError } from '@/lib/logging'
import { ConfirmModal } from '@/components/ConfirmModal'
import { getAccessToken } from '@/lib/token-store'
import { getTusUploadErrorMessage, createTusAfterResponseHandler, createTusShouldRetryHandler, resetTusAuthRetry } from '@/lib/tus-error'
import { getTusChunkSizeBytes, TUS_RETRY_DELAYS_MS } from '@/lib/transfer-tuning'
import {
  ensureFreshUploadOnContextChange,
  clearFileContext,
  clearTUSFingerprint,
  getUploadMetadata,
  storeUploadMetadata,
  clearUploadMetadata,
  listResumableUploads,
  matchesResumable,
  forgetResumable,
  type ResumableUpload,
} from '@/lib/tus-context'
import { useStorageProvider } from '@/components/StorageConfigProvider'
import { useS3MultipartUpload } from '@/hooks/useS3MultipartUpload'

interface PendingUpload {
  id: string
  file: File
  videoName: string
  versionLabel: string
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'cancelling'
  progress: number
  speed: number
  /** 6.3.0 stall detection: bytes seen so far and when they last moved.
   *  A transfer sitting at the same byte count for STALL_TIMEOUT_MS is
   *  stuck — the browser keeps the request open and the UI used to show a
   *  cheerful progress bar forever. */
  bytesUploaded?: number
  lastProgressAt?: number
  /** Set once we've auto-resumed this file, so we never loop on it. */
  stallRetried?: boolean
  stalled?: boolean
  error?: string
  videoId?: string
  paused?: boolean
  /** Per-file folder override (1.0.7+). When the modal is opened from
   *  a folder drag-and-drop with hierarchy, each file knows which
   *  newly-created FrameComment folder it belongs to — overrides the
   *  top-level `folderId` prop just for this row. */
  folderIdOverride?: string | null
  /** 3.9.x: when set, this upload is a NEW VERSION of an existing
   *  video. After the video record is created we POST
   *  /api/videos/[newId]/stack with `{ targetVideoId: stackOntoVideoId }`
   *  so the fresh upload joins that video's version stack (same logic
   *  as dragging one video card onto another). */
  stackOntoVideoId?: string
}

interface VideoUploadModalProps {
  isOpen: boolean
  /** Monotonic counter bumped on every trigger from
   *  AdminVideoManager. We listen on it so a second toolbar /
   *  context-menu click re-fires the auto file-picker effect
   *  even when `isOpen` was already true (the user dismissed
   *  the picker with Escape and there's no event we can hook). */
  triggerNonce?: number
  onClose: () => void
  projectId: string
  onUploadComplete: (videoName: string, videoId: string) => void
  /** Files to seed into the pending list on open — used by the
   *  Frame.io-style drop zone in FolderBrowser so dragging a file
   *  onto the empty state pre-fills this modal. The list is consumed
   *  once per "open" (effect tracks an instance via array identity). */
  initialFiles?: File[] | null
  /** Per-file pre-seed (1.0.7+) — same as `initialFiles` but with each
   *  file pinned to a specific folder. Used when the user drops an
   *  entire folder tree from their OS: we mint the matching folders in
   *  FrameComment first, then hand the upload modal a list of
   *  `(file, folderId)` pairs so each video lands in the correct
   *  sub-folder. The list is also consumed once per array identity. */
  initialFilesWithFolders?: Array<{
    file: File
    folderId: string | null
    /** 3.9.x: drop-onto-video path — stack this upload as a new
     *  version of the given video after its record is created. */
    stackOntoVideoId?: string
  }> | null
  /** Optional folder to upload into. When set, the server attaches
   *  the new video to this folder; when null/undefined, the video
   *  goes to the project root (legacy / dashboard behaviour). */
  folderId?: string | null
}

export function VideoUploadModal({ isOpen, triggerNonce, onClose, projectId, onUploadComplete, initialFiles, initialFilesWithFolders, folderId }: VideoUploadModalProps) {
  const t = useTranslations('videos')
  const tc = useTranslations('common')
  const storageProvider = useStorageProvider()
  const { startUpload: startS3Upload, abortUpload: abortS3Upload, pauseUpload: pauseS3Upload, resumeUpload: resumeS3Upload } = useS3MultipartUpload()
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadRefs = useRef<Map<string, tus.Upload>>(new Map())
  // Tracks the S3 upload key per item ID so we can abort them on remove
  const s3UploadKeys = useRef<Map<string, string>>(new Map())

  // 4.2.x: reconcile stuck uploads. A TUS `onSuccess` callback can be lost to
  // an intermittent proxy / network / background-tab-throttle blip, leaving a
  // row stuck at a partial % ("1 in progress") even though the bytes finished
  // and the video is already PROCESSING/READY on the server. We poll the real
  // status of any 'uploading' row that already has a videoId and clear it once
  // the server has moved past UPLOADING. Harmless during a genuine upload (the
  // row stays UPLOADING server-side until all bytes land, so it's left alone).
  const pendingUploadsRef = useRef<PendingUpload[]>([])
  useEffect(() => { pendingUploadsRef.current = pendingUploads }, [pendingUploads])
  // Boolean dep (not the array) so the interval isn't torn down on every
  // progress tick — only when we cross into / out of "has a row to reconcile".
  const hasReconcileCandidates = pendingUploads.some((u) => u.status === 'uploading' && !!u.videoId)
  useEffect(() => {
    if (!hasReconcileCandidates) return
    let cancelled = false
    const reconcile = async () => {
      const ids = pendingUploadsRef.current
        .filter((u) => u.status === 'uploading' && u.videoId)
        .map((u) => u.videoId as string)
      if (ids.length === 0) return
      try {
        const res = await apiPost<{ statuses: Record<string, string> }>(
          '/api/videos/statuses',
          { ids },
        )
        if (cancelled || !res?.statuses) return
        setPendingUploads((prev) =>
          prev.map((u) => {
            if (u.status !== 'uploading' || !u.videoId) return u
            const s = res.statuses[u.videoId]
            if (!s || s === 'UPLOADING') return u // still uploading / unknown → leave as-is
            if (s === 'ERROR') return { ...u, status: 'error' as const, error: u.error || 'Processing failed' }
            // PROCESSING / READY = bytes finished; the onSuccess callback was
            // just lost. Clear the stuck row.
            return { ...u, status: 'completed' as const, progress: 100 }
          }),
        )
      } catch {
        /* transient — try again next tick */
      }
    }
    const timeout = setTimeout(reconcile, 2000)
    const interval = setInterval(reconcile, 5000)
    return () => { cancelled = true; clearTimeout(timeout); clearInterval(interval) }
  }, [hasReconcileCandidates])

  // 6.3.0 STALL WATCHDOG.
  //
  // A transfer can go quiet without erroring: the socket stays open, TUS keeps
  // waiting, and the row sits at the same percentage forever. The user has no
  // way to tell that from a slow-but-alive upload, so a file could be "almost
  // done" for an hour.
  //
  // Rule: no byte movement for STALL_TIMEOUT_MS while uploading and not paused
  // → resume it ONCE (TUS picks up where it left off, so nothing re-uploads);
  // if it stalls again, fail the row and say so. Retry stays available.
  const STALL_TIMEOUT_MS = 30_000
  const [stallNotice, setStallNotice] = useState<string | null>(null)
  const hasLiveUploads = pendingUploads.some((u) => u.status === 'uploading' && !u.paused)
  useEffect(() => {
    if (!hasLiveUploads) return
    const tick = () => {
      const now = Date.now()
      const rows = pendingUploadsRef.current
      for (const u of rows) {
        if (u.status !== 'uploading' || u.paused) continue
        const since = now - (u.lastProgressAt ?? now)
        if (since < STALL_TIMEOUT_MS) continue

        if (!u.stallRetried) {
          // First strike: resume from where it stopped.
          setPendingUploads((prev) =>
            prev.map((r) =>
              r.id === u.id
                ? { ...r, stalled: true, stallRetried: true, speed: 0, lastProgressAt: now }
                : r,
            ),
          )
          try {
            const tusUpload = uploadRefs.current.get(u.id)
            if (tusUpload) {
              tusUpload.abort().then(() => tusUpload.start()).catch(() => {})
            }
          } catch {
            /* best effort — the second strike below still catches it */
          }
          continue
        }

        // Second strike: stop pretending it's working.
        setPendingUploads((prev) =>
          prev.map((r) =>
            r.id === u.id
              ? {
                  ...r,
                  status: 'error' as const,
                  speed: 0,
                  stalled: false,
                  error: 'Upload stalled — no data sent for 30 seconds',
                }
              : r,
          ),
        )
        setStallNotice(u.videoName || u.file.name)
        try {
          uploadRefs.current.get(u.id)?.abort()
          uploadRefs.current.delete(u.id)
        } catch {
          /* already gone */
        }
        // 6.14.0: tell the SERVER the transfer is over.
        //
        // This is the half that was missing. The watchdog gave up here and
        // the row stayed UPLOADING in the database, so the global upload
        // banner kept reading "1 in progress" at whatever percentage the
        // transfer died at — until the 30-minute abandoned-upload sweep
        // eventually noticed. The client knew half an hour earlier; now it
        // says so.
        if (u.videoId) {
          apiPost(`/api/videos/${u.videoId}/cancel-upload`, {
            reason: 'Upload stalled — no data sent for 30 seconds.',
          }).catch(() => {
            /* the reaper is still the backstop */
          })
        }
      }
    }
    const interval = setInterval(tick, 5000)
    return () => clearInterval(interval)
  }, [hasLiveUploads])

  // 1.5.7: detects if the modal is being opened on a public hostname
  // (i.e. likely behind a CDN / reverse proxy like Cloudflare). If so we
  // surface a small hint about switching to the LAN URL over VPN for
  // sustained-upload speed. Computed once on mount to avoid SSR window
  // access.
  const [isPublicHost, setIsPublicHost] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const host = window.location.hostname
    // Treat localhost / loopback / mDNS / RFC1918 ranges as "on the LAN"
    // and skip the hint in those cases.
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^fc00:/.test(host) || /^fd[0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)
    setIsPublicHost(!isLocal)
  }, [])

  // Maximum length for a video name. Kept generous (200) so long,
  // fully-descriptive filenames like
  // "VDA_H1_SympleLendingRiff1_Need a Loan_Leslie_Monica_916_V4" survive
  // intact instead of being clipped to ~50 chars (which also caused spurious
  // " (2)" suffixes when several long names collapsed to the same prefix).
  // The DB column is unbounded (Postgres text); this is just a sane safety cap.
  const MAX_VIDEO_NAME_LENGTH = 200
  // Maximum display length for file names before truncation
  const MAX_FILENAME_DISPLAY_LENGTH = 38

  // Truncate filename for display
  const truncateFilename = (filename: string, maxLength: number): string => {
    if (filename.length <= maxLength) return filename
    const ext = filename.lastIndexOf('.') > 0 ? filename.slice(filename.lastIndexOf('.')) : ''
    const nameWithoutExt = filename.slice(0, filename.lastIndexOf('.') > 0 ? filename.lastIndexOf('.') : filename.length)
    const availableLength = maxLength - ext.length - 3 // 3 for "..."
    if (availableLength <= 0) return filename.slice(0, maxLength - 3) + '...'
    return nameWithoutExt.slice(0, availableLength) + '...' + ext
  }

  // Extract video name from filename (remove extension, truncate if needed)
  const getVideoNameFromFile = (file: File): string => {
    const name = file.name
    const lastDot = name.lastIndexOf('.')
    const baseName = lastDot > 0 ? name.substring(0, lastDot) : name
    return baseName.substring(0, MAX_VIDEO_NAME_LENGTH)
  }

  // Validate video file format
  // 1.0.9+: returns true when the file is one of the supported image
  // kinds. We branch on this before the MP4/MOV magic-byte check so
  // PNG / JPG / WebP / GIF uploads aren't rejected.
  const isImageUpload = (file: File): boolean => {
    if (file.type && file.type.startsWith('image/')) return true
    return /\.(jpe?g|png|webp|gif)$/i.test(file.name)
  }

  const validateVideoFile = async (file: File): Promise<{ valid: boolean; error?: string }> => {
    if (file.size === 0) {
      return { valid: false, error: t('fileEmpty') }
    }

    // 1.0.9+: skip the MP4 magic-byte check for image uploads — the
    // server already does its own image-vs-video classification on
    // mediaType and the original file is what gets stored verbatim.
    if (isImageUpload(file)) {
      return { valid: true }
    }

    try {
      const headerBytes = await new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (e) => {
          if (e.target?.result) {
            resolve(new Uint8Array(e.target.result as ArrayBuffer))
          } else {
            reject(new Error('Failed to read file'))
          }
        }
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsArrayBuffer(file.slice(0, 12))
      })

      if (headerBytes.length < 12) {
        return { valid: false, error: t('fileTooSmall') }
      }

      const ftypSignature = String.fromCharCode(...headerBytes.subarray(4, 8))
      if (ftypSignature === 'ftyp') return { valid: true }

      const mdatSignature = String.fromCharCode(...headerBytes.subarray(4, 8))
      if (mdatSignature === 'mdat') return { valid: true }

      const validAtoms = ['wide', 'free', 'moov']
      const atomType = String.fromCharCode(...headerBytes.subarray(4, 8))
      if (validAtoms.includes(atomType)) return { valid: true }

      return {
        valid: false,
        error: t('invalidVideoShort')
      }
    } catch {
      return { valid: false, error: t('failedToRead') }
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  // 1.0.9+: accept BOTH videos and images. Some macOS .mov / .avi
  // files report an empty MIME, so we also accept the canonical
  // FrameComment media extensions as a safety net.
  const isAcceptedUpload = (f: File) =>
    f.type.startsWith('video/') ||
    f.type.startsWith('image/') ||
    /\.(mp4|mov|avi|mkv|webm|m4v|mxf|prores|jpg|jpeg|png|webp|gif)$/i.test(
      f.name,
    )

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files).filter(isAcceptedUpload)
    addFiles(files)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(isAcceptedUpload)
    addFiles(files)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // 4.1.8+: give every upload in a batch a UNIQUE name up front so
  // videos uploaded at the same time never land the same `name`
  // server-side (which the folder view would then merge into one card
  // with several "v1"s). Mutates `used` so successive calls keep
  // counting. Intentional versioning is unaffected — it goes through the
  // /stack endpoint, which renames the source anyway.
  const dedupeName = (base: string, used: Set<string>): string => {
    if (!used.has(base)) {
      used.add(base)
      return base
    }
    let n = 2
    while (used.has(`${base} (${n})`)) n++
    const name = `${base} (${n})`
    used.add(name)
    return name
  }

  const addFiles = (files: File[]) => {
    if (files.length > 0) {
      const used = new Set(pendingUploads.map((u) => u.videoName))
      const newUploads: PendingUpload[] = files.map(file => ({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        videoName: dedupeName(getVideoNameFromFile(file), used),
        versionLabel: '',
        status: 'pending',
        progress: 0,
        speed: 0,
      }))
      setPendingUploads(prev => [...prev, ...newUploads])
      // 2.0.x+: banner-style flow — there's no "Start Upload"
      // button any more. As soon as the user selects files we
      // kick off TUS for each one. They can pause / cancel per
      // row from the expanded banner.
      newUploads.forEach(item => startUpload(item))
    }
  }

  // Consume `initialFiles` once per array identity — fires when the
  // empty-state drop zone in FolderBrowser opens this modal with
  // pre-selected files. The user already indicated intent by
  // dragging, so we SKIP the "Start Upload" button and kick the
  // pipeline off immediately. The modal stays mounted so the
  // upload state lives somewhere; an auto-close effect below
  // dismisses it once everything finishes.
  const seededRef = useRef<File[] | null>(null)
  // True between the first seeded drop and the auto-close — used by
  // the completion watcher.
  const [seededActive, setSeededActive] = useState(false)
  useEffect(() => {
    if (!isOpen) return
    if (!initialFiles || initialFiles.length === 0) return
    if (seededRef.current === initialFiles) return
    seededRef.current = initialFiles
    // 1.0.9+: accept images here too. `isAcceptedUpload` keeps the
    // extension-fallback for files with an empty MIME.
    const accepted = initialFiles.filter(isAcceptedUpload)
    if (accepted.length === 0) return
    const used = new Set(pendingUploads.map((u) => u.videoName))
    const newUploads: PendingUpload[] = accepted.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      videoName: dedupeName(getVideoNameFromFile(file), used),
      versionLabel: '',
      status: 'pending',
      progress: 0,
      speed: 0,
    }))
    setPendingUploads((prev) => [...prev, ...newUploads])
    setSeededActive(true)
    // Kick off each upload directly. `startUpload` only needs the
    // item itself; it updates state by id via functional setters so
    // it doesn't matter that pendingUploads hasn't flushed yet.
    newUploads.forEach((item) => startUpload(item))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialFiles])

  // Per-folder seed (1.0.7+) — same effect as above but each pending
  // upload remembers its own folderId so the POST /api/videos call
  // routes the new record into the right sub-folder. Used by the
  // folder-tree drag-and-drop path.
  const seededWithFoldersRef = useRef<
    Array<{ file: File; folderId: string | null; stackOntoVideoId?: string }> | null
  >(null)
  useEffect(() => {
    if (!isOpen) return
    if (!initialFilesWithFolders || initialFilesWithFolders.length === 0) return
    if (seededWithFoldersRef.current === initialFilesWithFolders) return
    seededWithFoldersRef.current = initialFilesWithFolders
    // 1.0.9+: accept images alongside videos. Empty-MIME fallback
    // covers both kinds via the canonical FrameComment extension
    // whitelist.
    const accepted = initialFilesWithFolders.filter((entry) =>
      isAcceptedUpload(entry.file),
    )
    if (accepted.length === 0) return
    // Dedupe names PER FOLDER — two files with the same name in different
    // sub-folders are fine and shouldn't get a " (2)".
    const folderKey = (fid: string | null) => fid ?? '__root__'
    const usedByFolder = new Map<string, Set<string>>()
    for (const u of pendingUploads) {
      const k = folderKey(u.folderIdOverride ?? null)
      if (!usedByFolder.has(k)) usedByFolder.set(k, new Set())
      usedByFolder.get(k)!.add(u.videoName)
    }
    const newUploads: PendingUpload[] = accepted.map((entry) => {
      const k = folderKey(entry.folderId)
      if (!usedByFolder.has(k)) usedByFolder.set(k, new Set())
      return {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file: entry.file,
        videoName: dedupeName(getVideoNameFromFile(entry.file), usedByFolder.get(k)!),
        versionLabel: '',
        status: 'pending' as const,
        progress: 0,
        speed: 0,
        folderIdOverride: entry.folderId,
        stackOntoVideoId: entry.stackOntoVideoId,
      }
    })
    setPendingUploads((prev) => [...prev, ...newUploads])
    setSeededActive(true)
    newUploads.forEach((item) => startUpload(item))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialFilesWithFolders])

  // Auto-close the modal once every seeded upload completes. Only
  // fires when this modal session was started by a drag-drop seed.
  // IMPORTANT: if any upload ended in error we keep the modal open
  // so the user can read what went wrong (previously we closed
  // silently, which looked like a flash with no result).
  useEffect(() => {
    if (!seededActive) return
    if (pendingUploads.length === 0) return
    const allDone = pendingUploads.every(
      (u) => u.status === 'completed' || u.status === 'error',
    )
    if (!allDone) return
    const hasError = pendingUploads.some((u) => u.status === 'error')
    if (hasError) {
      // Keep the modal open so the error row is visible. Drop the
      // seeded flag so further state changes don't keep re-arming
      // this effect.
      setSeededActive(false)
      return
    }
    const t = setTimeout(() => {
      setSeededActive(false)
      setPendingUploads([])
      onClose()
    }, 800)
    return () => clearTimeout(t)
  }, [seededActive, pendingUploads, onClose])

  // Reset the seeded flag when the modal is fully closed so the
  // next manual open starts in normal (non-auto-close) mode.
  useEffect(() => {
    if (!isOpen) {
      seededRef.current = null
      seededWithFoldersRef.current = null
      setSeededActive(false)
    }
  }, [isOpen])

  // 2.2.0+: When the parent calls `triggerUpload()` plain (no
  // seeded files / folder tree) we set `isOpen=true` but the
  // component returns just the hidden file input — the user
  // never sees a dialog and the system file picker never opens
  // on its own. That bug surfaced from both the toolbar's
  // "Upload Video(s)" button AND the right-click "Upload Asset"
  // context-menu item. Auto-clicking the hidden input here
  // synthesises the picker, so the user gets the native dialog
  // immediately when they click either trigger. We gate on no
  // initialFiles/initialFilesWithFolders so we don't re-open the
  // picker when the parent already seeded the upload with files
  // (drag-drop, "Add more videos", etc.) — those paths set
  // pendingUploads which then renders the visible banner.
  useEffect(() => {
    if (!isOpen) return
    if (initialFiles && initialFiles.length > 0) return
    if (initialFilesWithFolders && initialFilesWithFolders.length > 0) return
    // Defer one tick so React has flushed the input render and any
    // upstream click event (the kebab menu, the toolbar button)
    // has finished — otherwise the picker dismisses immediately.
    const id = setTimeout(() => {
      fileInputRef.current?.click()
    }, 0)
    return () => clearTimeout(id)
    // `triggerNonce` in the deps list is what re-runs this effect
    // when the user invokes triggerUpload() a second time without
    // ever closing the modal in between.
  }, [isOpen, triggerNonce, initialFiles, initialFilesWithFolders])

  const performRemove = async (id: string) => {
    // 1.5.x+: Cancel/Remove now performs a FULL teardown — not just
    // "stop the TUS PATCH stream". The old version only aborted the
    // TUS client, which left two orphans behind:
    //
    //   1. The DB row (`Video` with status='UPLOADING'). If the upload
    //      had already completed server-side or the worker had already
    //      picked it up off the queue, the row kept marching toward
    //      READY — the user would later see a thumbnail being
    //      generated for content they thought they'd thrown away.
    //   2. The TUS fingerprint + upload metadata in localStorage. On
    //      the next attempt with the SAME file, tus-js-client would
    //      try to resume from the dead session → server returns 404 /
    //      410 → user sees "Upload session expired. Please try again."
    //
    // We now: (a) abort TUS / S3, (b) DELETE the video record so the
    // worker job becomes a no-op, and (c) wipe the localStorage
    // resume state so the retry starts a clean upload.
    const itemSnapshot = pendingUploadsRef.current.find(u => u.id === id)

    // 6.14.0: the teardown is now AWAITED, and the row stays on screen while
    // it runs.
    //
    // It used to fire everything off and drop the row immediately. That read
    // as "cancelled" and was not: `abort(true)` sends a DELETE to the TUS
    // server (which is what removes the half-written file from disk), and
    // nobody waited for it — so on a slow link the partial file could outlive
    // the click. Worse, the row vanished from the modal while the Video row
    // was still UPLOADING in the database, which is why the corner banner
    // came back with its pulsing dot: from the server's point of view the
    // upload was still happening.
    //
    // Order matters. Terminate the transfer FIRST so no more bytes arrive,
    // then delete the record. The other way round, an in-flight chunk can
    // land on a row that no longer exists.
    setPendingUploads(prev =>
      prev.map(u => (u.id === id ? { ...u, status: 'cancelling' as const, speed: 0 } : u)),
    )

    const tusUpload = uploadRefs.current.get(id)
    if (tusUpload) {
      uploadRefs.current.delete(id)
      try {
        // `true` = terminate server-side, not just stop sending. This is the
        // call that deletes the partial file; without it the bytes already
        // uploaded stay on disk as junk nobody ever looks at again.
        await tusUpload.abort(true)
      } catch (err) {
        logError('[UPLOAD] Could not terminate the TUS session:', err)
      }
    }
    const s3Key = s3UploadKeys.current.get(id)
    if (s3Key) {
      s3UploadKeys.current.delete(id)
      try {
        await abortS3Upload(s3Key)
      } catch (err) {
        logError('[UPLOAD] Could not abort the S3 multipart upload:', err)
      }
    }

    if (itemSnapshot) {
      // Clear localStorage so the next attempt starts a fresh session
      // instead of trying to resume a dead one.
      try { clearTUSFingerprint(itemSnapshot.file) } catch {}
      try { clearUploadMetadata(itemSnapshot.file) } catch {}

      // `?permanent=1` skips Trash: a cancelled upload never produced
      // anything worth recovering, and a half-finished row in Trash is
      // just work for the cleanup sweep. This also takes the row back out
      // of a version stack if the file had been dropped onto an existing
      // video.
      if (itemSnapshot.videoId) {
        try {
          await apiDelete(`/api/videos/${itemSnapshot.videoId}?permanent=1`)
        } catch (err) {
          // The abandoned-upload sweep is still the backstop.
          logError('[UPLOAD] Could not delete the cancelled row:', err)
        }
      }
    }

    setPendingUploads(prev => prev.filter(u => u.id !== id))
  }

  // 6.14.0: cancelling a live transfer asks first — and PAUSES while it asks.
  //
  // The X used to tear the upload down on the first click. On a file that has
  // been going for ten minutes that is a very expensive misclick, and the
  // button sits right next to Pause. Now an in-flight row is paused (so no
  // more bytes are wasted while the question is on screen) and the teardown
  // only happens on confirm. Saying no resumes exactly where it stopped —
  // which is the one thing TUS is genuinely good at.
  //
  // Rows that are not transferring — queued, failed, finished — are removed
  // straight away. There is nothing in flight to lose and a confirmation for
  // "take this off the list" is just a second click.
  const [cancelCandidate, setCancelCandidate] = useState<string | null>(null)
  const resumeAfterCancelRef = useRef(false)

  const handleRemove = (id: string) => {
    const item = pendingUploadsRef.current.find((u) => u.id === id)
    if (!item || item.status !== 'uploading') {
      void performRemove(id)
      return
    }
    if (!item.paused) {
      resumeAfterCancelRef.current = true
      handlePauseResume(id)
    } else {
      resumeAfterCancelRef.current = false
    }
    setCancelCandidate(id)
  }

  const dismissCancelPrompt = () => {
    const id = cancelCandidate
    setCancelCandidate(null)
    if (!id) return
    // Only resume what WE paused — a transfer the user had paused themselves
    // before clicking X stays paused.
    if (resumeAfterCancelRef.current) {
      resumeAfterCancelRef.current = false
      const item = pendingUploadsRef.current.find((u) => u.id === id)
      if (item?.paused) handlePauseResume(id)
    }
  }

  // 6.14.0 — offer to pick up an upload a page refresh interrupted.
  //
  // A reload throws away the `File`, and no API can hand it back without the
  // user choosing it again — that is a security boundary, not a bug we can
  // work around. Everything ELSE survives: the server still has the partial
  // file and the exact offset, and the fingerprint is still in localStorage.
  // So we ask for the one missing piece. Picking the same file resumes from
  // the offset; nothing already transferred is sent twice.
  const [resumable, setResumable] = useState<ResumableUpload | null>(null)
  const resumeInputRef = useRef<HTMLInputElement>(null)
  const [resumeMismatch, setResumeMismatch] = useState(false)
  // Video ids this tab has already taken responsibility for — either resumed
  // or discarded. Without it the re-scan below immediately re-offers the very
  // upload the user just resumed: the row is still UPLOADING (correctly, it is
  // uploading again) and the metadata is still there (correctly, tus needs
  // it), so every signal still says "unfinished".
  const claimedResumesRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const scan = async () => {
      const candidates = listResumableUploads(projectId)
      if (candidates.length === 0) {
        if (!cancelled) setResumable(null)
        return
      }
      // Only offer rows the server still considers unfinished. A completed or
      // cancelled upload must not be advertised as resumable.
      try {
        const res = await apiPost<{ statuses: Record<string, string> }>(
          '/api/videos/statuses',
          { ids: candidates.map((c) => c.videoId).slice(0, 20) },
        )
        const alive = candidates.find(
          (c) =>
            res?.statuses?.[c.videoId] === 'UPLOADING' &&
            !claimedResumesRef.current.has(c.videoId) &&
            !pendingUploadsRef.current.some((u) => u.videoId === c.videoId),
        )
        for (const c of candidates) {
          if (c !== alive && !res?.statuses?.[c.videoId]) forgetResumable(c)
        }
        if (!cancelled) setResumable(alive ?? null)
      } catch {
        if (!cancelled) setResumable(null)
      }
    }
    void scan()
    return () => {
      cancelled = true
    }
    // Re-scan when the pending list empties (an upload just finished or was
    // cancelled) so a stale offer disappears.
  }, [projectId, pendingUploads.length])

  const handleResumePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !resumable) return
    if (!matchesResumable(file, resumable)) {
      setResumeMismatch(true)
      return
    }
    setResumeMismatch(false)
    const entry = resumable
    claimedResumesRef.current.add(entry.videoId)
    setResumable(null)
    const item: PendingUpload = {
      id: `resume-${entry.videoId}`,
      file,
      videoName: entry.targetName || file.name.replace(/\.[^.]+$/, ''),
      versionLabel: entry.versionLabel || '',
      status: 'pending',
      progress: 0,
      speed: 0,
    }
    setPendingUploads((prev) => [...prev, item])
    void startUpload(item)
  }

  const dismissResumable = () => {
    if (resumable) {
      claimedResumesRef.current.add(resumable.videoId)
      forgetResumable(resumable)
    }
    setResumable(null)
    setResumeMismatch(false)
  }

  const handleUpdateName = (id: string, newName: string) => {
    // Enforce max length
    const truncatedName = newName.substring(0, MAX_VIDEO_NAME_LENGTH)
    setPendingUploads(prev => prev.map(u => u.id === id ? { ...u, videoName: truncatedName } : u))
  }

  const handleUpdateVersionLabel = (id: string, newLabel: string) => {
    setPendingUploads(prev => prev.map(u => u.id === id ? { ...u, versionLabel: newLabel } : u))
  }

  const startUpload = async (uploadItem: PendingUpload) => {
    const { id, file, videoName, versionLabel } = uploadItem

    if (!videoName.trim()) {
      setPendingUploads(prev => prev.map(u =>
        u.id === id ? { ...u, status: 'error', error: t('videoNameRequired') } : u
      ))
      return
    }

    const trimmedVideoName = videoName.trim()
    const trimmedVersionLabel = versionLabel.trim()
    const contextKey = `${projectId}:${trimmedVideoName}:${trimmedVersionLabel || 'auto'}`

    setPendingUploads(prev => prev.map(u =>
      u.id === id ? { ...u, status: 'uploading', progress: 0, error: undefined } : u
    ))

    try {
      // Validate file
      const validation = await validateVideoFile(file)
      if (!validation.valid) {
        throw new Error(validation.error || 'Invalid video file')
      }

      // Check context and create video record
      ensureFreshUploadOnContextChange(file, contextKey)

      const existingMetadata = getUploadMetadata(file)
      let canResumeExisting =
        existingMetadata?.projectId === projectId &&
        !!existingMetadata.videoId &&
        existingMetadata?.targetName === trimmedVideoName &&
        (existingMetadata.versionLabel || '') === (trimmedVersionLabel || '')

      // 6.14.0: a stored resume is only good if the row it points at is still
      // there.
      //
      // The failure this fixes: refresh the page mid-upload, cancel the
      // half-finished upload, then pick the same file again. tus-js-client
      // finds its fingerprint in localStorage and happily resumes the OLD
      // session — whose metadata names a Video row that the cancel deleted.
      // Every chunk then landed on nothing (`No record was found for an
      // update`, then `Video not found`), the transfer "succeeded", and the
      // video simply never appeared. Silent data loss dressed up as a
      // completed upload.
      //
      // So: ask the server whether that row still exists before trusting the
      // resume. If it is gone, drop the fingerprint and start clean — the
      // bytes are re-sent, which is the correct price for a cancelled upload.
      if (canResumeExisting && existingMetadata?.videoId) {
        try {
          const check = await apiPost<{ statuses: Record<string, string> }>(
            '/api/videos/statuses',
            { ids: [existingMetadata.videoId] },
          )
          if (!check?.statuses?.[existingMetadata.videoId]) {
            logError(
              `[UPLOAD] Stored resume points at a missing video (${existingMetadata.videoId}) — starting a fresh upload`,
            )
            try { clearTUSFingerprint(file) } catch {}
            try { clearUploadMetadata(file) } catch {}
            canResumeExisting = false
          }
        } catch {
          // Could not check (offline, blip). Resuming is still the better bet
          // than re-sending gigabytes; a dead session now fails loudly at the
          // server instead of silently, thanks to the guard in the upload
          // endpoint.
        }
      }

      let videoId: string
      let createdVideoRecord = false

      if (canResumeExisting) {
        videoId = existingMetadata!.videoId
        storeUploadMetadata(file, {
          videoId,
          projectId,
          versionLabel: trimmedVersionLabel,
          targetName: trimmedVideoName,
        })
      } else {
        const response = await apiPost('/api/videos', {
          projectId,
          // 1.0.6+: route the upload into the active folder so the
          // new video shows up in the FolderBrowser grid you're
          // looking at, not at the project root.
          // 1.0.7+: when the upload was seeded by a folder-tree drop,
          // each pending row carries its own `folderIdOverride` for
          // the sub-folder we just created — that beats the modal's
          // top-level `folderId` prop.
          folderId:
            uploadItem.folderIdOverride !== undefined
              ? uploadItem.folderIdOverride
              : folderId ?? null,
          versionLabel: trimmedVersionLabel,
          originalFileName: file.name,
          originalFileSize: file.size,
          mimeType: file.type || undefined,
          name: trimmedVideoName,
          // 6.0.4: let the SERVER do the stacking as part of creation. The
          // follow-up POST below stays as an idempotent retry for older
          // servers, but the version number no longer depends on it.
          stackOntoVideoId: uploadItem.stackOntoVideoId,
        })
        videoId = response.videoId
        createdVideoRecord = true

        storeUploadMetadata(file, {
          videoId,
          projectId,
          versionLabel: trimmedVersionLabel,
          targetName: trimmedVideoName,
        })

        // 3.9.x: drop-onto-video path — the freshly created record is
        // its own v1 group; stack it onto the target so it becomes the
        // newest version (same server call as dragging one video card
        // onto another). Metadata-only op, safe to run before the file
        // finishes uploading. Best-effort: a stack failure shouldn't
        // abort the upload itself.
        if (uploadItem.stackOntoVideoId) {
          try {
            await apiPost(`/api/videos/${videoId}/stack`, {
              targetVideoId: uploadItem.stackOntoVideoId,
            })
          } catch (stackErr) {
            logError('[VideoUploadModal] stack-as-version failed:', stackErr)
          }
        }
      }

      setPendingUploads(prev => prev.map(u =>
        u.id === id ? { ...u, videoId } : u
      ))

      if (storageProvider === 's3') {
        // ── S3 direct multipart upload ────────────────────────────────────────
        const s3Key = `s3-video-${videoId}`
        s3UploadKeys.current.set(id, s3Key)
        let lastLoaded = 0
        let lastTime = Date.now()

        await startS3Upload(
          file,
          { videoId },
          {
            onProgress: (bytesUploaded, bytesTotal) => {
              const percentage = Math.round((bytesUploaded / bytesTotal) * 100)
              const now = Date.now()
              const timeDiff = (now - lastTime) / 1000
              const bytesDiff = bytesUploaded - lastLoaded
              let speed = 0
              if (timeDiff > 0.5) {
                const speedMBps = (bytesDiff / timeDiff) / (1024 * 1024)
                speed = speedMBps > 0.05 ? Math.round(speedMBps * 10) / 10 : 0
                lastLoaded = bytesUploaded
                lastTime = now
              }
              setPendingUploads(prev => prev.map(u => {
                if (u.id !== id) return u
                const moved = bytesUploaded > (u.bytesUploaded ?? 0)
                return {
                  ...u,
                  progress: percentage,
                  speed: speed || u.speed,
                  bytesUploaded,
                  lastProgressAt: moved ? now : (u.lastProgressAt ?? now),
                  stalled: moved ? false : u.stalled,
                }
              }))
            },
            onSuccess: () => {
              clearFileContext(file)
              clearUploadMetadata(file)
              s3UploadKeys.current.delete(id)
              setPendingUploads(prev => prev.map(u =>
                u.id === id ? { ...u, status: 'completed', progress: 100 } : u
              ))
              onUploadComplete(trimmedVideoName, videoId)
            },
            onError: async (err) => {
              if (createdVideoRecord) {
                // 1.5.8: permanent=1 — failed S3 multipart upload never
                // produced a watchable video, no reason to push it into
                // Trash and leak the orphan to the cleanup sweep.
                try { await apiDelete(`/api/videos/${videoId}?permanent=1`) } catch {}
                clearUploadMetadata(file)
              }
              s3UploadKeys.current.delete(id)
              setPendingUploads(prev => prev.map(u =>
                u.id === id ? { ...u, status: 'error', error: err.message } : u
              ))
            },
          },
          s3Key
        )
        return
      }

      // ── TUS resumable upload ─────────────────────────────────────────────────
      let lastLoaded = 0
      let lastTime = Date.now()
      const tusRef: { current: tus.Upload | null } = { current: null }

      const upload = new tus.Upload(file, {
        endpoint: `${window.location.origin}/api/uploads`,
        retryDelays: TUS_RETRY_DELAYS_MS,
        metadata: {
          filename: file.name,
          filetype: file.type || 'video/mp4',
          videoId,
        },
        chunkSize: getTusChunkSizeBytes(file.size),
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,

        onBeforeRequest: (req) => {
          const xhr = req.getUnderlyingObject()
          const token = getAccessToken()
          if (token) {
            if (xhr?.setRequestHeader) {
              xhr.setRequestHeader('Authorization', `Bearer ${token}`)
            } else {
              req.setHeader('Authorization', `Bearer ${token}`)
            }
          }
        },

        onAfterResponse: createTusAfterResponseHandler(tusRef),
        onShouldRetry: createTusShouldRetryHandler(tusRef),

        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100)
          const now = Date.now()
          const timeDiff = (now - lastTime) / 1000
          const bytesDiff = bytesUploaded - lastLoaded

          let speed = 0
          if (timeDiff > 0.5) {
            const speedMBps = (bytesDiff / timeDiff) / (1024 * 1024)
            speed = speedMBps > 0.05 ? Math.round(speedMBps * 10) / 10 : 0
            lastLoaded = bytesUploaded
            lastTime = now
          }

          setPendingUploads(prev => prev.map(u => {
            if (u.id !== id) return u
            // 6.3.0: only treat it as movement when bytes actually grew.
            const moved = bytesUploaded > (u.bytesUploaded ?? 0)
            return {
              ...u,
              progress: percentage,
              speed: speed || u.speed,
              bytesUploaded,
              lastProgressAt: moved ? now : (u.lastProgressAt ?? now),
              stalled: moved ? false : u.stalled,
            }
          }))
        },

        onSuccess: () => {
          clearFileContext(file)
          clearUploadMetadata(file)
          clearTUSFingerprint(file)
          resetTusAuthRetry(tusRef.current)
          uploadRefs.current.delete(id)

          setPendingUploads(prev => prev.map(u =>
            u.id === id ? { ...u, status: 'completed', progress: 100 } : u
          ))

          // Notify parent that this upload is complete
          onUploadComplete(trimmedVideoName, videoId)
        },

        onError: async (error) => {
          let errorMessage = getTusUploadErrorMessage(error)

          const statusCode = (error as any)?.originalResponse?.getStatus?.()

          if (canResumeExisting && (statusCode === 404 || statusCode === 410)) {
            clearUploadMetadata(file)
            clearTUSFingerprint(file)
            errorMessage = t('uploadExpired')
          } else if (createdVideoRecord && videoId) {
            // 1.5.8: permanent=1 — TUS upload errored out before
            // finalize so there's nothing watchable to "trash".
            try {
              await apiDelete(`/api/videos/${videoId}?permanent=1`)
            } catch {}
            clearUploadMetadata(file)
            clearTUSFingerprint(file)
          }

          resetTusAuthRetry(tusRef.current)
          uploadRefs.current.delete(id)
          setPendingUploads(prev => prev.map(u =>
            u.id === id ? { ...u, status: 'error', error: errorMessage } : u
          ))
        },
      })

      tusRef.current = upload

      const previousUploads = await upload.findPreviousUploads()
      if (previousUploads.length > 0) {
        upload.resumeFromPreviousUpload(previousUploads[0])
      }

      uploadRefs.current.set(id, upload)
      upload.start()

    } catch (error) {
      setPendingUploads(prev => prev.map(u =>
        u.id === id ? { ...u, status: 'error', error: error instanceof Error ? error.message : t('uploadFailed') } : u
      ))
    }
  }

  const handlePauseResume = (id: string) => {
    const item = pendingUploads.find(u => u.id === id)
    if (!item) return

    if (storageProvider === 's3') {
      const s3Key = s3UploadKeys.current.get(id)
      if (!s3Key) return
      if (item.paused) {
        resumeS3Upload(s3Key)
        setPendingUploads(prev => prev.map(u =>
          u.id === id ? { ...u, paused: false } : u
        ))
      } else {
        pauseS3Upload(s3Key)
        setPendingUploads(prev => prev.map(u =>
          u.id === id ? { ...u, paused: true } : u
        ))
      }
    } else {
      const upload = uploadRefs.current.get(id)
      if (!upload) return
      if (item.paused) {
        upload.start()
        setPendingUploads(prev => prev.map(u =>
          u.id === id ? { ...u, paused: false } : u
        ))
      } else {
        upload.abort()
        setPendingUploads(prev => prev.map(u =>
          u.id === id ? { ...u, paused: true } : u
        ))
      }
    }
  }

  const handleStartAll = () => {
    const pendingItems = pendingUploads.filter(u => u.status === 'pending' && u.videoName.trim())
    pendingItems.forEach(item => startUpload(item))
  }

  const handleRetry = (id: string) => {
    const item = pendingUploads.find(u => u.id === id)
    if (item) {
      startUpload(item)
    }
  }

  const handleClose = () => {
    // Only allow close while nothing is transferring — or being torn down.
    const hasActiveUploads = pendingUploads.some(
      u => u.status === 'uploading' || u.status === 'cancelling',
    )
    if (hasActiveUploads) return

    // Clean up completed uploads from the list
    setPendingUploads([])
    onClose()
  }

  const hasActiveUploads = pendingUploads.some(
    u => u.status === 'uploading' || u.status === 'cancelling',
  )
  const hasPendingItems = pendingUploads.some(u => u.status === 'pending' && u.videoName.trim())
  const allCompleted = pendingUploads.length > 0 && pendingUploads.every(u => u.status === 'completed')

  // Warn before closing browser if uploads are active
  useEffect(() => {
    if (hasActiveUploads) {
      const handleBeforeUnload = (e: BeforeUnloadEvent) => {
        e.preventDefault()
        e.returnValue = ''
        return ''
      }
      window.addEventListener('beforeunload', handleBeforeUnload)
      return () => window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [hasActiveUploads])

  // 2.0.x+: banner-style flow — once every upload in the panel has flipped to
  // `completed`, leave the "all done" tick on screen briefly so the user gets
  // to acknowledge it, then dismiss the banner automatically (clears state via
  // the existing handleClose). If the user adds more files during the grace
  // window we cancel the timer.
  //
  // 6.14.0: 5s → 2s. The tick is an acknowledgement, not something anyone
  // reads; five seconds of a finished banner sitting over the grid read as the
  // UI being stuck. Matches `HWM_RESET_DELAY_MS` in ProcessingStatusContext so
  // the two bottom-right stacks clear at the same rhythm.
  const ALL_DONE_DISMISS_MS = 2_000
  useEffect(() => {
    if (!allCompleted) return
    const id = setTimeout(() => {
      setPendingUploads([])
      onClose()
    }, ALL_DONE_DISMISS_MS)
    return () => clearTimeout(id)
  }, [allCompleted, onClose])

  return (
    <>
      <UploadBannerView
      isOpen={isOpen}
      pendingUploads={pendingUploads}
      fileInputRef={fileInputRef}
      handleFileSelect={handleFileSelect}
      handleRemove={handleRemove}
      handlePauseResume={handlePauseResume}
      handleRetry={handleRetry}
      handleClose={handleClose}
      allCompleted={allCompleted}
      hasActiveUploads={hasActiveUploads}
      stallNotice={stallNotice}
      onDismissStall={() => setStallNotice(null)}
      resumable={resumable}
      resumeMismatch={resumeMismatch}
      resumeInputRef={resumeInputRef}
      onResumePick={handleResumePick}
      onDismissResumable={dismissResumable}
      />

      {/* 6.14.0: the "are you sure" in front of a live transfer. The upload is
          already paused behind it, so nothing is being wasted while it waits
          for an answer. */}
      <ConfirmModal
        open={cancelCandidate !== null}
        onOpenChange={(next) => {
          if (!next) dismissCancelPrompt()
        }}
        title="Cancel this upload?"
        description={
          <>
            <span className="font-medium text-white">
              {pendingUploads.find((u) => u.id === cancelCandidate)?.videoName ||
                pendingUploads.find((u) => u.id === cancelCandidate)?.file.name}
            </span>{' '}
            is paused. Cancelling discards everything transferred so far and
            removes it — the upload would have to start over. If it was going
            onto an existing video as a new version, it is taken back out of
            that version stack.
          </>
        }
        confirmLabel="Cancel upload"
        cancelLabel="Keep uploading"
        variant="destructive"
        onConfirm={() => {
          const id = cancelCandidate
          resumeAfterCancelRef.current = false
          setCancelCandidate(null)
          if (id) void performRemove(id)
        }}
        onCancel={dismissCancelPrompt}
      />
    </>
  )
}

/**
 * 2.0.x+: bottom-right banner replacement for the old modal
 * dialog. Renders nothing when there are no uploads. While the
 * panel is collapsed it shows a 1-line summary (count + bar);
 * click anywhere on the header to expand the per-file list with
 * pause/resume/cancel controls.
 *
 * Sits ABOVE the processing-status banner via a slightly higher
 * z-index so the user-initiated thing the user actually cares
 * about right now (their pending uploads) wins the visual race.
 * Positioned 200px above the bottom of the viewport so it
 * stacks above the processing banner even when both are visible
 * at once — far from ideal, but a full layout refactor that
 * lifted upload state into a global manager is overkill here.
 */
function UploadBannerView({
  isOpen,
  pendingUploads,
  fileInputRef,
  handleFileSelect,
  handleRemove,
  handlePauseResume,
  handleRetry,
  handleClose,
  allCompleted,
  hasActiveUploads,
  stallNotice,
  onDismissStall,
  resumable,
  resumeMismatch,
  resumeInputRef,
  onResumePick,
  onDismissResumable,
}: {
  isOpen: boolean
  pendingUploads: PendingUpload[]
  fileInputRef: React.RefObject<HTMLInputElement | null>
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleRemove: (id: string) => void | Promise<void>
  handlePauseResume: (id: string) => void
  handleRetry: (id: string) => void
  handleClose: () => void
  /** 6.3.0: name of the file whose upload was cancelled after stalling. */
  stallNotice: string | null
  onDismissStall: () => void
  allCompleted: boolean
  hasActiveUploads: boolean
  /** 6.14.0: an upload a refresh interrupted, waiting for the file again. */
  resumable: ResumableUpload | null
  resumeMismatch: boolean
  resumeInputRef: React.RefObject<HTMLInputElement | null>
  onResumePick: (e: React.ChangeEvent<HTMLInputElement>) => void
  onDismissResumable: () => void
}) {
  const t = useTranslations('videos')
  const tc = useTranslations('common')
  // 2.0.x+: start collapsed so the banner is just a 1-line
  // summary (icon + "Uploading videos" + X/Y done + progress
  // bar). Click the row to expand the per-file list. Matches
  // the ProcessingStatusBanners default behaviour.
  const [expanded, setExpanded] = useState(false)
  // SSR guard: createPortal needs `document.body`, which doesn't
  // exist during Server Components rendering. Defer mounting the
  // portal until after the client hydrates so the upload-progress
  // banner survives the sr-only wrapper that AdminVideoManager
  // sits inside on the project page.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  // Hidden file input is always rendered so external triggers
  // (FolderBrowser drop zone, "Add more videos" button, etc.)
  // can still open the system picker — even when there are no
  // active uploads and the banner itself isn't visible. We keep
  // it OUTSIDE the portal because it lives at the same DOM spot
  // it has always lived at; only the visible UI needs to escape
  // the sr-only wrapper.
  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="video/*,image/jpeg,image/png,image/webp,image/gif"
      multiple
      onChange={handleFileSelect}
      className="hidden"
    />
  )

  // 6.14.0: the resume offer has to survive the "nothing pending" early
  // return — after a refresh there IS nothing pending, which is the entire
  // point. It renders on its own, without the rest of the banner.
  const resumeInput = (
    <input
      ref={resumeInputRef}
      type="file"
      accept="video/*,image/jpeg,image/png,image/webp,image/gif"
      onChange={onResumePick}
      className="hidden"
    />
  )

  const resumeCard =
    mounted && resumable
      ? createPortal(
          // Same glass recipe as the status banners it sits above — translucent
          // navy, accent-tinted radial wash, 40px backdrop blur, hairline ring.
          // The previous flat `#162533/95` box read as a foreign dialog dropped
          // on top of the app instead of another one of its surfaces.
          <div
            className="fixed bottom-4 right-4 z-[2147483750] w-[340px] max-w-[calc(100vw-2rem)] rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white p-3.5 animate-in slide-in-from-bottom-2 fade-in duration-200 overflow-hidden"
            style={{
              backgroundColor: 'rgba(22, 37, 51, 0.62)',
              backgroundImage:
                'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              transform: 'translate3d(0, 0, 0)',
              willChange: 'backdrop-filter, transform',
              isolation: 'isolate',
            }}
            role="status"
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 ring-1 ring-primary/30">
                <Upload className="w-3.5 h-3.5 text-primary" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-tight">
                  Unfinished upload
                </div>
                <div className="text-[11px] text-white/55 mt-0.5 truncate">
                  {resumable.targetName || resumable.fileName}
                </div>
                <p className="text-[11px] text-white/45 mt-2 leading-relaxed">
                  The page reloaded before this finished. Choose the same file
                  again and it carries on from where it stopped — nothing
                  already uploaded is sent twice.
                </p>
                {resumeMismatch && (
                  <p className="text-[11px] text-destructive mt-2">
                    That is a different file. Pick the one that was uploading.
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => resumeInputRef.current?.click()}
                    className="h-8 px-3 rounded-lg bg-primary text-primary-foreground text-[11px] font-semibold hover:brightness-110 transition-[filter]"
                    style={{ color: '#ffffff' }}
                  >
                    Choose file &amp; resume
                  </button>
                  <button
                    type="button"
                    onClick={onDismissResumable}
                    className="h-8 px-3 rounded-lg text-[11px] font-medium text-white/80 bg-white/[0.06] hover:bg-white/[0.12] hover:text-white ring-1 ring-white/15 hover:ring-white/25 transition-colors"
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  if (!isOpen || pendingUploads.length === 0) {
    return (
      <>
        {hiddenInput}
        {resumeInput}
        {resumeCard}
      </>
    )
  }
  if (!mounted) return hiddenInput

  const done = pendingUploads.filter((u) => u.status === 'completed').length
  const total = pendingUploads.length
  const overallPct =
    total > 0
      ? Math.round(
          pendingUploads.reduce(
            (acc, u) => acc + (u.status === 'completed' ? 100 : u.progress),
            0,
          ) / total,
        )
      : 0

  // Portal the banner to document.body so the sr-only wrapper
  // around AdminVideoManager (project page only hosts the modal
  // for its TUS triggers, not for any visible UI) doesn't visually
  // hide the panel.
  return (
    <>
      {hiddenInput}
      {resumeInput}
      {resumeCard}
      {createPortal(
      <div
        className="fixed bottom-4 right-4 z-[2147483700] flex flex-col gap-2 max-w-[calc(100vw-2rem)] pointer-events-none"
        aria-live="polite"
      >
        {/* 6.3.0: a stalled upload deserves an interruption, not a quiet row
            in a collapsed panel — the file is NOT going to finish on its own. */}
        {stallNotice && (
          <div
            role="alert"
            className="pointer-events-auto w-[min(24rem,calc(100vw-2rem))] rounded-xl px-4 py-3 text-white ring-1 ring-red-400/30 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)]"
            style={{
              backgroundColor:
                'color-mix(in srgb, rgb(248 113 113) 14%, hsl(var(--background)))',
            }}
          >
            <div className="flex items-start gap-2.5">
              <X className="w-4 h-4 mt-0.5 text-red-300 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Upload stopped</p>
                <p className="mt-0.5 text-xs text-white/70 break-words">
                  <span className="text-white/90">{stallNotice}</span> sent no
                  data for 30 seconds, so it was cancelled. Check your
                  connection and upload it again.
                </p>
              </div>
              <button
                type="button"
                onClick={onDismissStall}
                className="shrink-0 p-1 rounded-md text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
        <div
          // 2.5.1+: v2.5 frosted glass — match ProcessingStatusBanners
          // and DownloadBanners so the stack reads as a single
          // family of glass cards (the user complained that this
          // upload banner still looked "old" while the encoding
          // banner already had the glass refresh).
          className="pointer-events-auto w-[340px] rounded-xl ring-1 ring-white/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)] text-white animate-in slide-in-from-bottom-2 fade-in duration-200 overflow-hidden"
          style={{
            backgroundColor: 'rgba(22, 37, 51, 0.62)',
            backgroundImage:
              'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.22) 0%, hsl(var(--spotlight-tint) / 0.06) 45%, transparent 75%)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            transform: 'translate3d(0, 0, 0)',
            willChange: 'backdrop-filter, transform',
            isolation: 'isolate',
          }}
          role="status"
        >
          {/* Header — click anywhere on the row (except the X) to
              expand/collapse the per-file list. We use a div here
              rather than a button because the X is a button and
              <button> inside <button> is invalid HTML; React
              would emit a hydration warning. The Enter/Space
              handlers below preserve keyboard accessibility. */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setExpanded((v) => !v)
              }
            }}
            className="w-full text-left p-3 flex items-start gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-expanded={expanded}
            aria-label={`${allCompleted ? t('completed') : t('uploadVideos')}. ${done} / ${total} done. Click to ${expanded ? 'collapse' : 'expand'}.`}
          >
            <div className="shrink-0 mt-0.5">
              {allCompleted ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-300" />
              ) : (
                <Upload className="w-4 h-4 text-primary" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-white truncate">
                {allCompleted ? t('completed') : t('uploadVideos')}
              </div>
              <div className="text-[11px] text-white/55 truncate tabular-nums">
                {done} / {total} done
              </div>
            </div>
            {allCompleted && !hasActiveUploads && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  handleClose()
                }}
                className="shrink-0 -mt-0.5 -mr-0.5 p-1 rounded-md hover:bg-white/[0.08] text-white/55 hover:text-white transition-colors"
                aria-label={tc('done')}
                title={tc('done')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* Progress bar. Uses the average completion across
              all queued uploads as a coarse roll-up. */}
          <div className="px-3 pb-3">
            <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300 ease-out',
                  allCompleted ? 'bg-emerald-400' : 'bg-primary',
                )}
                style={{ width: `${overallPct}%` }}
              />
            </div>
            <div className="mt-1 text-[10px] text-white/55 tabular-nums">
              {overallPct}%
            </div>
          </div>
          {expanded && (
            <div className="border-t border-white/10 max-h-[260px] overflow-y-auto">
              <ul className="divide-y divide-white/10">
                {pendingUploads.map((upload) => (
                  <UploadRow
                    key={upload.id}
                    upload={upload}
                    onPauseResume={() => handlePauseResume(upload.id)}
                    onRemove={() => handleRemove(upload.id)}
                    onRetry={() => handleRetry(upload.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>,
      document.body,
      )}

    </>
  )
}

function UploadRow({
  upload,
  onPauseResume,
  onRemove,
  onRetry,
}: {
  upload: PendingUpload
  onPauseResume: () => void
  onRemove: () => void
  onRetry: () => void
}) {
  const tc = useTranslations('common')
  // Lazily-imported only inside this row because the parent
  // banner doesn't need it. Keeps the bundle slim.
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 hover:bg-white/[0.06] transition-colors">
      <div className="shrink-0 mt-0.5">
        {upload.status === 'completed' ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-300" />
        ) : upload.status === 'error' ? (
          <X className="w-4 h-4 text-red-300" />
        ) : upload.status === 'cancelling' ? (
          <Loader2 className="w-4 h-4 text-white/55 animate-spin" />
        ) : upload.paused ? (
          <Pause className="w-4 h-4 text-amber-400" />
        ) : (
          <Video className="w-4 h-4 text-primary" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-xs font-medium text-white truncate"
          title={upload.videoName || upload.file.name}
        >
          {upload.videoName || upload.file.name}
        </div>
        <div className="text-[10px] text-white/55 truncate tabular-nums">
          {upload.status === 'completed'
            ? formatFileSize(upload.file.size)
            : upload.status === 'cancelling'
              // 6.14.0: the row stays until the server has actually stopped
              // and the partial file is gone. Removing it the instant the X
              // was clicked is what made "cancelled" a lie.
              ? 'Cancelling — removing what was uploaded…'
            : upload.status === 'error'
              ? (upload.error || 'Failed')
              : upload.stalled
              ? 'Stalled — reconnecting…'
              : `${upload.progress}% · ${formatFileSize(upload.file.size)}${
                  upload.paused
                    ? ''
                    // 6.3.0: show the rate ALWAYS while running, including
                    // 0 MB/s. A blank where the speed should be looked like
                    // a healthy upload; a visible zero is the warning sign.
                    : ` · ${upload.speed.toFixed(1)} MB/s`
                }`}
        </div>
        {(upload.status === 'uploading' ||
          upload.status === 'pending' ||
          upload.status === 'cancelling') && (
          <div className="mt-1 h-1 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                upload.status === 'cancelling'
                  ? 'bg-white/25'
                  : upload.paused
                    ? 'bg-amber-400'
                    : 'bg-primary',
              )}
              style={{ width: `${upload.progress}%` }}
            />
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {upload.status === 'uploading' && (
          <button
            type="button"
            onClick={onPauseResume}
            className="p-1 rounded-md hover:bg-white/[0.08] text-white/55 hover:text-white transition-colors"
            aria-label={upload.paused ? 'Resume' : 'Pause'}
            title={upload.paused ? 'Resume' : 'Pause'}
          >
            {upload.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
        )}
        {upload.status === 'error' && (
          <button
            type="button"
            onClick={onRetry}
            className="text-[10px] px-1.5 py-0.5 rounded-md hover:bg-white/[0.08] text-white/55 hover:text-white transition-colors"
            title={tc('retry')}
          >
            {tc('retry')}
          </button>
        )}
        {upload.status !== 'completed' && (
          <button
            type="button"
            disabled={upload.status === 'cancelling'}
            onClick={onRemove}
            className="p-1 rounded-md hover:bg-white/[0.08] text-white/55 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={tc('remove')}
            title={tc('remove')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </li>
  )
}
