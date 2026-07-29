import { Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import PDFDocument from 'pdfkit'
import { CreateTranscriptJob } from '../lib/queue'
import { prisma } from '../lib/db'
import { logMessage, logError } from '../lib/logging'
import { downloadFile, getLocalSourcePath, uploadFile } from '../lib/storage'
import { getVideoBackend } from '../lib/storage-backends'
import {
  extractAudioForTranscription,
  sliceAudioForTranscription,
  probeMediaDurationSeconds,
} from '../lib/ffmpeg'
import { getOpenAiApiKey } from '../lib/settings'
import { TEMP_DIR } from './cleanup'

// OpenAI hard-limits a transcription request to 25 MB. We downmix to
// mono 16 kHz MP3 (~0.5 MB/min), so a single request covers roughly the
// first ~50 min. Longer clips are split into sub-limit chunks and
// stitched back together (see the chunked path below).
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
// Target size per chunk when we have to split. Kept well under the hard
// limit so MP3 frame overhead / VBR wobble can never push a chunk over.
const CHUNK_TARGET_BYTES = 20 * 1024 * 1024

type WhisperSegment = { start: number; end: number; text: string }

/**
 * POST one audio buffer to OpenAI whisper-1 (verbose_json for per-segment
 * timecodes) and return the parsed segments + full text. Timecodes are
 * relative to the START of THIS buffer — the caller offsets them when the
 * buffer is a chunk of a longer clip.
 */
async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  apiKey: string,
): Promise<{ segments: WhisperSegment[]; fullText: string }> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(audioBuffer)], { type: 'audio/mpeg' }),
    'audio.mp3',
  )
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`OpenAI transcription failed (${resp.status}): ${body.slice(0, 300)}`)
  }
  const data: any = await resp.json()
  const segments: WhisperSegment[] = Array.isArray(data?.segments)
    ? data.segments
        .filter((s: any) => typeof s?.text === 'string')
        .map((s: any) => ({
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: String(s.text).trim(),
        }))
    : []
  const fullText: string = typeof data?.text === 'string' ? data.text.trim() : ''
  return { segments, fullText }
}

/** Seconds → `MM:SS` (or `HH:MM:SS` past the hour). */
function fmtTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/**
 * 3.9.x: transcribe one video with OpenAI whisper-1 and drop a timecoded
 * PDF into the video's folder as a FolderDocument.
 *
 * Pipeline: resolve the source file (local STORAGE_ROOT or download) →
 * ffmpeg extract a compact mono MP3 → POST to OpenAI → render a PDF with
 * pdfkit (auto-wrapped + paginated) → upload it → create the
 * FolderDocument row so it shows as a file card in the folder.
 */
export async function processCreateTranscript(job: Job<CreateTranscriptJob>) {
  const { videoId, projectId, folderId, originalStoragePath } = job.data
  const start = Date.now()
  logMessage(`[WORKER] create-transcript for ${videoId}`)

  // Temp files we create and must clean up (audio; the source original
  // is left for the temp sweeper / other jobs, same as regenerate-thumb).
  const audioPath = path.join(TEMP_DIR, `${videoId}-transcript-audio.mp3`)
  // Any per-chunk audio slices we create for long clips (cleaned up below).
  const chunkPaths: string[] = []

  try {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        name: true,
        version: true,
        versionLabel: true,
        // 3.9.x: prefer a small preview tier as the audio SOURCE — see
        // the note below. Reading a ~50 MB 480p preview instead of a
        // multi-GB original is ~50× less disk I/O, which is what made
        // audio extraction time out on slow HDDs (esp. during a ZFS
        // scrub) for long clips.
        preview480Path: true,
        preview720Path: true,
        preview1080Path: true,
        preview2160Path: true,
      },
    })
    if (!video) {
      logMessage(`[WORKER] create-transcript ${videoId}: row gone, skipping`)
      return
    }

    const apiKey = await getOpenAiApiKey()
    if (!apiKey) {
      throw new Error('No OpenAI API key configured (Settings → Video Processing).')
    }

    // Pick the audio source. Whisper only needs the speech, so we read
    // from the SMALLEST available encoded preview (they all carry the
    // same audio track) and only fall back to the big original when no
    // preview exists (e.g. skip-transcoding uploads). This is the fix
    // for "Extracting audio" failing/timing out on huge files: a 2.6 GB
    // 36-min original becomes a ~50 MB 480p read.
    const v = video as any
    const audioSourceStoragePath: string =
      v.preview480Path ||
      v.preview720Path ||
      v.preview1080Path ||
      v.preview2160Path ||
      originalStoragePath

    // Resolve the source file — prefer reading directly from
    // STORAGE_ROOT (local mode); fall back to downloading (S3 mode),
    // mirroring the regenerate-thumbnail processor.
    // 4.2.0+: the audio source (preview or original) and the PDF we write both
    // live on the video's own storage backend.
    const backend = await getVideoBackend(videoId)

    let sourcePath: string
    const localSource = getLocalSourcePath(audioSourceStoragePath, backend)
    if (localSource) {
      sourcePath = localSource
    } else {
      const cachedOriginal = path.join(TEMP_DIR, `${videoId}-transcript-src`)
      if (!fs.existsSync(cachedOriginal)) {
        const stream = await downloadFile(audioSourceStoragePath, backend)
        await pipeline(stream, fs.createWriteStream(cachedOriginal))
      }
      sourcePath = cachedOriginal
    }
    logMessage(
      `[WORKER] create-transcript ${videoId}: audio source = ${audioSourceStoragePath === originalStoragePath ? 'original' : 'preview'}`,
    )

    // 1) Extract compact audio.
    await job.updateProgress({ stage: 'audio' }).catch(() => {})
    await extractAudioForTranscription(sourcePath, audioPath)
    const audioBuffer = await fs.promises.readFile(audioPath)

    // 2) Transcribe. OpenAI rejects a single request over ~25 MB, which a
    //    mono 16 kHz 64 kbps stream hits at roughly ~50 min. For anything
    //    over the limit we split the audio into sub-limit chunks, transcribe
    //    each, offset its timecodes by the chunk's start time, and stitch
    //    the segments + text back together. Short clips take the
    //    single-request fast path unchanged.
    let segments: WhisperSegment[] = []
    let fullText = ''

    if (audioBuffer.length <= MAX_AUDIO_BYTES) {
      // Fast path — one request. Two banner steps: "Sending" (the small
      // upload) then "Waiting for OpenAI" (the transcription itself).
      await job.updateProgress({ stage: 'sending' }).catch(() => {})
      const waitingTimer = setTimeout(() => {
        void job.updateProgress({ stage: 'waiting' }).catch(() => {})
      }, 2000)
      try {
        const r = await transcribeAudioBuffer(audioBuffer, apiKey)
        segments = r.segments
        fullText = r.fullText
      } finally {
        clearTimeout(waitingTimer)
      }
    } else {
      // Chunked path. Split by duration into N pieces whose encoded size
      // lands comfortably under the limit, then transcribe each.
      const totalDuration = await probeMediaDurationSeconds(audioPath)
      const chunkCount = Math.ceil(audioBuffer.length / CHUNK_TARGET_BYTES)
      const chunkDuration = Math.ceil(totalDuration / chunkCount)
      logMessage(
        `[WORKER] create-transcript ${videoId}: audio ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB over ${(MAX_AUDIO_BYTES / 1024 / 1024).toFixed(0)} MB limit → splitting into ${chunkCount} chunks of ~${chunkDuration}s`,
      )
      const textParts: string[] = []
      for (let i = 0; i < chunkCount; i++) {
        const startSec = i * chunkDuration
        if (startSec >= totalDuration) break
        const chunkPath = path.join(TEMP_DIR, `${videoId}-transcript-audio-${i}.mp3`)
        chunkPaths.push(chunkPath)
        await sliceAudioForTranscription(audioPath, chunkPath, startSec, chunkDuration)
        const chunkBuffer = await fs.promises.readFile(chunkPath)
        // Reflect chunk progress in the banner: "Waiting for OpenAI…" is
        // the honest label for the bulk of each chunk's time.
        await job
          .updateProgress({ stage: 'waiting', chunk: i + 1, chunks: chunkCount })
          .catch(() => {})
        const r = await transcribeAudioBuffer(chunkBuffer, apiKey)
        for (const s of r.segments) {
          segments.push({ start: s.start + startSec, end: s.end + startSec, text: s.text })
        }
        if (r.fullText) textParts.push(r.fullText)
      }
      fullText = textParts.join(' ').trim()
    }

    if (segments.length === 0 && !fullText) {
      throw new Error('Transcription returned no text (silent or undecodable audio).')
    }

    const versionLabel = video.versionLabel || `v${video.version}`

    // 3) Render the PDF (pdfkit auto-wraps + paginates).
    await job.updateProgress({ stage: 'pdf' }).catch(() => {})
    const pdfBuffer = await renderTranscriptPdf({
      title: video.name,
      versionLabel,
      generatedAt: new Date(),
      segments,
      fullText,
    })

    // 4) Upload it into the project's documents area.
    await job.updateProgress({ stage: 'saving' }).catch(() => {})
    const storagePath = `projects/${projectId}/documents/transcript-${videoId}-${Date.now()}.pdf`
    await uploadFile(storagePath, pdfBuffer, pdfBuffer.length, 'application/pdf', backend)

    // 5) Create the FolderDocument row so it appears as a file card in
    //    the same folder as the video. `prisma as any` because the
    //    sandbox's generated client may predate the model; the Docker
    //    build regenerates it so this is a real typed model at runtime.
    const docName = `${video.name} ${versionLabel} — Transcript.pdf`
    await (prisma as any).folderDocument.create({
      data: {
        projectId,
        folderId: folderId ?? null,
        name: docName,
        storagePath,
        mimeType: 'application/pdf',
        size: BigInt(pdfBuffer.length),
        kind: 'transcript',
        sourceVideoId: videoId,
        storageBackend: backend,
      },
    })

    // Let any listening UI know a folder changed so grids refresh.
    logMessage(
      `[WORKER] create-transcript for ${videoId} done in ${((Date.now() - start) / 1000).toFixed(2)}s (${segments.length} segments)`,
    )
  } catch (err) {
    logError(`[WORKER] create-transcript for ${videoId} failed:`, err)
    throw err
  } finally {
    // Drop the temp audio + any chunk slices; leave the cached original
    // for the sweeper.
    try {
      if (fs.existsSync(audioPath)) await fs.promises.unlink(audioPath)
    } catch {
      /* ignore */
    }
    for (const p of chunkPaths) {
      try {
        if (fs.existsSync(p)) await fs.promises.unlink(p)
      } catch {
        /* ignore */
      }
    }
  }
}

function renderTranscriptPdf(opts: {
  title: string
  versionLabel: string
  generatedAt: Date
  segments: WhisperSegment[]
  fullText: string
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 56, size: 'A4' })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Header.
      doc.fontSize(16).fillColor('#111111').text(opts.title, { continued: false })
      doc
        .moveDown(0.2)
        .fontSize(10)
        .fillColor('#666666')
        .text(
          `Transcript · ${opts.versionLabel} · generated ${opts.generatedAt.toLocaleString()}`,
        )
      doc
        .moveDown(0.6)
        .strokeColor('#dddddd')
        .lineWidth(1)
        .moveTo(doc.x, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke()
      doc.moveDown(0.8)

      if (opts.segments.length > 0) {
        for (const seg of opts.segments) {
          if (!seg.text) continue
          doc
            .fontSize(9)
            .fillColor('#2f7bd6')
            .text(`[${fmtTimecode(seg.start)} – ${fmtTimecode(seg.end)}]`)
          doc.fontSize(11).fillColor('#111111').text(seg.text, {
            paragraphGap: 2,
            lineGap: 1,
          })
          doc.moveDown(0.5)
        }
      } else {
        // No per-segment timecodes — dump the full text.
        doc.fontSize(11).fillColor('#111111').text(opts.fullText, { lineGap: 1 })
      }

      doc.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
