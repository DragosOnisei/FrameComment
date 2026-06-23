'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Mic, Square, Trash2, Check, Loader2, ChevronDown, Play, Pause, Send } from 'lucide-react'
import * as tus from 'tus-js-client'
import {
  createTusAfterResponseHandler,
  createTusShouldRetryHandler,
  getTusUploadErrorMessage,
} from '@/lib/tus-error'
import { getTusChunkSizeBytes, TUS_RETRY_DELAYS_MS } from '@/lib/transfer-tuning'
import { ensureFreshUploadOnContextChange } from '@/lib/tus-context'
import { useS3MultipartUpload } from '@/hooks/useS3MultipartUpload'
import { useStorageProvider } from '@/components/StorageConfigProvider'
import { getAccessToken } from '@/lib/token-store'

interface PendingAttachment {
  assetId: string
  videoId: string
  fileName: string
  fileSize: string
  fileType: string
  category: string
}

interface VoiceRecorderButtonProps {
  videoId: string
  shareToken: string | null
  onAttachmentAdded: (attachment: PendingAttachment) => void
  disabled?: boolean
  /** Fires whenever the recorder enters or leaves an active state
   *  (recording in progress, or showing the post-recording preview).
   *  The parent (CommentInput) uses this to hide sibling icons so the
   *  recorder UI gets the whole input row to itself. */
  onActiveChange?: (active: boolean) => void
  /** 1.9.1+: exposes uploadRecording() to the parent while a voice
   *  message is in preview, and null otherwise. The parent's own
   *  Send button calls this so we don't have to render a duplicate
   *  send icon inside the recorder. */
  onReadyToSendChange?: (send: (() => void) | null) => void
}

const MAX_DURATION_SECONDS = 300 // 5 minutes
const MAX_DURATION_MS = MAX_DURATION_SECONDS * 1000

/**
 * Pick the first MIME type the browser actually supports.
 * Chrome/Firefox: webm/opus. Safari 14.1+: mp4/aac.
 */
function pickMimeType(): { mimeType: string; extension: string } {
  if (typeof MediaRecorder === 'undefined') {
    return { mimeType: 'audio/webm', extension: 'webm' }
  }
  const candidates: Array<{ mimeType: string; extension: string }> = [
    { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
    { mimeType: 'audio/webm', extension: 'webm' },
    { mimeType: 'audio/mp4', extension: 'm4a' },
    { mimeType: 'audio/aac', extension: 'm4a' },
    { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c
  }
  return { mimeType: '', extension: 'webm' }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Strip USB vendor:product ids and similar trailing codes that the browser
 * appends to MediaDeviceInfo.label, e.g.
 *   "Trust USB microphone (145f:02b4)" → "Trust USB microphone"
 *   "Default - MacBook Pro Microphone (Built-in)" → "Default - MacBook Pro Microphone"
 * We only strip the trailing parenthesised group when it looks like an id
 * (vendor:product hex) or starts with "Built-in" / "Builtin".
 */
function cleanDeviceLabel(label: string | undefined): string {
  if (!label) return ''
  return label
    // Strip vendor:product ids like "(145f:02b4)" at the end
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    // Strip "(Built-in)" / "(Builtin)" suffix
    .replace(/\s*\(Built-?in\)\s*$/i, '')
    .trim()
}

export default function VoiceRecorderButton({
  videoId,
  shareToken,
  onAttachmentAdded,
  disabled = false,
  onActiveChange,
  onReadyToSendChange,
}: VoiceRecorderButtonProps) {
  const storageProvider = useStorageProvider()
  const { startUpload: startS3Upload } = useS3MultipartUpload()

  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)

  // Notify the parent whenever we enter/leave an active state so it can
  // hide sibling icons (draw, paperclip) and let us take the whole row.
  useEffect(() => {
    onActiveChange?.(isRecording || !!recordedBlob)
  }, [isRecording, recordedBlob, onActiveChange])
  const [recordedExt, setRecordedExt] = useState<string>('webm')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 3.3.x: whether this browser can record audio at all. `getUserMedia`
  // is only exposed in a secure context (HTTPS or localhost); on a
  // plain-HTTP LAN origin `navigator.mediaDevices` is undefined and
  // there's no way to capture the mic. We resolve this on mount (not
  // during render) so server + first client render agree (no hydration
  // mismatch), then hide the whole recorder when unsupported. Starts
  // false so SSR renders nothing until the client confirms support.
  const [micSupported, setMicSupported] = useState(false)
  useEffect(() => {
    setMicSupported(
      typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function',
    )
  }, [])
  // When the browser has permanently denied mic access we can't trigger the
  // native permission prompt again — we must show the user how to re-enable it.
  const [showPermissionHelp, setShowPermissionHelp] = useState(false)
  // Available audio input devices and the user's selected one. Empty until
  // permission has been granted at least once (browsers hide labels otherwise).
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  // 1.9.1+: persist selected mic to localStorage so the user's pick survives
  // page reloads and tab restarts. Lazy init reads on mount; the next effect
  // writes on every change.
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    try {
      return window.localStorage.getItem('framecomment.preferred-mic-id') || ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (selectedDeviceId) {
        window.localStorage.setItem('framecomment.preferred-mic-id', selectedDeviceId)
      } else {
        // 3.2.x: clear the persisted id when the selection is reset
        // (e.g. after a stale device caused getUserMedia to fail and we
        // fell back to the default). Without this, the bad id would be
        // re-read on the next mount and keep breaking recording.
        window.localStorage.removeItem('framecomment.preferred-mic-id')
      }
    } catch {
      // localStorage can throw in private mode / disabled — non-fatal.
    }
  }, [selectedDeviceId])
  // 1.9.1+: device picker popover open state + outside-click ref.
  const [showDevicePicker, setShowDevicePicker] = useState(false)
  const devicePickerRef = useRef<HTMLDivElement>(null)
  // 2.5.1+: ref on the chevron trigger so the portalled popover can
  // compute a viewport-fixed position anchored to it.
  const devicePickerTriggerRef = useRef<HTMLButtonElement>(null)
  const devicePickerPopoverRef = useRef<HTMLDivElement>(null)
  const [devicePickerCoords, setDevicePickerCoords] = useState<{
    left: number
    bottom: number
  } | null>(null)
  useEffect(() => {
    if (!showDevicePicker) return
    // Click anywhere outside BOTH the trigger AND the portalled
    // popover closes the picker. We have to check the popover ref
    // explicitly because it lives under document.body now — the
    // original devicePickerRef wrapper no longer contains it.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (devicePickerRef.current?.contains(target)) return
      if (devicePickerPopoverRef.current?.contains(target)) return
      setShowDevicePicker(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showDevicePicker])
  // Compute / refresh the popover position whenever it opens or the
  // page scrolls / resizes underneath it.
  useEffect(() => {
    if (!showDevicePicker) return
    const compute = () => {
      const el = devicePickerTriggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // Anchor the popover so its LEFT edge sits ~60 px to the
      // LEFT of the trigger — a moderate shift that puts the
      // popover comfortably inside the comments sidebar without
      // drifting too far from the chevron. Clamp at 8 px from the
      // viewport edge so it never bleeds off the screen on narrow
      // layouts.
      setDevicePickerCoords({
        left: Math.max(8, rect.left - 60),
        bottom: window.innerHeight - rect.top + 8,
      })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [showDevicePicker])
  // Live waveform: a small ring of recent volume samples (0..1) for animation.
  const [waveSamples, setWaveSamples] = useState<number[]>(Array(24).fill(0.05))

  // 1.9.1+: preview-mode playback state for the in-app waveform
  // player. We don't show native <audio controls> any more — the
  // theme-styled play/pause + wave bars take care of the UX.
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackProgress, setPlaybackProgress] = useState(0) // 0..1
  const [isScrubbingPreview, setIsScrubbingPreview] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewBarsRef = useRef<HTMLDivElement | null>(null)
  const togglePlayback = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      void a.play()
    } else {
      a.pause()
    }
  }, [])
  // 1.9.1+: scrub helper. Chrome's MediaRecorder webm blobs have no
  // duration metadata so `audio.duration` is often `Infinity` —
  // we fall back to the recorded `duration` state captured at
  // record-time. This is shared by click-to-seek and the drag
  // handler so both paths agree on total length.
  // PREVIEW_TRACK_INSET (px) matches the `px-2` on the outer
  // container so the thumb's full 12 px circle stays visible at
  // both 0 % and 100 % without overlapping the play button or the
  // delete/send icons. seek math subtracts the inset on both sides.
  const PREVIEW_TRACK_INSET = 8
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const a = audioRef.current
      const rect = previewBarsRef.current?.getBoundingClientRect()
      if (!a || !rect) return
      const trackWidth = rect.width - PREVIEW_TRACK_INSET * 2
      if (trackWidth <= 0) return
      const x = clientX - rect.left - PREVIEW_TRACK_INSET
      const pct = Math.max(0, Math.min(1, x / trackWidth))
      const total =
        Number.isFinite(a.duration) && a.duration > 0 ? a.duration : duration
      if (total <= 0) return
      try {
        a.currentTime = pct * total
      } catch {
        // Some browsers throw on seek-while-loading; ignore.
      }
      setPlaybackProgress(pct)
    },
    [duration],
  )
  // 1.9.1+: drive playbackProgress at 60fps via rAF while playing
  // instead of relying on the audio element's onTimeUpdate (which
  // fires only 4-6 times/sec → visibly choppy thumb motion).
  // Pauses cleanly when isPlaying flips false or the user starts
  // scrubbing (so we don't fight a finger drag).
  useEffect(() => {
    if (!isPlaying || isScrubbingPreview) return
    let raf = 0
    const tick = () => {
      const a = audioRef.current
      if (a) {
        const total =
          Number.isFinite(a.duration) && a.duration > 0 ? a.duration : duration
        if (total > 0) {
          setPlaybackProgress(Math.min(1, a.currentTime / total))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, isScrubbingPreview, duration])
  const handlePreviewMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      seekFromClientX(e.clientX)
      setIsScrubbingPreview(true)
    },
    [seekFromClientX],
  )
  const handlePreviewTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      seekFromClientX(t.clientX)
      setIsScrubbingPreview(true)
    },
    [seekFromClientX],
  )
  useEffect(() => {
    if (!isScrubbingPreview) return
    const onMouseMove = (e: MouseEvent) => seekFromClientX(e.clientX)
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t) seekFromClientX(t.clientX)
    }
    const onUp = () => setIsScrubbingPreview(false)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchend', onUp)
    window.addEventListener('touchcancel', onUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchend', onUp)
      window.removeEventListener('touchcancel', onUp)
    }
  }, [isScrubbingPreview, seekFromClientX])

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const startTimeRef = useRef<number>(0)
  const tickRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  const cleanupStream = useCallback(() => {
    if (tickRef.current) {
      window.clearInterval(tickRef.current)
      tickRef.current = null
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
      analyserRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  // Stop everything on unmount
  useEffect(() => {
    return () => {
      cleanupStream()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [cleanupStream, previewUrl])

  // Enumerate audio inputs as soon as we mount, so the user can pick a mic
  // before they ever press record. Browsers hide labels until permission has
  // been granted, but we still show the device count + generic labels — and
  // we listen to `devicechange` so the dropdown updates if the user plugs in
  // a different mic mid-session.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return

    let cancelled = false

    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        const allInputs = all.filter((d) => d.kind === 'audioinput')
        // The browser typically returns the same physical mic twice — once
        // with deviceId='default' (or 'communications') and once with the
        // real id. They share a groupId. Prefer the 'default' / 'communications'
        // entry when both exist so we don't show duplicates in the dropdown.
        const groupsWithDefault = new Set(
          allInputs
            .filter((d) => d.deviceId === 'default' || d.deviceId === 'communications')
            .map((d) => d.groupId)
            .filter(Boolean)
        )
        const inputs = allInputs.filter((d) => {
          if (d.deviceId === 'default' || d.deviceId === 'communications') return true
          // Drop the duplicate real-id entry when a default/communications
          // entry already covers this group.
          return !d.groupId || !groupsWithDefault.has(d.groupId)
        })
        setAudioDevices(inputs)
        // Pick the system default (or first available) initially.
        setSelectedDeviceId((current) => {
          if (current && inputs.some((d) => d.deviceId === current)) return current
          const def =
            inputs.find((d) => d.deviceId === 'default') ||
            inputs.find((d) => d.deviceId === 'communications') ||
            inputs[0]
          return def?.deviceId || ''
        })
      } catch {
        // Non-fatal: the picker just stays hidden.
      }
    }

    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [])

  const startRecording = useCallback(async () => {
    setError(null)
    // 3.2.x: secure-context guard. Browsers only expose
    // `navigator.mediaDevices.getUserMedia` on HTTPS or localhost. On a
    // plain-HTTP LAN origin (e.g. http://192.168.x.x) `mediaDevices` is
    // undefined and no app code can grant mic access — so surface the
    // real reason instead of the generic "Could not access microphone."
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(
        typeof window !== 'undefined' && window.isSecureContext === false
          ? 'Voice comments need a secure (HTTPS) connection — they don’t work over plain HTTP.'
          : 'This browser doesn’t support microphone recording.',
      )
      return
    }
    try {
      // If the user has picked a specific input device, request it as a
      // PREFERENCE (non-exact) so the browser falls back to the default
      // when that device is gone. A stale saved id (USB mic unplugged,
      // different machine, localStorage carried over) must not hard-fail
      // recording — the old `{ exact: … }` constraint threw
      // OverconstrainedError, which surfaced as "Could not access
      // microphone." even though a working default mic was present.
      const audioConstraints: MediaTrackConstraints | true = selectedDeviceId
        ? { deviceId: selectedDeviceId }
        : true
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      } catch (constraintErr) {
        // Even non-exact constraints can still throw on some browsers
        // when the saved device id is invalid. Clear the persisted pick
        // and retry once with the default device before giving up.
        if (
          selectedDeviceId &&
          constraintErr instanceof Error &&
          (constraintErr.name === 'OverconstrainedError' ||
            constraintErr.name === 'NotFoundError')
        ) {
          setSelectedDeviceId('')
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } else {
          throw constraintErr
        }
      }
      streamRef.current = stream

      // Now that permission has been granted, we can read device labels.
      // Refresh the available-devices list so the picker shows real names.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const inputs = devices.filter((d) => d.kind === 'audioinput')
        setAudioDevices(inputs)
        if (!selectedDeviceId) {
          // Persist the device the browser actually picked so the picker
          // reflects what's recording.
          const track = stream.getAudioTracks()[0]
          const settings = track?.getSettings?.()
          if (settings?.deviceId) setSelectedDeviceId(settings.deviceId)
        }
      } catch {
        // enumerateDevices is decorative; ignore failures.
      }

      // Set up an analyser for the live waveform
      try {
        const ctx = new AudioContext()
        // 1.9.1+: resume the context if it landed in `suspended` (some
        // browsers create AudioContexts paused until the next user
        // gesture — without resuming the analyser gets no samples).
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {})
        }
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        // 1.9.1+: route the analyser into a MUTED gain that connects
        // to destination. Without ANY connection to destination, the
        // Web Audio graph is treated as inactive in Chromium and the
        // analyser stops pulling samples → flat-line visualiser. The
        // gain at 0 ensures nothing is actually audible (no feedback).
        const sinkGain = ctx.createGain()
        sinkGain.gain.value = 0
        analyser.connect(sinkGain)
        sinkGain.connect(ctx.destination)
        audioContextRef.current = ctx
        analyserRef.current = analyser

        // Use the time-domain data (waveform) instead of frequency
        // bins — voice tracks RMS amplitude over time and gives a
        // far more reactive bar height than averaging FFT bins.
        const dataArray = new Uint8Array(analyser.fftSize)
        const tick = () => {
          if (!analyserRef.current) return
          analyserRef.current.getByteTimeDomainData(dataArray)
          // Compute RMS of the centred waveform (samples are 0..255
          // with 128 as silence midpoint).
          let sumSq = 0
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128
            sumSq += v * v
          }
          const rms = Math.sqrt(sumSq / dataArray.length)
          // Boost a bit so quiet voice still moves the bars visibly,
          // clamp to [0.05, 1].
          const level = Math.max(0.05, Math.min(1, rms * 2.5))
          setWaveSamples((prev) => [...prev.slice(1), level])
          animationFrameRef.current = requestAnimationFrame(tick)
        }
        animationFrameRef.current = requestAnimationFrame(tick)
      } catch {
        // Analyser is decorative, do not fail recording if it cannot start.
      }

      const { mimeType, extension } = pickMimeType()
      setRecordedExt(extension)

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        setRecordedBlob(blob)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(URL.createObjectURL(blob))
        setIsRecording(false)
        cleanupStream()
      }

      startTimeRef.current = Date.now()
      setDuration(0)
      tickRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        setDuration(elapsed)
        if (elapsed * 1000 >= MAX_DURATION_MS) {
          recorder.stop()
        }
      }, 100)

      recorder.start(250)
      setIsRecording(true)
    } catch (err) {
      // NotAllowedError = either the user just clicked "Block", or the
      // permission was already permanently denied for this origin. Either
      // way the browser will not show its native popup again until the user
      // resets the permission via the lock icon — so we open our own help
      // dialog with the exact steps.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setShowPermissionHelp(true)
      } else if (err instanceof Error && err.name === 'NotFoundError') {
        setError('No microphone found on this device.')
      } else {
        setError('Could not access microphone.')
      }
      cleanupStream()
    }
  }, [cleanupStream, previewUrl, selectedDeviceId])

  const stopRecording = useCallback(() => {
    const r = mediaRecorderRef.current
    if (r && r.state !== 'inactive') {
      r.stop()
    }
  }, [])

  const cancel = useCallback(() => {
    cleanupStream()
    // 1.9.1+: stop preview playback if it's running.
    const a = audioRef.current
    if (a && !a.paused) a.pause()
    setIsPlaying(false)
    setPlaybackProgress(0)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setRecordedBlob(null)
    setIsRecording(false)
    setDuration(0)
    setError(null)
    chunksRef.current = []
  }, [cleanupStream, previewUrl])

  const uploadRecording = useCallback(async () => {
    if (!recordedBlob) return
    // 1.9.1+: idempotency guard. The parent's Send button now
    // calls this directly; without the guard, double-tapping
    // could fire two concurrent uploads.
    if (isUploading) return
    setIsUploading(true)
    setError(null)

    try {
      const fileName = `voice-${Date.now()}.${recordedExt}`
      const file = new File([recordedBlob], fileName, { type: recordedBlob.type || 'audio/webm' })

      // Step 1: register the asset to get an assetId.
      // 1.9.1+: pick the right bearer based on context — shareToken
      // for client/guest viewers, admin access token for admin view.
      // Without this, admin uploads went out unauthenticated → 401
      // "Authentication failed" once attachments were enabled.
      const createUrl = `/api/videos/${videoId}/client-assets`
      const createBody = JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'audio/webm',
        category: 'audio',
      })
      const adminAccessToken = getAccessToken()
      const createHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (shareToken) {
        createHeaders.Authorization = `Bearer ${shareToken}`
      } else if (adminAccessToken) {
        createHeaders.Authorization = `Bearer ${adminAccessToken}`
      }
      const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: createHeaders,
        body: createBody,
        credentials: 'include',
      })
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to create voice asset')
      }
      const { assetId } = await createRes.json()

      // Step 2: upload the file bytes (S3 multipart or TUS, mirroring the
      // file-attachment flow).
      if (storageProvider === 's3') {
        await new Promise<void>((resolve, reject) => {
          startS3Upload(
            file,
            { assetId, bearerToken: shareToken || undefined },
            {
              onSuccess: () => resolve(),
              onError: (err) => reject(err),
            }
          )
        })
      } else {
        ensureFreshUploadOnContextChange(file, `client:${videoId}:${assetId}`)
        await new Promise<void>((resolve, reject) => {
          const uploadRef = { current: null as tus.Upload | null }
          const upload = new tus.Upload(file, {
            endpoint: `${window.location.origin}/api/uploads`,
            chunkSize: getTusChunkSizeBytes(file.size),
            retryDelays: TUS_RETRY_DELAYS_MS,
            // Keep metadata minimal — auth flows through the Authorization
            // header that we attach via `onBeforeRequest` below, mirroring
            // how `CommentAttachmentButton` does it.
            metadata: {
              filename: file.name,
              filetype: file.type || 'audio/webm',
              assetId,
            },
            storeFingerprintForResuming: true,
            removeFingerprintOnSuccess: true,
            onAfterResponse: createTusAfterResponseHandler(uploadRef),
            onShouldRetry: createTusShouldRetryHandler(uploadRef),
            onBeforeRequest: (req) => {
              const xhr = req.getUnderlyingObject() as XMLHttpRequest
              xhr.withCredentials = true
              // 1.9.1+: same fallback path as the create-asset call —
              // shareToken when a client/guest is uploading, else the
              // admin's in-memory access token. Without this the TUS
              // PATCHes hit the server unauthenticated and the user
              // saw "Authentication failed" mid-upload.
              if (shareToken) {
                xhr.setRequestHeader('Authorization', `Bearer ${shareToken}`)
              } else {
                const adminToken = getAccessToken()
                if (adminToken) {
                  xhr.setRequestHeader('Authorization', `Bearer ${adminToken}`)
                }
              }
            },
            onError: (err) => {
              reject(new Error(getTusUploadErrorMessage(err) || 'Upload failed'))
            },
            onSuccess: () => resolve(),
          })
          uploadRef.current = upload
          upload.start()
        })
      }

      const attachment = {
        assetId,
        videoId,
        fileName: file.name,
        fileSize: String(file.size),
        fileType: file.type || 'audio/webm',
        category: 'audio',
      }
      onAttachmentAdded(attachment)

      // 1.9.1+: auto-post is handled in CommentInput via a
      // pendingAttachments watcher + a "user just sent voice"
      // ref flag. No event needed — that pattern had stale-closure
      // problems where the listener fired before React had
      // committed the new attachment to state, so the auto-submit
      // saw an empty pendingAttachments and bailed out.

      // Reset the local UI state so the user can record another one.
      cancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsUploading(false)
    }
  }, [
    recordedBlob,
    recordedExt,
    videoId,
    shareToken,
    storageProvider,
    startS3Upload,
    onAttachmentAdded,
    cancel,
    isUploading,
  ])

  // 1.9.1+: expose uploadRecording to the parent while we have a
  // recorded blob in preview (and aren't already uploading). The
  // parent's official Send button calls this directly so the user
  // sees a single send icon — no in-recorder duplicate.
  useEffect(() => {
    if (!onReadyToSendChange) return
    if (recordedBlob && !isUploading) {
      onReadyToSendChange(uploadRecording)
      return () => onReadyToSendChange(null)
    }
    onReadyToSendChange(null)
  }, [recordedBlob, isUploading, uploadRecording, onReadyToSendChange])

  // ---------- Render ----------

  // 3.3.x: no audio recording on insecure origins (plain HTTP / LAN
  // IP) — the browser doesn't expose the mic there. Hide the recorder
  // entirely instead of showing a button that only errors. It returns
  // automatically on HTTPS / localhost. (Placed after all hooks so the
  // rules of hooks hold.)
  if (!micSupported) return null

  // Collapsed state: just the mic button (plus permission help dialog).
  // If we already have a list of devices (because the user has recorded
  // before in this session), show a tiny dropdown next to the mic button so
  // they can pick a different one without going to system settings.
  if (!isRecording && !recordedBlob) {
    const selectedLabel = cleanDeviceLabel(
      audioDevices.find((d) => d.deviceId === selectedDeviceId)?.label,
    )
    return (
      <>
        <div
          ref={devicePickerRef}
          className="relative inline-flex items-center"
        >
          <button
            type="button"
            onClick={startRecording}
            disabled={disabled || isUploading}
            className="p-2 rounded-md text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              selectedLabel
                ? `Record voice message (${selectedLabel})`
                : 'Record voice message'
            }
            aria-label="Record voice message"
          >
            <Mic className="w-4 h-4" />
          </button>
          {/* 1.9.1+: Google Meet-style chevron next to the mic. Click
              opens a tiny popover with the available audio inputs;
              the chosen device is persisted to localStorage so the
              user's pick survives reloads + tab restarts. Shows only
              when more than one device exists (or one is detected by
              label) — first-time users get the OS default and won't
              see clutter. */}
          {audioDevices.length > 1 && (
            <button
              ref={devicePickerTriggerRef}
              type="button"
              onClick={() => setShowDevicePicker((v) => !v)}
              disabled={disabled || isUploading}
              className="p-1 -ml-1 rounded-md text-white/55 hover:text-white hover:bg-white/[0.08] transition-colors disabled:opacity-50"
              title="Choose microphone"
              aria-label="Choose microphone"
              aria-haspopup="menu"
              aria-expanded={showDevicePicker}
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          )}
          {showDevicePicker && audioDevices.length > 0 && devicePickerCoords && typeof document !== 'undefined' && createPortal(
            // 2.5.1+: PORTAL to document.body so the frosted-glass
            // backdrop-filter actually samples the real UI behind
            // the popover, not the comments sidebar's already-
            // glassed surface. (Any ancestor with backdrop-filter,
            // transform, filter, etc. forms a "backdrop root" — the
            // popover's blur then samples that empty root instead
            // of the page beneath. Portalling to body sidesteps
            // every ancestor.)
            <div
              ref={devicePickerPopoverRef}
              role="menu"
              className="fixed min-w-[260px] max-w-[320px] rounded-lg ring-1 ring-white/15 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] p-1 pr-2 z-[200] text-white animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
              style={{
                left: devicePickerCoords.left,
                bottom: devicePickerCoords.bottom,
                backgroundColor: 'rgba(22, 37, 51, 0.35)',
                backgroundImage:
                  'radial-gradient(140% 80% at 0% 0%, hsl(var(--spotlight-tint) / 0.20) 0%, hsl(var(--spotlight-tint) / 0.05) 45%, transparent 75%)',
                backdropFilter: 'blur(40px) saturate(180%)',
                WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                transform: 'translate3d(0, 0, 0)',
                willChange: 'backdrop-filter, transform',
                isolation: 'isolate',
              }}
            >
              <div className="px-2 py-1.5 pr-3 text-[10px] uppercase tracking-wide text-white/55">
                Microphone
              </div>
              {audioDevices.map((d, i) => {
                const isSelected = d.deviceId === selectedDeviceId
                const label = cleanDeviceLabel(d.label) || `Microphone ${i + 1}`
                return (
                  <button
                    key={d.deviceId || `dev-${i}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    onClick={() => {
                      setSelectedDeviceId(d.deviceId)
                      setShowDevicePicker(false)
                    }}
                    className="w-full flex items-center gap-2 px-2 pr-4 py-1.5 rounded-md text-xs text-left transition-colors"
                    style={
                      isSelected
                        ? {
                            backgroundColor:
                              'hsl(var(--spotlight-tint) / 0.20)',
                            boxShadow:
                              'inset 0 0 0 1px hsl(var(--spotlight-tint) / 0.45)',
                          }
                        : undefined
                    }
                    onMouseEnter={(e) => {
                      if (!isSelected)
                        (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                          'rgba(255,255,255,0.08)'
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected)
                        (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                          ''
                    }}
                  >
                    <span
                      className="w-4 h-4 shrink-0 flex items-center justify-center"
                      style={
                        isSelected
                          ? { color: 'hsl(var(--spotlight-tint))' }
                          : undefined
                      }
                    >
                      {isSelected && <Check className="w-3.5 h-3.5" strokeWidth={2.5} />}
                    </span>
                    <span
                      className={`truncate ${isSelected ? 'text-white' : 'text-white/80'}`}
                    >
                      {label}
                    </span>
                  </button>
                )
              })}
            </div>,
            document.body
          )}
          {error && (
            <span className="ml-2 text-xs text-destructive">{error}</span>
          )}
        </div>
        {showPermissionHelp && (
          <MicrophonePermissionHelp onClose={() => setShowPermissionHelp(false)} />
        )}
      </>
    )
  }

  // Recording state: live duration + waveform + stop button.
  // 2.5.1+: glass v2.5 — wrapper is the same white-tint + hairline
  // ring used elsewhere in the composer, with an accent-tinted
  // radial bleed driven by --spotlight-tint so the bars feel like
  // they're sitting on top of a soft blue glow. The waveform bars
  // themselves use --spotlight-tint so they react to the user's
  // chosen accent. Red is kept ONLY on the live-recording dot
  // (universal "REC" affordance) and the Stop pill, because those
  // are semantic cues, not chrome.
  if (isRecording) {
    const remaining = Math.max(0, MAX_DURATION_SECONDS - duration)
    return (
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.06] ring-1 ring-white/10 shadow-[0_6px_18px_-12px_rgba(0,0,0,0.45)] min-w-0 flex-1"
        style={{
          backgroundImage:
            'radial-gradient(120% 80% at 0% 50%, hsl(var(--spotlight-tint) / 0.15) 0%, hsl(var(--spotlight-tint) / 0.04) 50%, transparent 80%)',
        }}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
        <span className="text-xs font-mono text-white tabular-nums shrink-0">
          {formatDuration(duration)}
        </span>
        {/* Waveform fills the available width — bars react to voice
            via the analyser RMS sampled in the recording effect.
            Tint follows the active accent. */}
        <div className="flex items-end gap-[2px] h-5 flex-1 min-w-0 overflow-hidden">
          {waveSamples.map((v, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm transition-all duration-75 min-w-0"
              style={{
                height: `${Math.max(8, Math.min(100, v * 220))}%`,
                backgroundColor: 'hsl(var(--spotlight-tint))',
                boxShadow: '0 0 6px hsl(var(--spotlight-tint) / 0.55)',
              }}
            />
          ))}
        </div>
        {remaining < 30 && (
          <span className="text-[10px] text-white/55 shrink-0 hidden sm:inline">
            {Math.floor(remaining)}s left
          </span>
        )}
        <button
          type="button"
          onClick={stopRecording}
          className="p-1.5 rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors shrink-0"
          title="Stop recording"
          aria-label="Stop recording"
        >
          <Square className="w-3.5 h-3.5" fill="currentColor" />
        </button>
      </div>
    )
  }

  // 1.9.1+: Preview UI. Mirrors the recording UI's layout
  // (container, gap, bar row) so the transition feels seamless —
  // the red recording chip turns into a neutral preview chip, the
  // red dot + duration become a play/pause button, and the stop
  // button is replaced by Discard + Send. No native <audio
  // controls> any more (those drag in browser styling + a volume
  // icon we didn't ask for). A hidden <audio> drives playback;
  // the bars dye left-to-right with `bg-primary` as it plays.
  return (
    // 2.5.1+: glass preview chip — same wrapper language as the
    // recording chip above, so the transition from "REC" to "preview"
    // doesn't break the visual frame. Subtle radial accent in the
    // left half keeps continuity with the rest of the v2.5 surfaces.
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.06] ring-1 ring-white/10 shadow-[0_6px_18px_-12px_rgba(0,0,0,0.45)] min-w-0 flex-1"
      style={{
        backgroundImage:
          'radial-gradient(120% 80% at 0% 50%, hsl(var(--spotlight-tint) / 0.12) 0%, hsl(var(--spotlight-tint) / 0.03) 55%, transparent 85%)',
      }}
    >
      <button
        type="button"
        onClick={togglePlayback}
        disabled={isUploading || !previewUrl}
        className="w-6 h-6 shrink-0 flex items-center justify-center rounded-full bg-white/[0.10] hover:bg-white/[0.18] ring-1 ring-white/15 text-white transition-colors disabled:opacity-50"
        title={isPlaying ? 'Pause' : 'Play'}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <Pause className="w-3 h-3" fill="currentColor" />
        ) : (
          <Play className="w-3 h-3 ml-[1px]" fill="currentColor" />
        )}
      </button>
      {/* 1.9.1+: continuous-line scrubber. 2.5.1+: track + thumb
          re-skinned for v2.5. Track is a hairline white line so
          the accent-tinted fill reads cleanly against it; thumb is
          a translucent glass ball with a white stroke (per user
          request: "biluta ca un geam cu stroke alb"). The fill
          itself uses --spotlight-tint so it tracks the user's
          chosen accent. */}
      <div
        ref={previewBarsRef}
        onMouseDown={handlePreviewMouseDown}
        onTouchStart={handlePreviewTouchStart}
        className="relative h-5 flex-1 min-w-0 cursor-pointer touch-none flex items-center px-2"
      >
        <div className="relative w-full h-[3px] rounded-full bg-white/15">
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${playbackProgress * 100}%`,
              backgroundColor: 'hsl(var(--spotlight-tint))',
              boxShadow: '0 0 8px hsl(var(--spotlight-tint) / 0.45)',
            }}
          />
          <div
            className="absolute top-1/2 w-3.5 h-3.5 rounded-full pointer-events-none"
            style={{
              left: `${playbackProgress * 100}%`,
              transform: 'translate(-50%, -50%)',
              // Frosted-glass ball: translucent white interior, crisp
              // white outline, and a soft glow tinted with the accent
              // so the thumb still reads as "active" without being a
              // solid blue dot.
              backgroundColor: 'rgba(255, 255, 255, 0.18)',
              border: '1.5px solid rgba(255, 255, 255, 0.95)',
              backdropFilter: 'blur(6px) saturate(140%)',
              WebkitBackdropFilter: 'blur(6px) saturate(140%)',
              boxShadow:
                '0 0 0 1px hsl(var(--spotlight-tint) / 0.35), 0 2px 8px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.5)',
            }}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={cancel}
        disabled={isUploading}
        className="p-1.5 rounded-md text-white/55 hover:text-red-400 hover:bg-white/[0.08] transition-colors disabled:opacity-50 shrink-0"
        title="Discard recording"
        aria-label="Discard recording"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
      {/* 1.9.1+: no in-recorder send button. The parent
          (CommentInput) wires its OWN paper-plane Send to
          uploadRecording via the onReadyToSendChange prop below,
          so there's a single "official" send icon on the comment
          row. While the upload is in flight we just show a
          spinner here as a status indicator. */}
      {isUploading && (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
      )}
      {previewUrl && (
        <audio
          ref={audioRef}
          src={previewUrl}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={(e) => {
            const a = e.currentTarget
            // 1.9.1+: webm blobs from MediaRecorder often have
            // duration === Infinity (no metadata embedded by Chrome).
            // Fall back to the recorded `duration` captured during
            // the recording session — otherwise the bars never
            // colour in and progress stays stuck at 0.
            const total =
              Number.isFinite(a.duration) && a.duration > 0
                ? a.duration
                : duration
            if (total > 0) {
              setPlaybackProgress(Math.min(1, a.currentTime / total))
            }
          }}
          onEnded={() => {
            setIsPlaying(false)
            setPlaybackProgress(0)
            if (audioRef.current) audioRef.current.currentTime = 0
          }}
          className="hidden"
          preload="metadata"
        />
      )}
      {error && (
        <span className="ml-1 text-xs text-destructive">{error}</span>
      )}
    </div>
  )
}

/**
 * Modal that explains how to re-enable microphone access after the user has
 * permanently denied it. Browsers do not let JavaScript trigger the native
 * permission prompt a second time, so the only path forward is to show the
 * user where to click in the URL bar.
 */
function MicrophonePermissionHelp({ onClose }: { onClose: () => void }) {
  // Detect browser to give specific instructions
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const isChrome = /Chrome\//.test(ua) && !/Edg\//.test(ua)
  const isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua)
  const isFirefox = /Firefox\//.test(ua)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
            <Mic className="w-5 h-5 text-red-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-foreground">
              Microphone access is blocked
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Your browser is blocking the microphone for this site. Re-enable it
              and reload the page to record a voice message.
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-muted/50 border border-border p-4 mb-4 text-sm text-foreground space-y-2">
          {isChrome && (
            <>
              <p className="font-medium">In Chrome:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Click the <strong>lock icon</strong> 🔒 in the address bar (left of the URL).</li>
                <li>Click <strong>Site settings</strong>.</li>
                <li>Find <strong>Microphone</strong> and change it to <strong>Allow</strong>.</li>
                <li>Reload the page.</li>
              </ol>
            </>
          )}
          {isSafari && (
            <>
              <p className="font-medium">In Safari:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Open <strong>Safari → Settings → Websites</strong>.</li>
                <li>Click <strong>Microphone</strong> in the sidebar.</li>
                <li>Find this site and set it to <strong>Allow</strong>.</li>
                <li>Reload the page.</li>
              </ol>
            </>
          )}
          {isFirefox && (
            <>
              <p className="font-medium">In Firefox:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Click the <strong>lock icon</strong> 🔒 in the address bar.</li>
                <li>Click <strong>Connection Secure → More information → Permissions</strong>.</li>
                <li>Uncheck the <strong>Block</strong> for "Use the Microphone".</li>
                <li>Reload the page.</li>
              </ol>
            </>
          )}
          {!isChrome && !isSafari && !isFirefox && (
            <>
              <p className="font-medium">Steps:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Click the <strong>lock icon</strong> 🔒 in the address bar.</li>
                <li>Find the <strong>Microphone</strong> permission and set it to <strong>Allow</strong>.</li>
                <li>Reload the page.</li>
              </ol>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  )
}
