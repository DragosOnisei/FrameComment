'use client'

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Upload, Video, X, Pause, Play, CheckCircle2 } from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import * as tus from 'tus-js-client'
import { apiPost, apiDelete } from '@/lib/api-client'
import { logError } from '@/lib/logging'
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
} from '@/lib/tus-context'
import { useStorageProvider } from '@/components/StorageConfigProvider'
import { useS3MultipartUpload } from '@/hooks/useS3MultipartUpload'

interface PendingUpload {
  id: string
  file: File
  videoName: string
  versionLabel: string
  status: 'pending' | 'uploading' | 'completed' | 'error'
  progress: number
  speed: number
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

  // Maximum length for video names (fits comfortably in modal)
  const MAX_VIDEO_NAME_LENGTH = 50
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

  const addFiles = (files: File[]) => {
    if (files.length > 0) {
      const newUploads: PendingUpload[] = files.map(file => ({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        videoName: getVideoNameFromFile(file),
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
    const newUploads: PendingUpload[] = accepted.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      videoName: getVideoNameFromFile(file),
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
    const newUploads: PendingUpload[] = accepted.map((entry) => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file: entry.file,
      videoName: getVideoNameFromFile(entry.file),
      versionLabel: '',
      status: 'pending',
      progress: 0,
      speed: 0,
      folderIdOverride: entry.folderId,
      stackOntoVideoId: entry.stackOntoVideoId,
    }))
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

  const handleRemove = (id: string) => {
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
    const itemSnapshot = pendingUploads.find(u => u.id === id)

    const tusUpload = uploadRefs.current.get(id)
    if (tusUpload) {
      tusUpload.abort(true)
      uploadRefs.current.delete(id)
    }
    const s3Key = s3UploadKeys.current.get(id)
    if (s3Key) {
      abortS3Upload(s3Key)
      s3UploadKeys.current.delete(id)
    }
    if (itemSnapshot) {
      // Best-effort: clear localStorage so the next attempt starts
      // a fresh session instead of trying to resume a dead one.
      try { clearTUSFingerprint(itemSnapshot.file) } catch {}
      try { clearUploadMetadata(itemSnapshot.file) } catch {}
      // Best-effort: delete the DB record. Fire-and-forget — if it
      // fails (network blip, race with worker), the cleanup job will
      // catch it within 24 h via the UPLOADING-too-long sweep.
      //
      // 1.5.8: `?permanent=1` skips the Trash bucket. A canceled
      // upload never produced anything the user wants to recover,
      // so soft-deleting it would just clutter the Trash with
      // half-finished rows the cleanup job has to sweep anyway.
      if (itemSnapshot.videoId) {
        apiDelete(`/api/videos/${itemSnapshot.videoId}?permanent=1`).catch(() => {
          /* silent — cleanup job will pick it up later */
        })
      }
    }
    setPendingUploads(prev => prev.filter(u => u.id !== id))
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
      const canResumeExisting =
        existingMetadata?.projectId === projectId &&
        !!existingMetadata.videoId &&
        existingMetadata?.targetName === trimmedVideoName &&
        (existingMetadata.versionLabel || '') === (trimmedVersionLabel || '')

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
              setPendingUploads(prev => prev.map(u =>
                u.id === id ? { ...u, progress: percentage, speed: speed || u.speed } : u
              ))
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

          setPendingUploads(prev => prev.map(u =>
            u.id === id ? { ...u, progress: percentage, speed: speed || u.speed } : u
          ))
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
    // Only allow close if no uploads are in progress
    const hasActiveUploads = pendingUploads.some(u => u.status === 'uploading')
    if (hasActiveUploads) return

    // Clean up completed uploads from the list
    setPendingUploads([])
    onClose()
  }

  const hasActiveUploads = pendingUploads.some(u => u.status === 'uploading')
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

  // 2.0.x+: banner-style flow — once every upload in the panel
  // has flipped to `completed`, leave the "all done" tick on
  // screen for ~5 s so the user gets to acknowledge it, then
  // dismiss the banner automatically (clears state via the
  // existing handleClose). If the user adds more files during
  // the grace window we cancel the timer.
  useEffect(() => {
    if (!allCompleted) return
    const id = setTimeout(() => {
      setPendingUploads([])
      onClose()
    }, 5_000)
    return () => clearTimeout(id)
  }, [allCompleted, onClose])

  return (
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
    />
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
}: {
  isOpen: boolean
  pendingUploads: PendingUpload[]
  fileInputRef: React.RefObject<HTMLInputElement | null>
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleRemove: (id: string) => void
  handlePauseResume: (id: string) => void
  handleRetry: (id: string) => void
  handleClose: () => void
  allCompleted: boolean
  hasActiveUploads: boolean
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

  if (!isOpen || pendingUploads.length === 0) return hiddenInput
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
      {createPortal(
      <div
        className="fixed bottom-4 right-4 z-[2147483700] flex flex-col gap-2 max-w-[calc(100vw-2rem)] pointer-events-none"
        aria-live="polite"
      >
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
            : upload.status === 'error'
              ? (upload.error || 'Failed')
              : `${upload.progress}% · ${formatFileSize(upload.file.size)}${
                  upload.speed > 0 && !upload.paused
                    ? ` · ${upload.speed} MB/s`
                    : ''
                }`}
        </div>
        {(upload.status === 'uploading' || upload.status === 'pending') && (
          <div className="mt-1 h-1 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                upload.paused ? 'bg-amber-400' : 'bg-primary',
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
            onClick={onRemove}
            className="p-1 rounded-md hover:bg-white/[0.08] text-white/55 hover:text-white transition-colors"
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
