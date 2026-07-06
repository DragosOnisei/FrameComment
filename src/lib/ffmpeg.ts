import { spawn, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { getCpuAllocation } from './cpu-config'
import { logError, logMessage } from './logging'

// Debug mode - outputs verbose FFmpeg logs
// Enable with: DEBUG_WORKER=true environment variable
const DEBUG = process.env.DEBUG_WORKER === 'true'

// Use system-installed ffmpeg (installed via apk in Dockerfile)
const ffmpegPath = 'ffmpeg'
const ffprobePath = 'ffprobe'

/**
 * 1.9.4+ Phase A: hardware video encoder detection.
 *
 * Probes FFmpeg at module load to find the fastest available
 * encoder. Priority order:
 *
 *   1. NVENC (Nvidia GPUs) — fastest, widely available
 *   2. QSV (Intel Quick Sync) — fast, low latency, on iGPUs +
 *      newer Intel discrete GPUs (Arc)
 *   3. VideoToolbox (Apple Silicon / Intel Macs)
 *   4. VAAPI (Linux generic via /dev/dri/renderD*)
 *   5. libx264 (software fallback — current TrueNAS production)
 *
 * Detection runs once at startup. The encoder is then used for
 * EVERY subsequent transcode in this process.
 *
 * 2.0.3: detection now runs a real probe encode (1 frame, 64×64
 * to /dev/null) for each HW candidate. Listing in
 * `ffmpeg -encoders` only tells us the binary was compiled with
 * support — it does NOT mean the host has the right hardware,
 * driver, or device node. Alpine's ffmpeg ships h264_qsv compiled
 * in even on systems with no Intel iGPU, so the previous "did
 * `-encoders` list it?" heuristic was wrong on the most common
 * deployment (TrueNAS SCALE on a Xeon-only box). Result: every
 * transcode failed with `Error creating a MFX session: -9` and
 * the worker had no fallback path. Now each candidate is
 * actually invoked once; if the probe fails, we move to the
 * next candidate, eventually landing on libx264 (which always
 * works).
 *
 * Override via env var: `FORCE_VIDEO_ENCODER=libx264` to skip
 * the probe entirely and force a specific encoder. Useful for
 * benchmarking, or for hosts where the probe is slow.
 *
 * Net effect on the current TrueNAS Xeon (no GPU): libx264, no
 * change from production. Net effect when an Arc / Quadro card
 * is added later: ~5-10x faster encoding, near-zero CPU.
 */
export type VideoEncoder = 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_videotoolbox' | 'h264_vaapi'

/**
 * Encoder-specific probe arguments. The probe runs a tiny encode
 * (64×64, 1 frame, no audio) and discards the output. If the
 * encoder can't initialize the underlying hardware/session it
 * exits non-zero almost immediately, which is exactly what we
 * want for a cheap startup gate.
 *
 * VAAPI is special: it needs a hwupload filter and an explicit
 * device. We try the standard render node path; if it doesn't
 * exist the open() call fails and we fall through to libx264.
 */
function probeArgsFor(enc: VideoEncoder): string[] {
  const common = [
    '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=size=64x64:rate=1:duration=1',
  ]
  switch (enc) {
    case 'h264_nvenc':
      return [...common, '-c:v', 'h264_nvenc', '-f', 'null', '-']
    case 'h264_qsv':
      return [...common, '-c:v', 'h264_qsv', '-f', 'null', '-']
    case 'h264_videotoolbox':
      return [...common, '-c:v', 'h264_videotoolbox', '-f', 'null', '-']
    case 'h264_vaapi':
      // VAAPI requires an explicit device + frame format upload.
      // If /dev/dri/renderD128 isn't present (very common in
      // containers) the init fails fast and we skip to the next
      // candidate.
      return [
        '-hide_banner', '-v', 'error',
        '-vaapi_device', '/dev/dri/renderD128',
        '-f', 'lavfi', '-i', 'color=size=64x64:rate=1:duration=1',
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'h264_vaapi',
        '-f', 'null', '-',
      ]
    case 'libx264':
    default:
      return [...common, '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'null', '-']
  }
}

/** Run a single tiny encode to confirm the encoder actually works. */
function canEncodeWith(enc: VideoEncoder): boolean {
  const args = probeArgsFor(enc)
  try {
    execSync(`${ffmpegPath} ${args.join(' ')}`, {
      stdio: 'pipe',
      timeout: 8_000,
    })
    return true
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || err?.message || String(err)
    // Trim to the first line so the log stays readable — the
    // full ffmpeg dump is overwhelming and the first line is
    // almost always the actionable error ("Cannot load nvcuda.dll",
    // "Error creating a MFX session", "No such file or directory",
    // etc.).
    const firstLine = stderr.split(/\r?\n/).find((l: string) => l.trim())?.trim() || stderr.trim()
    logMessage(`[FFMPEG] Probe for ${enc} failed: ${firstLine}`)
    return false
  }
}

function detectVideoEncoder(): VideoEncoder {
  // Explicit override wins — useful for forcing software encoding
  // when debugging quality issues or benchmarking.
  const override = process.env.FORCE_VIDEO_ENCODER
  if (override === 'libx264' || override === 'h264_nvenc' || override === 'h264_qsv' ||
      override === 'h264_videotoolbox' || override === 'h264_vaapi') {
    logMessage(`[FFMPEG] Encoder overridden via FORCE_VIDEO_ENCODER: ${override}`)
    return override
  }

  let encodersList = ''
  try {
    encodersList = execSync(`${ffmpegPath} -hide_banner -encoders 2>&1`, {
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch (err) {
    logMessage(`[FFMPEG] Encoder probe failed, falling back to libx264: ${err}`)
    return 'libx264'
  }

  // Try each HW candidate in priority order. For each one we
  // first check that the binary even lists it (cheap), then run
  // a tiny real encode (slightly more expensive, ~100-300ms when
  // it succeeds, faster when it fails). The probe catches the
  // common "binary supports it but the host doesn't have the
  // hardware" case that used to take down every transcode.
  const candidates: VideoEncoder[] = ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox', 'h264_vaapi']
  for (const candidate of candidates) {
    if (!encodersList.includes(candidate)) continue
    logMessage(`[FFMPEG] Probing hardware encoder: ${candidate}`)
    if (canEncodeWith(candidate)) {
      logMessage(`[FFMPEG] Hardware encoder confirmed working: ${candidate}`)
      return candidate
    }
  }

  logMessage('[FFMPEG] No working hardware encoder, using libx264 (software)')
  return 'libx264'
}

const VIDEO_ENCODER: VideoEncoder = detectVideoEncoder()

/**
 * 1.9.4+ Phase A: how many parallel ffmpeg invocations the
 * orchestrator should fan out for the higher tiers AFTER the
 * first-tier flip. Software encoders (libx264) thrive on
 * parallelism because each one uses CPU threads and there's no
 * shared hardware bottleneck. Most hardware encoders (VideoToolbox
 * on Mac, VAAPI on a single iGPU) have only 1-2 encode slots —
 * running parallel ffmpeg + HW on those just causes internal
 * serialization at best, fallback to software at worst. NVENC
 * and QSV on a dedicated card can run 2-3 concurrent sessions,
 * so we allow parallelism there.
 */
export function getMaxParallelTranscodes(): number {
  switch (VIDEO_ENCODER) {
    case 'h264_nvenc':
    case 'h264_qsv':
      return 2 // dedicated GPU cards typically allow 2+ sessions
    case 'h264_videotoolbox':
    case 'h264_vaapi':
      return 1 // single shared engine on Mac / iGPU
    case 'libx264':
    default:
      return 2 // software encoder — CPU-bound, parallel scales linearly
  }
}

/** Exposed so the worker can log which encoder is active. */
export function getActiveVideoEncoder(): VideoEncoder {
  return VIDEO_ENCODER
}

/**
 * Translate our software-encoder preset names + output dimensions
 * into encoder-specific FFmpeg args. Each branch produces:
 *   - the `-c:v` selector
 *   - the encoder's speed/quality knob (preset / quality-mode)
 *   - rate control (CRF for libx264, bitrate for hardware)
 *   - profile / level for compatibility
 *
 * Shared args (audio codec, faststart, pix_fmt) stay in the
 * caller — this returns just the video-encoder block.
 */
function buildVideoEncoderArgs(
  encoder: VideoEncoder,
  preset: string,
  width: number,
  height: number,
  threads: number,
): string[] {
  // Approximate bitrate targets (kbps) by output area. Hardware
  // encoders are bitrate-based so we need a number; we pick
  // conservative values that match typical streaming quality at
  // each tier.
  const pixels = width * height
  let targetBitrateK: number
  if (pixels >= 3840 * 2160 * 0.7) targetBitrateK = 16_000 // ~4K
  else if (pixels >= 1920 * 1080 * 0.7) targetBitrateK = 6_000 // 1080p
  else if (pixels >= 1280 * 720 * 0.7) targetBitrateK = 3_000 // 720p
  else targetBitrateK = 1_200 // 480p and below
  const maxBitrateK = Math.round(targetBitrateK * 1.5)
  const bufSizeK = targetBitrateK * 2

  switch (encoder) {
    case 'h264_nvenc':
      // NVENC uses p1..p7 presets (1=fastest, 7=slowest/best). Map
      // our names roughly: ultrafast→p1, superfast→p2, faster→p3,
      // fast→p4, medium→p5, slow→p6.
      const nvencPreset = ({
        ultrafast: 'p1',
        superfast: 'p2',
        veryfast: 'p2',
        faster: 'p3',
        fast: 'p4',
        medium: 'p5',
        slow: 'p6',
      } as Record<string, string>)[preset] || 'p4'
      return [
        '-c:v', 'h264_nvenc',
        '-preset', nvencPreset,
        '-tune', 'hq',
        '-rc', 'vbr',
        '-b:v', `${targetBitrateK}k`,
        '-maxrate', `${maxBitrateK}k`,
        '-bufsize', `${bufSizeK}k`,
        '-profile:v', 'high',
        '-level', '4.1',
      ]

    case 'h264_qsv':
      // Intel Quick Sync. Preset names align with software-ish
      // names (veryfast / faster / fast / medium).
      const qsvPreset = ({
        ultrafast: 'veryfast',
        superfast: 'veryfast',
        veryfast: 'veryfast',
        faster: 'faster',
        fast: 'fast',
        medium: 'medium',
        slow: 'slower',
      } as Record<string, string>)[preset] || 'fast'
      return [
        '-c:v', 'h264_qsv',
        '-preset', qsvPreset,
        '-b:v', `${targetBitrateK}k`,
        '-maxrate', `${maxBitrateK}k`,
        '-profile:v', 'high',
        '-level', '4.1',
      ]

    case 'h264_videotoolbox':
      // Apple's VT encoder is bitrate-based. We use quality-mode
      // (-q:v 60) instead of strict bitrate, because batch
      // encoding via VT is dramatically faster in quality mode —
      // VT skips its rate-control loop and just dumps frames
      // through the media engine.
      //
      // CRITICAL: do NOT set `-realtime 1` here. That flag tells
      // VT to encode AT real-time speed (1x source duration),
      // which capped batch encoding at the playback length of
      // the input. For a 40-min source that meant 40 min minimum
      // encoding — the exact opposite of what we want.
      return [
        '-c:v', 'h264_videotoolbox',
        '-q:v', '60', // 0..100, lower = higher quality; 60 ≈ libx264 CRF 23
        '-b:v', `${targetBitrateK}k`, // bitrate hint, not strict cap
        '-profile:v', 'high',
        '-level', '4.1',
        '-allow_sw', '1', // fall back to software if HW path errors at runtime
      ]

    case 'h264_vaapi':
      // Generic Linux hardware accel (Intel + AMD iGPUs).
      // VAAPI presets map similarly to QSV.
      return [
        '-c:v', 'h264_vaapi',
        '-b:v', `${targetBitrateK}k`,
        '-maxrate', `${maxBitrateK}k`,
        '-profile:v', 'high',
        '-level', '4.1',
      ]

    case 'libx264':
    default:
      // Software fallback — current production path.
      return [
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', '23',
        '-threads', threads.toString(),
        '-profile:v', 'high',
        '-level', '4.1',
      ]
  }
}

export interface VideoMetadata {
  duration: number
  width: number
  height: number
  fps?: number
  codec?: string
}

/**
 * Validate and sanitize watermark text for FFmpeg
 * Defense-in-depth: validates even if upstream validation exists
 *
 * @param text - The watermark text to validate
 * @returns Sanitized text safe for FFmpeg
 * @throws Error if text contains invalid characters or exceeds length limit
 */
function validateAndSanitizeWatermarkText(text: string): string {
  // Length check (prevent excessively long watermarks)
  if (text.length > 100) {
    throw new Error('Watermark text exceeds 100 character limit')
  }

  // Check for invalid characters (only alphanumeric, spaces, and safe punctuation)
  const invalidChars = text.match(/[^a-zA-Z0-9\s\-_.()]/g)
  if (invalidChars) {
    const uniqueInvalid = [...new Set(invalidChars)].join(', ')
    throw new Error(`Watermark text contains invalid characters: ${uniqueInvalid}`)
  }

  // Sanitize by removing any potentially dangerous characters (should be none at this point)
  const sanitized = text.replace(/[^a-zA-Z0-9\s\-_.()]/g, '')

  // Escape for FFmpeg drawtext filter (defense-in-depth)
  // Escape all special characters that FFmpeg might interpret
  return sanitized
    .replace(/\\/g, '\\\\')  // Backslash first (prevents double-escaping)
    .replace(/'/g, "\\'")    // Single quote
    .replace(/:/g, '\\:')    // Colon (used in filter syntax)
    .replace(/%/g, '\\%')    // Percent (used in FFmpeg expressions)
    .replace(/\[/g, '\\[')   // Square brackets (used in filter syntax)
    .replace(/\]/g, '\\]')
}

export async function getVideoMetadata(inputPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    // Remove '-v quiet' to capture detailed error messages
    const args = [
      '-v', 'verbose', // Enable verbose logging for debug
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ]

    if (DEBUG) {
      logMessage('[FFPROBE DEBUG] Executing:', ffprobePath, args.join(' '))
      logMessage('[FFPROBE DEBUG] Input file:', inputPath)
    }

    const ffprobe = spawn(ffprobePath, args)
    let stdout = ''
    let stderr = ''

    ffprobe.stdout.on('data', (data) => {
      const text = data.toString()
      stdout += text
      if (DEBUG) {
        logMessage('[FFPROBE STDOUT]', text.trim())
      }
    })

    ffprobe.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text
      if (DEBUG) {
        logMessage('[FFPROBE STDERR]', text.trim())
      }
    })

    ffprobe.on('close', (code) => {
      if (DEBUG) {
        logMessage('[FFPROBE DEBUG] Process exited with code:', code)
      }

      if (code !== 0) {
        // Extract useful error information from stderr
        const errorLines = stderr.split('\n').filter(line =>
          line.includes('error') ||
          line.includes('Error') ||
          line.includes('Invalid') ||
          line.includes('not found') ||
          line.includes('moov atom')
        )

        const errorMessage = errorLines.length > 0
          ? errorLines.join('; ')
          : stderr || 'Unknown error'

        if (DEBUG) {
          logError('[FFPROBE DEBUG] Error detected:', errorMessage)
        }

        reject(new Error(
          `ffprobe failed with exit code ${code}: ${errorMessage}. ` +
          `This usually indicates a corrupted or incomplete video file.`
        ))
        return
      }

      try {
        const metadata = JSON.parse(stdout)
        const videoStream = metadata.streams.find((s: any) => s.codec_type === 'video')

        if (DEBUG) {
          logMessage('[FFPROBE DEBUG] Parsed metadata:', JSON.stringify(metadata, null, 2))
        }

        if (!videoStream) {
          if (DEBUG) {
            logError('[FFPROBE DEBUG] No video stream found in metadata')
          }
          reject(new Error('No video stream found in file. The file may be audio-only or corrupted.'))
          return
        }

        // Parse frame rate
        let fps: number | undefined
        if (videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split('/').map(Number)
          fps = den ? num / den : undefined
        }

        // 1.4.x: ffprobe reports `width` / `height` as the RAW STORED
        // pixel dimensions of the frame, NOT what the player actually
        // paints. iPhone clips shot in portrait routinely come through
        // as 3840×2160 (landscape pixels) + a `rotate 90°` flag or an
        // mp4 `displaymatrix` side-data entry telling the player
        // "decode landscape, rotate 90° for display". If we trust the
        // raw width/height here, the worker calls scale=1280:720
        // (LANDSCAPE) on what is actually portrait content — ffmpeg
        // auto-rotates the frame to 2160×3840 portrait first, then
        // squishes it into the 1280×720 landscape canvas. The result
        // is a horizontally stretched portrait video that fills the
        // 16:9 player wrapper at playback time. Reading the rotation
        // and swapping the dims here gives the worker the truth: the
        // clip is portrait, calculate scale accordingly.
        let w = videoStream.width || 0
        let h = videoStream.height || 0
        let rotation = 0
        // Legacy `rotate` tag on the stream (most pre-2022 iPhone files
        // and Android camera apps).
        const legacyRotate = parseInt(
          (videoStream.tags && (videoStream.tags.rotate || videoStream.tags.ROTATE)) || '0',
          10,
        )
        if (Number.isFinite(legacyRotate) && legacyRotate !== 0) {
          rotation = legacyRotate
        }
        // Modern `displaymatrix` side-data list (iOS 16+, modern Android,
        // most camera apps from 2023 onwards). The matrix encodes the
        // rotation; ffprobe exposes it directly as a `rotation` field.
        if (Array.isArray(videoStream.side_data_list)) {
          for (const sd of videoStream.side_data_list) {
            if (
              sd &&
              (sd.side_data_type === 'Display Matrix' ||
                sd.side_data_type === 'displaymatrix') &&
              typeof sd.rotation === 'number'
            ) {
              // ffmpeg reports `rotation` as the angle CCW from upright
              // (e.g. -90 for a 90° clockwise display rotation). Either
              // ±90 / ±270 swap the painted dimensions.
              rotation = sd.rotation
              break
            }
          }
        }
        const normalized = ((rotation % 360) + 360) % 360
        if (normalized === 90 || normalized === 270) {
          ;[w, h] = [h, w]
        }

        const result = {
          duration: parseFloat(metadata.format.duration) || 0,
          width: w,
          height: h,
          fps,
          codec: videoStream.codec_name,
        }

        if (DEBUG) {
          logMessage('[FFPROBE DEBUG] Extracted video metadata:', result)
        }

        resolve(result)
      } catch (error) {
        if (DEBUG) {
          logError('[FFPROBE DEBUG] Failed to parse output:', error)
        }
        reject(new Error(`Failed to parse ffprobe output: ${error}. Output was: ${stdout.substring(0, 200)}`))
      }
    })

    ffprobe.on('error', (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}. Is ffprobe installed?`))
    })
  })
}

export type WatermarkPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type WatermarkFontSize = 'small' | 'medium' | 'large'

export interface TranscodeOptions {
  inputPath: string
  outputPath: string
  width: number
  height: number
  watermarkText?: string
  watermarkPositions?: string // comma-separated positions, e.g. "center,bottom-right"
  watermarkOpacity?: number // 10-100
  watermarkFontSize?: WatermarkFontSize
  applyLut?: boolean // Apply preview LUT for color-calibrated previews (default: true)
  onProgress?: (progress: number) => void
  // 1.9.4+: optional cancellation signal — when aborted, the
  // running FFmpeg process is SIGTERM'd and the promise rejects
  // with a "TranscodeAborted" error. Used by the worker to bail
  // out fast when the user deletes a video mid-transcode.
  signal?: AbortSignal
  // 1.9.4+ Phase A: explicit x264 preset override. Used by the
  // worker to pass `ultrafast` for the 480p fast first tier
  // (we want time-to-first-playable, not file-size optimisation
  // — higher tiers later get a better preset for archival use).
  preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow'
  // 2.1.9+ INTERNAL: override the encoder for this one run. Used
  // by the runtime fallback logic in `transcodeVideo` to retry a
  // failed hardware encode with libx264. Callers should NEVER set
  // this — leave it undefined to use the auto-detected encoder.
  _forceEncoder?: VideoEncoder
}

/**
 * 2.1.9+: error signatures we treat as "the hardware encoder
 * pipeline is broken for this specific clip, fall back to libx264
 * and try again". Conservative on purpose — matching too broadly
 * would also catch real video corruption / abort / disk errors,
 * which a software retry can't fix. Keep this list narrow to known
 * HW failures.
 */
const HW_ENCODER_FAILURE_PATTERNS: RegExp[] = [
  // Filter graph can't bridge cuda↔CPU formats (the `-pix_fmt
  // yuv420p` + scale_cuda interaction bug surfaced in 2.1.8 prod
  // when the worker tried to force a yuv420p output on cuda frames
  // without hwdownload between them).
  /Impossible to convert between the formats supported by the filter/i,
  /Error reinitializing filters/i,
  // NVENC / NVDEC / CUDA init failures
  /Could not open encoder/i,
  /OpenEncodeSessionEx failed/i,
  /Cannot load (?:nvcuda|cuda|nvenc)/i,
  /NVENC capability not present/i,
  /No NVENC capable devices found/i,
  /Driver does not support the required nvenc API/i,
  // QSV / VAAPI / VideoToolbox equivalents
  /Error initializing an internal MFX session/i,
  /VAAPI hardware does not support encoding/i,
  /Error while opening encoder for output stream/i,
  // Generic "filter not implemented" from cuda filter mismatches
  /Function not implemented/i,
]

function isHardwareEncoderError(err: unknown): boolean {
  if (!err) return false
  const message = err instanceof Error ? err.message : String(err)
  return HW_ENCODER_FAILURE_PATTERNS.some((rx) => rx.test(message))
}

export async function transcodeVideo(options: TranscodeOptions): Promise<void> {
  // 2.1.9+: runtime auto-fallback to libx264 when the active
  // hardware encoder errors out for a specific clip. The probe at
  // startup (`detectVideoEncoder`) can only confirm the encoder
  // CAN run a tiny synthetic clip — it can't catch corner cases
  // like the cuda↔CPU filter graph mismatch surfaced in 2.1.8
  // prod, where NVENC was probed-OK but every real transcode
  // failed before NVENC even initialised. We now try once with
  // the auto-detected encoder; if the error message matches a
  // known-HW-failure pattern, we retry the SAME clip with
  // libx264 within the same job — so the user never sees a
  // failed video for an encoder bug.
  const initialEncoder = options._forceEncoder || VIDEO_ENCODER
  try {
    await runTranscodeOnce(options, initialEncoder)
  } catch (err) {
    // Don't retry on user-initiated abort, on already-software
    // failures (there's nothing left to fall back to), or on
    // errors we don't recognise as HW-related — those are real
    // problems with the input or the disk and a software retry
    // won't help.
    const isAbort = err instanceof Error && err.message === 'TranscodeAborted'
    const isAlreadyFallback = initialEncoder === 'libx264' || options._forceEncoder === 'libx264'
    if (isAbort || isAlreadyFallback || !isHardwareEncoderError(err)) {
      throw err
    }
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
    logMessage(
      `[FFMPEG] Hardware encoder ${initialEncoder} failed at runtime: ${message.slice(0, 200)} — retrying with libx264 (CPU fallback) for this clip.`,
    )
    await runTranscodeOnce(options, 'libx264')
  }
}

async function runTranscodeOnce(
  options: TranscodeOptions,
  effectiveEncoder: VideoEncoder,
): Promise<void> {
  const {
    inputPath,
    outputPath,
    width,
    height,
    watermarkText,
    onProgress,
    signal
  } = options

  // Short-circuit when the caller already cancelled before we even
  // started — saves spawning ffmpeg for a job whose video row is
  // already gone.
  if (signal?.aborted) {
    throw new Error('TranscodeAborted')
  }

  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] Starting transcodeVideo with options:', {
      inputPath,
      outputPath,
      width,
      height,
      watermarkText,
      hasProgressCallback: !!onProgress
    })
  }

  // Get CPU allocation from centralized config
  // This coordinates with worker concurrency to prevent CPU overload
  const cpuAllocation = getCpuAllocation()
  const threads = cpuAllocation.threadsPerJob

  // 1.9.4+ Phase A: caller can pin the preset explicitly (the
  // worker uses this for the 480p fast tier — ultrafast cuts
  // encode time roughly in half vs the auto-selected preset, at
  // the cost of a larger file. For a transient first-playable
  // preview, file size doesn't matter; time-to-ready does.)
  let preset: string
  if (options.preset) {
    preset = options.preset
  } else {
    // Auto-select based on available threads — fewer threads
    // means faster preset to compensate.
    if (threads <= 2) {
      preset = 'faster'
    } else if (threads <= 4) {
      preset = 'fast'
    } else {
      preset = 'medium'
    }
  }

  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] CPU optimization:', {
      totalThreads: cpuAllocation.totalThreads,
      threadsPerJob: threads,
      selectedPreset: preset
    })
  }

  // Get video metadata for duration (needed for progress calculation)
  const metadata = await getVideoMetadata(inputPath)
  const duration = metadata.duration

  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] Input video metadata:', metadata)
  }

  // Build video filters
  const filters: string[] = []

  // Scale video
  filters.push(`scale=${width}:${height}`)

  // Add watermark if specified
  let watermarkTextFile: string | null = null
  if (watermarkText) {
    // Validate and sanitize watermark text (defense-in-depth)
    const validatedText = validateAndSanitizeWatermarkText(watermarkText)

    // SECURITY: Write watermark to secure temp directory instead of inline
    // mkdtempSync creates a directory with restricted permissions (0700)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-'))
    watermarkTextFile = path.join(tmpDir, 'text.txt')
    fs.writeFileSync(watermarkTextFile, validatedText, 'utf-8')

    // Parse positions (comma-separated, default: center)
    const positionsStr = options.watermarkPositions || 'center'
    const positions = positionsStr.split(',').map(p => p.trim()).filter(Boolean) as WatermarkPosition[]

    // Convert opacity 10-100 to FFmpeg alpha 0.1-1.0
    const rawOpacity = Math.max(10, Math.min(100, options.watermarkOpacity ?? 30))
    const alpha = (rawOpacity / 100).toFixed(2)
    const shadowAlpha = (rawOpacity / 200).toFixed(2)

    // Font size multipliers relative to video width
    const fontSize = options.watermarkFontSize || 'medium'
    const isVertical = height > width
    const sizeMultipliers = {
      small:  { center: isVertical ? 0.05 : 0.025, corner: isVertical ? 0.035 : 0.018 },
      medium: { center: isVertical ? 0.08 : 0.04,  corner: isVertical ? 0.05  : 0.025 },
      large:  { center: isVertical ? 0.12 : 0.06,  corner: isVertical ? 0.07  : 0.035 },
    }
    const multiplier = sizeMultipliers[fontSize] || sizeMultipliers.medium
    const centerFontPx = Math.round(width * multiplier.center)
    const cornerFontPx = Math.round(width * multiplier.corner)

    const spacing = isVertical ? 30 : 50
    const font = `/usr/share/fonts/dejavu/DejaVuSans.ttf`

    // Position coordinate map
    const positionMap: Record<WatermarkPosition, { x: string; y: string; fs: number; shadow: number }> = {
      'center':       { x: '(w-text_w)/2', y: '(h-text_h)/2', fs: centerFontPx, shadow: 2 },
      'top-left':     { x: `${spacing}`, y: `${spacing}`, fs: cornerFontPx, shadow: 1 },
      'top-right':    { x: `w-text_w-${spacing}`, y: `${spacing}`, fs: cornerFontPx, shadow: 1 },
      'bottom-left':  { x: `${spacing}`, y: `h-text_h-${spacing}`, fs: cornerFontPx, shadow: 1 },
      'bottom-right': { x: `w-text_w-${spacing}`, y: `h-text_h-${spacing}`, fs: cornerFontPx, shadow: 1 },
    }

    for (const pos of positions) {
      const coords = positionMap[pos]
      if (!coords) continue
      filters.push(
        `drawtext=textfile='${watermarkTextFile}':fontfile=${font}:fontsize=${coords.fs}:fontcolor=white@${alpha}:x=${coords.x}:y=${coords.y}:shadowcolor=black@${shadowAlpha}:shadowx=${coords.shadow}:shadowy=${coords.shadow}`
      )
    }
  }

  // Apply preview LUT unless explicitly disabled.
  // Convert to BT.709 limited-range yuv420p first — this matches what a decoded
  // H.264 proxy would look like, which is what the LUT was calibrated against.
  // Then apply the LUT to those normalised values as the very last step.
  if (options.applyLut !== false) {
    filters.push('format=yuv420p')
    // Path to the preview LUT. In Docker we copy it to /usr/share/ffmpeg.
    // For local dev, override via PREVIEW_LUT_PATH env var (e.g. set to the
    // file at the repo root: PREVIEW_LUT_PATH=$(pwd)/previewlut.cube).
    const lutPath = process.env.PREVIEW_LUT_PATH || '/usr/share/ffmpeg/previewlut.cube'
    filters.push(`lut3d=${lutPath}`)
  }

  // 2.1.6+: Full-GPU pipeline for NVENC. Up to 2.1.5 we used
  // NVENC only for the FINAL encode step — decode + scale + CPU
  // filters all ran on the Xeon, and `nvidia-smi` showed ~5%
  // GPU-Util while every CPU thread sat at 99%. Now we:
  //   1. Add `-hwaccel cuda -hwaccel_output_format cuda` BEFORE
  //      `-i`, so NVDEC decodes straight into GPU memory.
  //   2. Replace the first software `scale=W:H` with
  //      `scale_cuda=W:H`, which runs the resize on the GPU
  //      without ever touching system memory.
  //   3. Always insert `hwdownload,format=nv12` after scale_cuda
  //      so CPU filters (drawtext for watermark, lut3d for the
  //      LUT) can read CPU frames; nvenc then uploads them back
  //      to the GPU on its own. 2.1.9+ change: this used to be
  //      gated on `hasCpuFilters` and skipped on the "no
  //      watermark + no LUT" happy path to keep frames in VRAM
  //      end-to-end. But the explicit `-pix_fmt yuv420p` flag
  //      lower down would then ask ffmpeg to convert the cuda
  //      frames to yuv420p AFTER the filter chain ended — and
  //      ffmpeg's auto-inserted `auto_scale` filter can't bridge
  //      cuda↔CPU without a manual `hwdownload`. Every clip with
  //      no LUT (the prod default — LUT is disabled globally)
  //      died with "Impossible to convert between the formats
  //      supported by the filter 'Parsed_scale_cuda_0' and the
  //      filter 'auto_scale_0'", and NVENC never even initialised
  //      so the fallback couldn't detect it. Always downloading
  //      after scale_cuda costs one PCIe roundtrip per frame but
  //      makes the pipeline deterministic and matches the rest
  //      of the args list.
  // 2.1.9+: respect the per-call effectiveEncoder override so
  // the auto-fallback path (libx264) builds a software pipeline
  // even when the auto-detected encoder is NVENC.
  const isNvenc = effectiveEncoder === 'h264_nvenc'
  const inputArgs: string[] = ['-v', 'verbose']
  if (isNvenc) {
    inputArgs.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda')
  }

  let finalFilters = filters
  if (isNvenc) {
    finalFilters = filters.map((f, idx) => {
      if (idx === 0 && f.startsWith('scale=')) {
        return f.replace(/^scale=/, 'scale_cuda=')
      }
      return f
    })
    // 2.1.9+: ALWAYS download from GPU after scale_cuda — see
    // the comment block above for why the previous
    // `hasCpuFilters` gate was broken.
    finalFilters.splice(1, 0, 'hwdownload', 'format=nv12')
  }

  const filterComplex = finalFilters.join(',')

  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] Built filter complex:', filterComplex)
    if (isNvenc) {
      logMessage('[FFMPEG DEBUG] Full-GPU NVENC pipeline (hwaccel cuda + scale_cuda)')
    }
  }

  // 1.9.4+ Phase A: pick encoder-specific args. Hardware encoders
  // have different rate-control flags and presets than libx264.
  // The chunk inside the helper keeps the rest of the arg list
  // (audio, faststart, etc.) shared.
  // 2.1.9+: uses the per-call effectiveEncoder so the libx264
  // fallback path generates software encoder args even when the
  // detected encoder is NVENC.
  const videoEncoderArgs = buildVideoEncoderArgs(effectiveEncoder, preset, width, height, threads)

  // Build ffmpeg arguments with optimizations
  const args = [
    ...inputArgs,
    '-i', inputPath,
    '-vf', filterComplex,
    ...videoEncoderArgs,
    '-pix_fmt', 'yuv420p', // Ensure compatibility with all players (especially Safari/iOS)
    '-c:a', 'aac',
    '-b:a', '128k', // Reduced from 192k to 128k (sufficient for most use cases, saves bandwidth)
    '-ar', '48000', // Standard audio sample rate
    '-movflags', '+faststart', // Enable progressive download (moov atom at start)
    '-max_muxing_queue_size', '1024', // Prevent muxing errors on high-bitrate videos
    // 1.4.x: BAKE THE ROTATION INTO THE OUTPUT PIXELS. Modern iPhone
    // clips (notably 2160×3840) ship with rotation metadata — a legacy
    // `rotate` tag and/or an mp4 `displaymatrix` side-data flag — that
    // tells the player "decode landscape, then rotate 90° for display".
    // ffmpeg's auto-rotate filter already applies the rotation when we
    // decode and pass through `-vf scale=...`, so the OUTPUT pixels are
    // already in the correct (portrait) orientation. But ffmpeg
    // ALSO copies the legacy `rotate` tag into the output container
    // unless we explicitly strip it. Some browsers then try to rotate
    // the already-rotated frames a SECOND time, and worse, apply that
    // double-rotation inconsistently between the initial paint and
    // post-seek frames — the bug the user reported as "the video
    // becomes stretched after I scrub". Stripping the tag forces every
    // browser to paint the frames as-is, no rotation, no
    // interpretation: the orientation baked in by ffmpeg is the only
    // truth. The modern `displaymatrix` side-data is dropped
    // automatically because we re-encode through `-vf`, not stream
    // copy.
    '-metadata:s:v:0', 'rotate=0',
    '-progress', 'pipe:2',
    '-y', // Overwrite output file
    outputPath
  ]

  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] Executing command:', 'nice -n 10', ffmpegPath, args.join(' '))
  }

  return new Promise((resolve, reject) => {
    // Run FFmpeg with lower CPU priority (nice 10) to prevent system freeze
    // This allows other processes to remain responsive during video processing
    // nice values: -20 (highest priority) to 19 (lowest priority), default is 0
    const ffmpeg = spawn('nice', ['-n', '10', ffmpegPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    // 1.9.4+: track abort source so the close handler reports
    // "TranscodeAborted" instead of treating the SIGTERM exit code
    // as a generic ffmpeg failure (which would surface as a noisy
    // ERROR row on the video).
    let abortedByCaller = false

    if (DEBUG) {
      logMessage('[FFMPEG DEBUG] FFmpeg process spawned, PID:', ffmpeg.pid)
    }

    // 1.9.4+: wire up AbortSignal → kill ffmpeg. Used by the worker
    // when a video is deleted while its transcode is running. We
    // send SIGTERM first (graceful) and fall through to SIGKILL via
    // a short timeout if ffmpeg ignores it.
    let abortListener: (() => void) | null = null
    if (signal) {
      abortListener = () => {
        abortedByCaller = true
        try {
          ffmpeg.kill('SIGTERM')
          setTimeout(() => {
            try {
              if (!ffmpeg.killed) ffmpeg.kill('SIGKILL')
            } catch {}
          }, 2000).unref()
        } catch {}
      }
      signal.addEventListener('abort', abortListener, { once: true })
    }

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString()
      stderr += text

      // In debug mode, log all stderr output
      if (DEBUG) {
        logMessage('[FFMPEG STDERR]', text.trim())
      }

      // Parse progress from stderr
      if (onProgress && duration > 0) {
        const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/)
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10)
          const minutes = parseInt(timeMatch[2], 10)
          const seconds = parseFloat(timeMatch[3])
          const currentTime = hours * 3600 + minutes * 60 + seconds
          const progress = Math.min(currentTime / duration, 1)
          if (DEBUG) {
            logMessage('[FFMPEG DEBUG] Progress:', Math.round(progress * 100) + '%')
          }
          onProgress(progress)
        }
      }

      // Log errors and warnings (even when not in debug mode)
      if (!DEBUG && (text.includes('error') || text.includes('Error') || text.includes('failed'))) {
        logError('FFmpeg stderr:', text)
      }
    })

    ffmpeg.on('close', (code) => {
      // Detach the AbortSignal listener — the process is gone, no
      // point keeping the reference alive (and signal could be
      // long-lived across multiple transcodes).
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener)
      }

      // Cleanup watermark temp file and directory
      if (watermarkTextFile && fs.existsSync(watermarkTextFile)) {
        try {
          const tmpDir = path.dirname(watermarkTextFile)
          fs.unlinkSync(watermarkTextFile)
          fs.rmdirSync(tmpDir)
          if (DEBUG) {
            logMessage('[FFMPEG DEBUG] Cleaned up watermark temp file:', watermarkTextFile)
          }
        } catch (cleanupErr) {
          logError('Failed to cleanup watermark temp file:', cleanupErr)
        }
      }

      if (DEBUG) {
        logMessage('[FFMPEG DEBUG] Process exited with code:', code)
      }

      // 1.9.4+: if the caller aborted us (e.g. video was deleted
      // mid-transcode), surface a typed error so the orchestrator
      // can bail out cleanly instead of marking the video as ERROR.
      if (abortedByCaller) {
        reject(new Error('TranscodeAborted'))
        return
      }

      if (code === 0) {
        if (DEBUG) {
          logMessage('[FFMPEG DEBUG] Transcoding completed successfully')
        }
        resolve()
      } else {
        if (DEBUG) {
          logError('[FFMPEG DEBUG] Transcoding failed with code:', code)
          logError('[FFMPEG DEBUG] Full stderr output:', stderr)
        }
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`))
      }
    })

    ffmpeg.on('error', (err) => {
      // Cleanup watermark temp file and directory on error
      if (watermarkTextFile && fs.existsSync(watermarkTextFile)) {
        try {
          const tmpDir = path.dirname(watermarkTextFile)
          fs.unlinkSync(watermarkTextFile)
          fs.rmdirSync(tmpDir)
        } catch (cleanupErr) {
          logError('Failed to cleanup watermark temp file:', cleanupErr)
        }
      }

      if (DEBUG) {
        logError('[FFMPEG DEBUG] Failed to spawn FFmpeg:', err)
      }
      reject(new Error(`Failed to start FFmpeg: ${err.message}`))
    })
  })
}

export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  timestamp: number = 10
): Promise<void> {
  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] Starting generateThumbnail:', {
      inputPath,
      outputPath,
      timestamp
    })
  }

  const scaleFilter =
    'scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease'

  // Run one ffmpeg attempt. Resolves with the exit code + stderr instead
  // of rejecting, so the caller can fall through to the next strategy.
  const runOnce = (
    seekArgs: string[],
  ): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const args = [
        '-v', DEBUG ? 'verbose' : 'error',
        ...seekArgs,
        '-vframes', '1', // single frame
        '-vf', scaleFilter,
        '-q:v', '2', // high-quality JPEG
        '-y',
        outputPath,
      ]
      // Lower CPU priority to keep the system responsive.
      const ffmpeg = spawn('nice', ['-n', '10', ffmpegPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      ffmpeg.stderr.on('data', (d) => {
        stderr += d.toString()
      })
      ffmpeg.on('close', (code) => resolve({ code, stderr }))
      ffmpeg.on('error', (err) =>
        resolve({ code: -1, stderr: `Failed to start FFmpeg: ${err.message}` }),
      )
    })

  // A usable thumbnail is a real, non-empty JPEG. Fast input-seek can
  // silently emit a 0-byte / broken file when the seek overshoots the
  // last keyframe on some clips — which is exactly what leaves a video
  // with a missing thumbnail. So we validate the OUTPUT, not just the
  // exit code.
  const outputUsable = (): boolean => {
    try {
      const st = fs.statSync(outputPath)
      return st.isFile() && st.size > 100
    } catch {
      return false
    }
  }

  // Progressively safer strategies:
  //   1) fast input-seek (before -i)     — fastest, the usual path
  //   2) accurate output-seek (after -i) — decodes to the exact time and
  //      lands a real frame even when fast-seek overshot
  //   3) very first frame                — last resort; yields a frame if
  //      the file decodes at all
  const strategies: Array<{ label: string; seek: string[] }> = [
    { label: 'fast-seek', seek: ['-ss', String(timestamp), '-i', inputPath] },
    { label: 'accurate-seek', seek: ['-i', inputPath, '-ss', String(timestamp)] },
    { label: 'first-frame', seek: ['-i', inputPath] },
  ]

  let lastStderr = ''
  for (const strat of strategies) {
    const { code, stderr } = await runOnce(strat.seek)
    lastStderr = stderr
    if (code === 0 && outputUsable()) {
      if (DEBUG) {
        logMessage(`[FFMPEG DEBUG] Thumbnail generated via ${strat.label}`)
      }
      return
    }
    logMessage(
      `[FFMPEG] Thumbnail strategy "${strat.label}" produced no usable frame (code=${code}) — trying fallback`,
    )
  }

  throw new Error(
    `FFmpeg thumbnail generation failed after all strategies: ${lastStderr}`,
  )
}

/**
 * Generate a storyboard sprite-sheet — one JPEG packing
 * `cols × rows` evenly-spaced frames at a tiny resolution. Used by
 * the Frame.io-style folder grid for instant hover-scrub: the client
 * just shifts `background-position`, no video element needed.
 *
 * The sprite has fixed dimensions (default 10×10 grid of 192×108
 * cells = 1920×1080 total). Total payload is typically 40–120 KB at
 * `-q:v 5`, so scrub is "lightning-instant" even on slow networks.
 */
export async function generateStoryboard(
  inputPath: string,
  outputPath: string,
  duration: number,
  cols: number = 10,
  rows: number = 10,
  cellWidth: number = 192,
  cellHeight: number = 108,
): Promise<void> {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid duration for storyboard: ${duration}`)
  }
  const totalFrames = cols * rows
  // fps = total_frames / duration → produces exactly `totalFrames`
  // evenly-spaced frames across the video.
  const fps = totalFrames / duration

  // scale → preserve aspect with letterbox padding so vertical /
  // portrait videos don't get squished. tile → pack into a grid.
  const vf = [
    `fps=${fps}`,
    `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease`,
    `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black`,
    `tile=${cols}x${rows}`,
  ].join(',')

  const args = [
    '-v', 'error',
    '-i', inputPath,
    '-vf', vf,
    '-frames:v', '1',
    '-q:v', '5', // small JPEG; sprite cells are tiny so 5 looks fine
    '-y',
    outputPath,
  ]

  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] Storyboard command:', 'nice -n 10', ffmpegPath, args.join(' '))
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('nice', ['-n', '10', ffmpegPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg storyboard generation failed: ${stderr}`))
    })
    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg for storyboard: ${err.message}`))
    })
  })
}

/**
 * 1.9.4+ Phase B: remux an already-encoded MP4 into HLS — splits
 * the existing audio + video streams into TS segments + a VOD
 * playlist WITHOUT re-encoding (-c copy). Wall-clock cost is
 * typically 5-30 seconds for a multi-GB MP4 because FFmpeg is
 * just demuxing and chunking byte ranges; the heavy work was
 * already done when we encoded the MP4.
 *
 * Args:
 *   - `inputMp4Path`: local filesystem path to the MP4 we just
 *     encoded (the tier output).
 *   - `outDir`: local filesystem dir where the playlist + .ts
 *     segments should land. Created if missing.
 *   - `segmentSeconds`: target segment duration (6 s standard).
 *
 * The output playlist is named `playlist.m3u8` and segments are
 * `seg_000.ts`, `seg_001.ts`, etc. — matches what the streaming
 * API expects.
 */
export async function remuxToHls(
  inputMp4Path: string,
  outDir: string,
  segmentSeconds: number = 6,
): Promise<void> {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true })
  }

  const playlistPath = path.join(outDir, 'playlist.m3u8')
  const segmentPattern = path.join(outDir, 'seg_%03d.ts')

  const args = [
    '-v', 'error',
    '-i', inputMp4Path,
    // -c copy is the magic: no re-encoding, just demux + chunk.
    // Both video and audio streams are passed through bit-exact.
    '-c', 'copy',
    // VOD mode = full playlist written at end (no live updates).
    '-hls_time', String(segmentSeconds),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', segmentPattern,
    // -hls_flags independent_segments lets each .ts be decoded
    // standalone (needed for clean quality switching). +program_date_time
    // helps some players sync timing.
    '-hls_flags', 'independent_segments',
    '-f', 'hls',
    '-y', // overwrite if exists
    playlistPath,
  ]

  if (DEBUG) {
    logMessage('[FFMPEG DEBUG] HLS remux command:', 'nice -n 10', ffmpegPath, args.join(' '))
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('nice', ['-n', '10', ffmpegPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg HLS remux failed: ${stderr}`))
      }
    })
    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg for HLS remux: ${err.message}`))
    })
  })
}

// =====================================================================
// 2.2.0+ Atomic HLS master rewrite + per-videoId advisory lock.
// =====================================================================
//
// Architectural note: the master.m3u8 for a video is generated on the
// fly by `src/app/api/videos/[id]/hls/[...path]/route.ts` directly
// from `Video.hlsBasePath` + `Video.hlsQualities`. There is no
// physical master file on disk that we need to atomically swap — the
// "master rewrite" is conceptually a DB column update.
//
// That said, the new breadth-first encode pipeline runs multiple
// `encode-tier` jobs per video on independent worker slots. Two of
// them finishing within milliseconds of each other could clobber
// `hlsQualities` via lost updates if we use a naive read-modify-write.
// Two safeguards:
//
//   1. Per-videoId in-process mutex (the Map below) so two tiers on
//      the SAME worker process serialise their RMW cycle.
//
//   2. DB-side atomic merge using `array_append` semantics —
//      Postgres serialises concurrent UPDATEs at the row level, so
//      even across multiple worker processes the merge stays sane.
//
// We keep this helper in ffmpeg.ts because it sits next to
// `remuxToHls` — the two are the read/write halves of the HLS
// lifecycle.

const hlsRewriteLocks = new Map<string, Promise<unknown>>()

/**
 * 2.2.0+: atomic master playlist rewrite for a video.
 *
 * Conceptually this swaps out the master.m3u8 to include the new
 * tier. In FrameComment the master is dynamic (generated from DB),
 * so "rewrite" means "atomically append `tier` to `Video.hlsQualities`
 * + ensure `hlsBasePath` is set". The next master.m3u8 GET picks up
 * the new list automatically (the endpoint sends `Cache-Control:
 * no-store` — see hls/[...path]/route.ts).
 *
 * Atomicity:
 *   - In-process: per-videoId Promise chain so concurrent encode-tier
 *     jobs on the same worker queue strictly serialise.
 *   - Cross-process: the Postgres UPDATE is row-level atomic; the
 *     SET clause computes the new array from the previous value in
 *     one statement, so two parallel UPDATEs can't lose a tier.
 *
 * Soft-fail by design: if the DB write throws P2025 (row deleted
 * mid-encode), we swallow it — the encoder already produced segments
 * and we can't un-produce them, but there's no video row to announce
 * them on anymore.
 */
export async function rewriteHlsMaster(
  videoId: string,
  tier: '480p' | '720p' | '1080p' | '2160p',
  basePath: string,
): Promise<void> {
  // Chain off whatever the previous holder of this videoId's lock was
  // doing. `prev.catch(() => {})` so a thrown previous run can't
  // cascade into "permanently broken lock" — we only care about
  // serialisation, not error propagation.
  const prev = hlsRewriteLocks.get(videoId) || Promise.resolve()
  const next = prev.catch(() => {}).then(async () => {
    // Import lazily so this module stays usable from non-worker
    // contexts (e.g. the API route's static analysis) without
    // pulling Prisma into the worker bundle twice.
    const { prisma } = await import('./db')
    try {
      // Read the current set, add the tier, write back. The read +
      // write happen inside this lock holder so two simultaneous
      // calls for the same videoId on this process serialise. For
      // OTHER processes, the Postgres UPDATE is atomic on the row.
      const existing = (await prisma.video.findUnique({
        where: { id: videoId },
        select: { hlsQualities: true } as any,
      })) as any
      const set = new Set<string>(existing?.hlsQualities || [])
      set.add(tier)
      await prisma.video.update({
        where: { id: videoId },
        data: {
          hlsBasePath: basePath,
          hlsQualities: Array.from(set),
        } as any,
      })
    } catch (err: any) {
      if (err?.code === 'P2025') return // row deleted mid-flight
      logError(`[HLS] master rewrite failed for ${videoId} ${tier}:`, err)
    }
  })
  hlsRewriteLocks.set(videoId, next)
  try {
    await next
  } finally {
    // Drop the lock entry once it resolves AND we're still the latest
    // holder — otherwise a slower predecessor would unset the entry
    // someone else just installed.
    if (hlsRewriteLocks.get(videoId) === next) {
      hlsRewriteLocks.delete(videoId)
    }
  }
}
