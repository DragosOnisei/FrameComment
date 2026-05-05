'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { Mic, Square, Trash2, Check, Loader2 } from 'lucide-react'
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
}: VoiceRecorderButtonProps) {
  const storageProvider = useStorageProvider()
  const { startUpload: startS3Upload } = useS3MultipartUpload()

  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [recordedExt, setRecordedExt] = useState<string>('webm')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // When the browser has permanently denied mic access we can't trigger the
  // native permission prompt again — we must show the user how to re-enable it.
  const [showPermissionHelp, setShowPermissionHelp] = useState(false)
  // Available audio input devices and the user's selected one. Empty until
  // permission has been granted at least once (browsers hide labels otherwise).
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  // Live waveform: a small ring of recent volume samples (0..1) for animation.
  const [waveSamples, setWaveSamples] = useState<number[]>(Array(24).fill(0.05))

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
    try {
      // If the user has picked a specific input device, request it explicitly;
      // otherwise let the OS / browser pick the default. We pass exact:false
      // (the default) so the browser falls back gracefully if the device id
      // is no longer present (e.g. USB mic unplugged between recordings).
      const audioConstraints: MediaTrackConstraints | true = selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId } }
        : true
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
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
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        audioContextRef.current = ctx
        analyserRef.current = analyser

        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const tick = () => {
          if (!analyserRef.current) return
          analyserRef.current.getByteFrequencyData(dataArray)
          // Average amplitude in 0..1
          let sum = 0
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]
          const avg = sum / dataArray.length / 255
          setWaveSamples((prev) => [...prev.slice(1), Math.max(0.05, avg)])
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
    setIsUploading(true)
    setError(null)

    try {
      const fileName = `voice-${Date.now()}.${recordedExt}`
      const file = new File([recordedBlob], fileName, { type: recordedBlob.type || 'audio/webm' })

      // Step 1: register the asset to get an assetId
      const createUrl = `/api/videos/${videoId}/client-assets`
      const createBody = JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'audio/webm',
        category: 'audio',
      })
      const createRes = shareToken
        ? await fetch(createUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${shareToken}`,
            },
            body: createBody,
          })
        : await fetch(createUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: createBody,
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
              if (shareToken) {
                xhr.setRequestHeader('Authorization', `Bearer ${shareToken}`)
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

      onAttachmentAdded({
        assetId,
        videoId,
        fileName: file.name,
        fileSize: String(file.size),
        fileType: file.type || 'audio/webm',
        category: 'audio',
      })

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
  ])

  // ---------- Render ----------

  // Collapsed state: just the mic button (plus permission help dialog).
  // If we already have a list of devices (because the user has recorded
  // before in this session), show a tiny dropdown next to the mic button so
  // they can pick a different one without going to system settings.
  if (!isRecording && !recordedBlob) {
    return (
      <>
        <div className="relative inline-flex items-center gap-1">
          <button
            type="button"
            onClick={startRecording}
            disabled={disabled || isUploading}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Record voice message"
            aria-label="Record voice message"
          >
            <Mic className="w-4 h-4" />
          </button>
          {audioDevices.length > 1 && (
            <select
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              className="text-xs bg-background border border-border rounded-md px-2 py-1 min-w-[180px] max-w-[260px] truncate"
              title={
                cleanDeviceLabel(
                  audioDevices.find((d) => d.deviceId === selectedDeviceId)?.label
                ) || 'Select microphone'
              }
              aria-label="Select microphone"
            >
              {audioDevices.map((d, i) => (
                <option key={d.deviceId || `dev-${i}`} value={d.deviceId}>
                  {cleanDeviceLabel(d.label) || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
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

  // Recording state: live duration + waveform + stop button
  if (isRecording) {
    const remaining = Math.max(0, MAX_DURATION_SECONDS - duration)
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/40">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
        <span className="text-xs font-mono text-foreground tabular-nums">
          {formatDuration(duration)}
        </span>
        <div className="flex items-end gap-[2px] h-5 w-24">
          {waveSamples.map((v, i) => (
            <div
              key={i}
              className="flex-1 bg-red-400 rounded-sm transition-all duration-75"
              style={{ height: `${Math.max(8, Math.min(100, v * 220))}%` }}
            />
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground">
          {remaining < 30 ? `${Math.floor(remaining)}s left` : ''}
        </span>
        <button
          type="button"
          onClick={stopRecording}
          className="p-1.5 rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors"
          title="Stop recording"
          aria-label="Stop recording"
        >
          <Square className="w-3.5 h-3.5" fill="currentColor" />
        </button>
      </div>
    )
  }

  // Preview / confirm state
  return (
    <div className="inline-flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted border border-border">
      <Mic className="w-4 h-4 text-muted-foreground" />
      {previewUrl && (
        <audio
          src={previewUrl}
          controls
          className="h-8"
          style={{ maxWidth: 220 }}
        />
      )}
      <button
        type="button"
        onClick={cancel}
        disabled={isUploading}
        className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-accent transition-colors disabled:opacity-50"
        title="Discard recording"
        aria-label="Discard recording"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={uploadRecording}
        disabled={isUploading}
        className="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1"
        title="Attach voice message"
        aria-label="Attach voice message"
      >
        {isUploading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Check className="w-3.5 h-3.5" />
        )}
      </button>
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
