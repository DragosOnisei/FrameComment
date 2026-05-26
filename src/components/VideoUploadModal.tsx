'use client'

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Upload, Video, X, Plus, Pause, Play, CheckCircle2, Lightbulb } from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import * as tus from 'tus-js-client'
import { apiPost, apiDelete } from '@/lib/api-client'
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
}

interface VideoUploadModalProps {
  isOpen: boolean
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
  initialFilesWithFolders?: Array<{ file: File; folderId: string | null }> | null
  /** Optional folder to upload into. When set, the server attaches
   *  the new video to this folder; when null/undefined, the video
   *  goes to the project root (legacy / dashboard behaviour). */
  folderId?: string | null
}

export function VideoUploadModal({ isOpen, onClose, projectId, onUploadComplete, initialFiles, initialFilesWithFolders, folderId }: VideoUploadModalProps) {
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
    Array<{ file: File; folderId: string | null }> | null
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
      if (itemSnapshot.videoId) {
        apiDelete(`/api/videos/${itemSnapshot.videoId}`).catch(() => {
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
                try { await apiDelete(`/api/videos/${videoId}`) } catch {}
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
            try {
              await apiDelete(`/api/videos/${videoId}`)
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

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-lg overflow-hidden" onPointerDownOutside={(e) => hasActiveUploads && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            {t('uploadVideos')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* 1.5.7: VPN/LAN hint — shown only when the user is accessing
              FrameComment via a public hostname (i.e. via a CDN/reverse
              proxy that may throttle sustained uploads). Disappears once
              an upload is active to avoid distracting from progress. */}
          {isPublicHost && !hasActiveUploads && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-200/90">
              <Lightbulb className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-400" />
              <span className="leading-relaxed">{t('remoteHostHint')}</span>
            </div>
          )}

          {/* Drop zone - only show when no active uploads */}
          {!hasActiveUploads && (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-xl p-8 transition-all cursor-pointer text-center',
                isDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50 hover:bg-accent/30'
              )}
            >
              <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {isDragging ? t('dropVideosHere') : t('dropVideosOrBrowse')}
              </p>
            </div>
          )}

          {/* Uploads list */}
          {pendingUploads.length > 0 && (
            <div className="space-y-3 max-h-[400px] overflow-y-auto overflow-x-hidden">
              {pendingUploads.map((upload) => (
                <div key={upload.id} className="border rounded-lg p-3 bg-card overflow-hidden">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="shrink-0 mt-1">
                      {upload.status === 'completed' ? (
                        <CheckCircle2 className="w-5 h-5 text-success" />
                      ) : (
                        <Video className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      {/* Video name input */}
                      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                        <Input
                          value={upload.videoName}
                          onChange={(e) => handleUpdateName(upload.id, e.target.value)}
                          placeholder={t('videoName')}
                          className="h-9 flex-1 min-w-0"
                          disabled={upload.status !== 'pending'}
                          maxLength={MAX_VIDEO_NAME_LENGTH}
                        />
                        {upload.status === 'pending' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemove(upload.id)}
                            className="h-9 w-9 shrink-0"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                      </div>

                      {/* Version label input */}
                      {upload.status === 'pending' && (
                        <Input
                          value={upload.versionLabel}
                          onChange={(e) => handleUpdateVersionLabel(upload.id, e.target.value)}
                          placeholder={t('versionLabelPlaceholder')}
                          className="h-8 text-sm w-full min-w-0"
                        />
                      )}

                      {/* File info */}
                      <div className="text-xs text-muted-foreground">
                        <span title={upload.file.name}>{truncateFilename(upload.file.name, MAX_FILENAME_DISPLAY_LENGTH)}</span>
                        <span> ({formatFileSize(upload.file.size)})</span>
                      </div>

                      {/* Progress bar */}
                      {(upload.status === 'uploading' || upload.status === 'completed') && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">
                              {upload.paused ? t('paused') : upload.status === 'completed' ? t('completed') : t('uploading')}
                            </span>
                            <span className="font-medium">{upload.progress}%</span>
                          </div>
                          <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
                            <div
                              className={cn(
                                "h-full transition-all",
                                upload.status === 'completed' ? 'bg-success' : upload.paused ? 'bg-warning' : 'bg-primary'
                              )}
                              style={{ width: `${upload.progress}%` }}
                            />
                          </div>
                          {upload.speed > 0 && upload.status === 'uploading' && !upload.paused && (
                            <p className="text-xs text-muted-foreground">
                              {t('speed')} {upload.speed} MB/s
                            </p>
                          )}
                        </div>
                      )}

                      {/* Upload controls */}
                      {upload.status === 'uploading' && (
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePauseResume(upload.id)}
                            className="flex-1 h-8"
                          >
                            {upload.paused ? (
                              <>
                                <Play className="w-3 h-3 mr-1" />
                                {t('resume')}
                              </>
                            ) : (
                              <>
                                <Pause className="w-3 h-3 mr-1" />
                                {t('pause')}
                              </>
                            )}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleRemove(upload.id)}
                            className="h-8"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      )}

                      {/* Error state */}
                      {upload.status === 'error' && (
                        <div className="space-y-2">
                          <p className="text-xs text-destructive break-words">{upload.error}</p>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRetry(upload.id)}
                              className="h-8"
                            >
                              {tc('retry')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemove(upload.id)}
                              className="h-8"
                            >
                              {tc('remove')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add more button */}
          {pendingUploads.length > 0 && !hasActiveUploads && !allCompleted && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <Plus className="w-4 h-4 mr-2" />
              {t('addMoreVideos')}
            </Button>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={hasActiveUploads}
            >
              {allCompleted ? tc('done') : tc('cancel')}
            </Button>
            {hasPendingItems && !hasActiveUploads && (
              <Button onClick={handleStartAll}>
                <Upload className="w-4 h-4 mr-2" />
                {t('startUpload')}
              </Button>
            )}
          </div>

          {/* Help text */}
          {!hasActiveUploads && !allCompleted && (
            <p className="text-xs text-muted-foreground text-center">
              {t('versionLabelHint')}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
